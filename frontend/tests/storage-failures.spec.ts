import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import ts from "typescript";
import {
  StorageError,
  openDatabase,
  closeDatabase,
  DB_NAME,
  STORAGE_STORES,
  generateTestKey,
  importRawKey,
  unlockOwner,
  lockOwner,
  advanceHlc,
  canonicalizeJson,
  sha256Hex,
  computeCanonicalHash,
  persistOperationAtomic,
  createLocalStorageGateway,
  encryptPayload,
  decryptPayload,
  createAad,
  type OwnerAccessContext,
  type OperationEnvelope,
  type OutboxEntry,
  type PersistOperationInput,
  type LocalStorageGateway,
} from "../lib/storage";

declare global {
  interface Window {
    __dayforge_storage_failures: {
      StorageError: typeof StorageError;
      DB_NAME: typeof DB_NAME;
      STORAGE_STORES: typeof STORAGE_STORES;
      openDatabase: typeof openDatabase;
      closeDatabase: typeof closeDatabase;
      generateTestKey: typeof generateTestKey;
      importRawKey: typeof importRawKey;
      unlockOwner: typeof unlockOwner;
      lockOwner: typeof lockOwner;
      advanceHlc: typeof advanceHlc;
      canonicalizeJson: typeof canonicalizeJson;
      sha256Hex: typeof sha256Hex;
      computeCanonicalHash: typeof computeCanonicalHash;
      persistOperationAtomic: typeof persistOperationAtomic;
      createLocalStorageGateway: typeof createLocalStorageGateway;
      encryptPayload: typeof encryptPayload;
      decryptPayload: typeof decryptPayload;
      createAad: typeof createAad;
    };
  }
}

function buildStorageScript(): string {
  const libDir = path.resolve(__dirname, "../lib/storage");
  const files = [
    "errors.ts",
    "schema.ts",
    "migration.ts",
    "db.ts",
    "crypto.ts",
    "owner-gate.ts",
    "clock-state.ts",
    "outbox.ts",
    "unit-of-work.ts",
    "repositories.ts",
    "view-preferences.ts",
  ];

  const combined = files
    .filter((file) => fs.existsSync(path.join(libDir, file)))
    .map((file) => fs.readFileSync(path.join(libDir, file), "utf-8"))
    .join("\n")
    .replace(/import\s+[\s\S]*?from\s+['"][^'"]+['"];?/g, "")
    .replace(/import\s+.*?;/g, "");

  const transpiled = ts.transpileModule(combined, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
    },
  }).outputText;

  return `(() => {
    const exports = {};
    const module = { exports };
    ${transpiled}
    window.__dayforge_storage_failures = exports;
  })();`;
}

test.describe("Storage Failures, Security Invariants & Scale Specifications", () => {
  const scriptContent = buildStorageScript();

  test.beforeEach(async ({ page }) => {
    await page.addInitScript({ content: scriptContent });
    await page.goto("/account");
  });

  test.describe("ST-11: QuotaExceededError Failure Injection", () => {
    test("simulated quota exceeded returns typed quota_exceeded error and leaves stores clean", async ({
      page,
    }) => {
      const testDbName = `st11_quota_${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-st11-1";
      const deviceId = "22222222-2222-4222-8222-222222222222";
      const opId = "33333333-3333-4333-8333-333333333333";
      const calId = "44444444-4444-4444-8444-444444444444";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, opId, calId }) => {
          const {
            openDatabase,
            closeDatabase,
            generateTestKey,
            unlockOwner,
            createLocalStorageGateway,
            advanceHlc,
            STORAGE_STORES,
          } = window.__dayforge_storage_failures;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false, error: openRes.error.code };
          const db = openRes.value;

          const key = await generateTestKey();
          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { step: "unlock", ok: false, error: unlockRes.error.code };
          }
          const ctx = unlockRes.value;

          const gateway = createLocalStorageGateway({ name: testDbName });
          const editTime = advanceHlc(null, 1793150000000, calId, "calibrated");

          const operationInput = {
            context: ctx,
            deviceId,
            operationId: opId,
            commands: [{ root: { kind: "plan", id: "p1" }, action: "plan.create", payload: { name: "Pending Plan" } }],
            dependencies: [],
            editTime,
            recordOverlays: [{ kind: "plan", id: "p1", payload: { name: "Pending Plan" } }],
          };

          // 1. First attempt with simulated quota exceeded
          const failedRes = await gateway.persistOperation({
            ...operationInput,
            _simulateQuotaExceeded: true,
          });

          // 2. Inspect stores directly to verify zero partial commit
          const tx = db.transaction([STORAGE_STORES.operations, STORAGE_STORES.records], "readonly");
          const opCountReq = tx.objectStore(STORAGE_STORES.operations).count();
          const recCountReq = tx.objectStore(STORAGE_STORES.records).count();

          const [opCount, recCount] = await new Promise<[number, number]>((resolve) => {
            tx.oncomplete = () => resolve([opCountReq.result, recCountReq.result]);
          });

          // 3. Retry with original in-memory data (uncommitted data safely retained)
          const retryRes = await gateway.persistOperation(operationInput);

          // 4. Inspect after retry
          const tx2 = db.transaction([STORAGE_STORES.operations, STORAGE_STORES.records], "readonly");
          const opCountReq2 = tx2.objectStore(STORAGE_STORES.operations).count();
          const recCountReq2 = tx2.objectStore(STORAGE_STORES.records).count();

          const [opCount2, recCount2] = await new Promise<[number, number]>((resolve) => {
            tx2.oncomplete = () => resolve([opCountReq2.result, recCountReq2.result]);
          });

          closeDatabase(db);
          gateway.close();

          return {
            failedOk: failedRes.ok,
            failedErrorCode: failedRes.ok ? null : failedRes.error.code,
            initialOpCount: opCount,
            initialRecCount: recCount,
            retryOk: retryRes.ok,
            retryOpCount: opCount2,
            retryRecCount: recCount2,
          };
        },
        { testDbName, ownerId, keyId, deviceId, opId, calId }
      );

      expect(result.failedOk).toBe(false);
      expect(result.failedErrorCode).toBe("quota_exceeded");
      expect(result.initialOpCount).toBe(0);
      expect(result.initialRecCount).toBe(0);
      expect(result.retryOk).toBe(true);
      expect(result.retryOpCount).toBe(1);
      expect(result.retryRecCount).toBe(1);
    });

    test("DOMException QuotaExceededError during IDBObjectStore put triggers quota_exceeded without partial commits", async ({
      page,
    }) => {
      const testDbName = `st11_dom_quota_${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-st11-2";
      const deviceId = "22222222-2222-4222-8222-222222222222";
      const opId = "33333333-3333-4333-8333-333333333333";
      const calId = "44444444-4444-4444-8444-444444444444";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, opId, calId }) => {
          const {
            openDatabase,
            closeDatabase,
            generateTestKey,
            unlockOwner,
            createLocalStorageGateway,
            advanceHlc,
            STORAGE_STORES,
          } = window.__dayforge_storage_failures;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false, error: openRes.error.code };
          const db = openRes.value;

          const key = await generateTestKey();
          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { step: "unlock", ok: false, error: unlockRes.error.code };
          }
          const ctx = unlockRes.value;

          const gateway = createLocalStorageGateway({ name: testDbName });
          const editTime = advanceHlc(null, 1793150000000, calId, "calibrated");

          const originalPut = IDBObjectStore.prototype.put;
          let putIntercepted = false;

          // Monkeypatch put to simulate browser throwing QuotaExceededError
          IDBObjectStore.prototype.put = function (...args: unknown[]) {
            if (this.name === STORAGE_STORES.operations) {
              putIntercepted = true;
              throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
            }
            return (originalPut as (...a: unknown[]) => IDBRequest).apply(this, args);
          };

          let persistRes;
          try {
            persistRes = await gateway.persistOperation({
              context: ctx,
              deviceId,
              operationId: opId,
              commands: [{ root: { kind: "plan", id: "p2" }, action: "plan.create", payload: { name: "Quota Plan" } }],
              dependencies: [],
              editTime,
              recordOverlays: [{ kind: "plan", id: "p2", payload: { name: "Quota Plan" } }],
            });
          } finally {
            IDBObjectStore.prototype.put = originalPut;
          }

          // Verify zero partial commits in DB
          const tx = db.transaction([STORAGE_STORES.operations, STORAGE_STORES.records], "readonly");
          const opCountReq = tx.objectStore(STORAGE_STORES.operations).count();
          const recCountReq = tx.objectStore(STORAGE_STORES.records).count();

          const [opCount, recCount] = await new Promise<[number, number]>((resolve) => {
            tx.oncomplete = () => resolve([opCountReq.result, recCountReq.result]);
          });

          closeDatabase(db);
          gateway.close();

          return {
            putIntercepted,
            persistOk: persistRes.ok,
            errorCode: persistRes.ok ? null : persistRes.error.code,
            opCount,
            recCount,
          };
        },
        { testDbName, ownerId, keyId, deviceId, opId, calId }
      );

      expect(result.putIntercepted).toBe(true);
      expect(result.persistOk).toBe(false);
      expect(result.errorCode).toBe("quota_exceeded");
      expect(result.opCount).toBe(0);
      expect(result.recCount).toBe(0);
    });
  });

  test.describe("ST-12: IndexedDB Unavailable / Restricted Mode", () => {
    test("openDatabase and gateway return typed unavailable when indexedDB throws SecurityError", async ({
      page,
    }) => {
      const testDbName = `st12_restricted_${Date.now()}`;

      const result = await page.evaluate(async ({ testDbName }) => {
        const { openDatabase, createLocalStorageGateway } = window.__dayforge_storage_failures;

        const originalOpen = indexedDB.open;

        // Simulate private mode / restricted permissions throwing SecurityError
        indexedDB.open = function () {
          throw new DOMException("Access to IndexedDB is denied in restricted mode", "SecurityError");
        };

        try {
          const openRes = await openDatabase({ name: testDbName });
          const gateway = createLocalStorageGateway({ name: testDbName });
          const gwOpenRes = await gateway.open();

          return {
            openOk: openRes.ok,
            openErrorCode: openRes.ok ? null : openRes.error.code,
            openErrorMsg: openRes.ok ? null : openRes.error.message,
            gwOpenOk: gwOpenRes.ok,
            gwOpenErrorCode: gwOpenRes.ok ? null : gwOpenRes.error.code,
          };
        } finally {
          indexedDB.open = originalOpen;
        }
      }, { testDbName });

      expect(result.openOk).toBe(false);
      expect(result.openErrorCode).toBe("unavailable");
      expect(result.openErrorMsg).toContain("restricted");
      expect(result.gwOpenOk).toBe(false);
      expect(result.gwOpenErrorCode).toBe("unavailable");
    });

    test("persistOperation safely returns unavailable without crashing or claiming saved", async ({
      page,
    }) => {
      const testDbName = `st12_persist_unavailable_${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-st12";
      const deviceId = "22222222-2222-4222-8222-222222222222";
      const opId = "33333333-3333-4333-8333-333333333333";
      const calId = "44444444-4444-4444-8444-444444444444";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, opId, calId }) => {
          const {
            createLocalStorageGateway,
            generateTestKey,
            advanceHlc,
          } = window.__dayforge_storage_failures;

          const key = await generateTestKey();
          const mockCtx = {
            ownerId,
            keyId,
            key,
            unlockedAt: new Date().toISOString(),
            lockEpoch: 1,
          };

          const gateway = createLocalStorageGateway({ name: testDbName });
          const editTime = advanceHlc(null, 1793150000000, calId, "calibrated");

          const originalOpen = indexedDB.open;
          indexedDB.open = function () {
            throw new DOMException("Operation not allowed", "SecurityError");
          };

          try {
            const persistRes = await gateway.persistOperation({
              context: mockCtx,
              deviceId,
              operationId: opId,
              commands: [{ root: { kind: "plan", id: "p1" }, action: "plan.create", payload: {} }],
              dependencies: [],
              editTime,
            });

            return {
              persistOk: persistRes.ok,
              errorCode: persistRes.ok ? null : persistRes.error.code,
            };
          } finally {
            indexedDB.open = originalOpen;
          }
        },
        { testDbName, ownerId, keyId, deviceId, opId, calId }
      );

      expect(result.persistOk).toBe(false);
      expect(result.errorCode).toBe("unavailable");
    });
  });

  test.describe("Transaction AbortError Simulation", () => {
    test("explicit transaction abort returns transaction_aborted with zero partial commits", async ({
      page,
    }) => {
      const testDbName = `st_abort_${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-abort-1";
      const deviceId = "22222222-2222-4222-8222-222222222222";
      const opId = "33333333-3333-4333-8333-333333333333";
      const calId = "44444444-4444-4444-8444-444444444444";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, opId, calId }) => {
          const {
            openDatabase,
            closeDatabase,
            generateTestKey,
            unlockOwner,
            createLocalStorageGateway,
            advanceHlc,
            STORAGE_STORES,
          } = window.__dayforge_storage_failures;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false, error: openRes.error.code };
          const db = openRes.value;

          const key = await generateTestKey();
          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { step: "unlock", ok: false, error: unlockRes.error.code };
          }
          const ctx = unlockRes.value;

          const gateway = createLocalStorageGateway({ name: testDbName });
          const editTime = advanceHlc(null, 1793150000000, calId, "calibrated");

          // Persist with _abortForTest
          const persistRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: opId,
            commands: [{ root: { kind: "plan", id: "p1" }, action: "plan.create", payload: {} }],
            dependencies: [],
            editTime,
            recordOverlays: [{ kind: "plan", id: "p1", payload: { name: "Aborted Plan" } }],
            _abortForTest: true,
          });

          // Verify zero partial commits in operations, records, device_meta
          const tx = db.transaction(
            [STORAGE_STORES.operations, STORAGE_STORES.records, STORAGE_STORES.device_meta],
            "readonly"
          );
          const opCountReq = tx.objectStore(STORAGE_STORES.operations).count();
          const recCountReq = tx.objectStore(STORAGE_STORES.records).count();
          const devReq = tx.objectStore(STORAGE_STORES.device_meta).get([ownerId, deviceId]);

          const [opCount, recCount, devMeta] = await new Promise<[number, number, unknown]>((resolve) => {
            tx.oncomplete = () => resolve([opCountReq.result, recCountReq.result, devReq.result]);
          });

          closeDatabase(db);
          gateway.close();

          return {
            persistOk: persistRes.ok,
            errorCode: persistRes.ok ? null : persistRes.error.code,
            opCount,
            recCount,
            devMetaExists: devMeta !== undefined,
          };
        },
        { testDbName, ownerId, keyId, deviceId, opId, calId }
      );

      expect(result.persistOk).toBe(false);
      expect(result.errorCode).toBe("transaction_aborted");
      expect(result.opCount).toBe(0);
      expect(result.recCount).toBe(0);
      expect(result.devMetaExists).toBe(false);
    });
  });

  test.describe("Ciphertext & Metadata Corruption Handling", () => {
    test("tampered ciphertext and wrong key strictly fail with integrity_failed", async ({
      page,
    }) => {
      const testDbName = `st_corruption_${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-corr-1";
      const deviceId = "22222222-2222-4222-8222-222222222222";
      const opId = "33333333-3333-4333-8333-333333333333";
      const calId = "44444444-4444-4444-8444-444444444444";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, opId, calId }) => {
          const {
            openDatabase,
            closeDatabase,
            generateTestKey,
            unlockOwner,
            createLocalStorageGateway,
            advanceHlc,
            decryptPayload,
            STORAGE_STORES,
          } = window.__dayforge_storage_failures;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false, error: openRes.error.code };
          const db = openRes.value;

          const key1 = await generateTestKey();
          const unlockRes = await unlockOwner(db, ownerId, keyId, key1);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { step: "unlock", ok: false, error: unlockRes.error.code };
          }
          const ctx = unlockRes.value;

          const gateway = createLocalStorageGateway({ name: testDbName });
          const editTime = advanceHlc(null, 1793150000000, calId, "calibrated");

          // Persist a valid operation and overlay
          const persistRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: opId,
            commands: [{ root: { kind: "plan", id: "p1" }, action: "plan.create", payload: { secret: "abc" } }],
            dependencies: [],
            editTime,
            recordOverlays: [{ kind: "plan", id: "p1", payload: { secret: "abc" } }],
          });
          if (!persistRes.ok) {
            closeDatabase(db);
            gateway.close();
            return { step: "persist", ok: false, error: persistRes.error.code };
          }

          // Read back normally to verify initial integrity
          const initialRead = await gateway.getRecord(ctx, "plan", "p1");
          const initialList = await gateway.listPending(ctx);

          // 1. Corrupt record overlay ciphertext in storage directly
          const txCorrupt = db.transaction([STORAGE_STORES.records, STORAGE_STORES.operations], "readwrite");
          const recStore = txCorrupt.objectStore(STORAGE_STORES.records);
          const opStore = txCorrupt.objectStore(STORAGE_STORES.operations);

          const getRecReq = recStore.get([ownerId, "plan", "p1"]);
          const getOpReq = opStore.get([ownerId, opId]);

          await new Promise<void>((resolve) => {
            getRecReq.onsuccess = () => {
              const rec = getRecReq.result;
              // Flip first byte of ciphertext
              rec.ciphertext[0] ^= 0xff;
              recStore.put(rec);
            };
            getOpReq.onsuccess = () => {
              const op = getOpReq.result;
              // Flip first byte of outbox encrypted envelope ciphertext
              op.encrypted_envelope.ciphertext[0] ^= 0xff;
              opStore.put(op);
            };
            txCorrupt.oncomplete = () => resolve();
          });

          // 2. Read corrupted record overlay
          const tamperedRecRes = await gateway.getRecord(ctx, "plan", "p1");

          // 3. Read corrupted outbox entry
          const tamperedListRes = await gateway.listPending(ctx);

          // 4. Test decryption with wrong key
          const key2 = await generateTestKey();
          const cleanEncryptedRes = await (async () => {
            const { encryptPayload } = window.__dayforge_storage_failures;
            return await encryptPayload(key1, ownerId, keyId, STORAGE_STORES.records, "test:1", { ok: true });
          })();

          let wrongKeyErrorCode = null;
          if (cleanEncryptedRes.ok) {
            const wrongKeyRes = await decryptPayload(
              key2,
              cleanEncryptedRes.value,
              ownerId,
              STORAGE_STORES.records,
              "test:1"
            );
            wrongKeyErrorCode = wrongKeyRes.ok ? null : wrongKeyRes.error.code;
          }

          // 5. Test context/metadata mismatch (AAD tampering)
          let aadMismatchErrorCode = null;
          if (cleanEncryptedRes.ok) {
            const aadMismatchRes = await decryptPayload(
              key1,
              cleanEncryptedRes.value,
              "wrong-owner-id",
              STORAGE_STORES.records,
              "test:1"
            );
            aadMismatchErrorCode = aadMismatchRes.ok ? null : aadMismatchRes.error.code;
          }

          closeDatabase(db);
          gateway.close();

          return {
            initialReadOk: initialRead.ok,
            initialListOk: initialList.ok,
            tamperedRecOk: tamperedRecRes.ok,
            tamperedRecError: tamperedRecRes.ok ? null : tamperedRecRes.error.code,
            tamperedListOk: tamperedListRes.ok,
            tamperedListError: tamperedListRes.ok ? null : tamperedListRes.error.code,
            wrongKeyErrorCode,
            aadMismatchErrorCode,
          };
        },
        { testDbName, ownerId, keyId, deviceId, opId, calId }
      );

      expect(result.initialReadOk).toBe(true);
      expect(result.initialListOk).toBe(true);
      expect(result.tamperedRecOk).toBe(false);
      expect(result.tamperedRecError).toBe("integrity_failed");
      expect(result.tamperedListOk).toBe(false);
      expect(result.tamperedListError).toBe("integrity_failed");
      expect(result.wrongKeyErrorCode).toBe("integrity_failed");
      expect(result.aadMismatchErrorCode).toBe("integrity_failed");
    });
  });

  test.describe("Boundary Scale: 1.000 Commands in a Single Operation", () => {
    test("atomically persists and verifies 1.000 commands with RFC 8785 canonical hash", async ({
      page,
    }) => {
      // Increase timeout for 1.000 command crypto hashing and roundtrip
      test.setTimeout(30000);

      const testDbName = `st_scale_1000_${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-scale-1";
      const deviceId = "22222222-2222-4222-8222-222222222222";
      const opId = "scale-op-1000-commands-uuid";
      const calId = "44444444-4444-4444-8444-444444444444";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, opId, calId }) => {
          const {
            openDatabase,
            closeDatabase,
            generateTestKey,
            unlockOwner,
            createLocalStorageGateway,
            advanceHlc,
            canonicalizeJson,
            sha256Hex,
            STORAGE_STORES,
          } = window.__dayforge_storage_failures;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false, error: openRes.error.code };
          const db = openRes.value;

          const key = await generateTestKey();
          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { step: "unlock", ok: false, error: unlockRes.error.code };
          }
          const ctx = unlockRes.value;

          const gateway = createLocalStorageGateway({ name: testDbName });
          const editTime = advanceHlc(null, 1793150000000, calId, "calibrated");

          // Build exactly 1.000 valid commands
          const commands = [];
          for (let i = 0; i < 1000; i++) {
            commands.push({
              root: { kind: "task", id: `task-item-${i}` },
              action: "task.create",
              payload: {
                title: `Scale Command Task ${i}`,
                index: i,
                plan_id: "plan-scale-root",
              },
            });
          }

          const t0 = performance.now();
          const persistRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: opId,
            commands,
            dependencies: [],
            editTime,
          });
          const persistDuration = performance.now() - t0;

          if (!persistRes.ok) {
            closeDatabase(db);
            gateway.close();
            return { step: "persist", ok: false, error: persistRes.error.code };
          }

          // Read back through listPending
          const t1 = performance.now();
          const listRes = await gateway.listPending(ctx);
          const readDuration = performance.now() - t1;

          if (!listRes.ok) {
            closeDatabase(db);
            gateway.close();
            return { step: "listPending", ok: false, error: listRes.error.code };
          }

          const recoveredEnvelope = listRes.value[0];
          const commandCount = recoveredEnvelope.commands.length;
          const firstCmd = recoveredEnvelope.commands[0] as { root: { id: string } };
          const midCmd = recoveredEnvelope.commands[500] as { root: { id: string } };
          const lastCmd = recoveredEnvelope.commands[999] as { root: { id: string } };

          // Compute canonical RFC 8785 hash of recovered envelope
          const canonical = canonicalizeJson(recoveredEnvelope);
          const computedHash = await sha256Hex(canonical);

          // Read raw outbox entry request_hash from DB
          const tx = db.transaction(STORAGE_STORES.operations, "readonly");
          const opStore = tx.objectStore(STORAGE_STORES.operations);
          const rawEntryReq = opStore.get([ownerId, opId]);
          const rawEntry = await new Promise<{ request_hash: string }>((resolve) => {
            rawEntryReq.onsuccess = () => resolve(rawEntryReq.result);
          });

          closeDatabase(db);
          gateway.close();

          return {
            persistOk: true,
            persistDuration,
            readDuration,
            commandCount,
            firstCmdId: firstCmd?.root?.id,
            midCmdId: midCmd?.root?.id,
            lastCmdId: lastCmd?.root?.id,
            hashesMatch: computedHash === rawEntry.request_hash,
            computedHash,
            storedHash: rawEntry.request_hash,
          };
        },
        { testDbName, ownerId, keyId, deviceId, opId, calId }
      );

      expect(result.persistOk).toBe(true);
      expect(result.commandCount).toBe(1000);
      expect(result.firstCmdId).toBe("task-item-0");
      expect(result.midCmdId).toBe("task-item-500");
      expect(result.lastCmdId).toBe("task-item-999");
      expect(result.hashesMatch).toBe(true);
      expect(result.computedHash?.length).toBe(64);
    });
  });

  test.describe("Boundary Content: 4.000 Unicode Codepoints Multiline Note", () => {
    test("roundtrips 4.000 codepoint note (Persian, Vietnamese, Emoji, CJK) without truncation or corruption", async ({
      page,
    }) => {
      const testDbName = `st_unicode_4000_${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-unicode-1";
      const deviceId = "22222222-2222-4222-8222-222222222222";
      const opId = "unicode-note-op-uuid";
      const calId = "44444444-4444-4444-8444-444444444444";

      // Build 4.000 Unicode codepoints multiline text
      const chunks = [
        "سلام دنیا! این یک یادداشت طولانی چندخطی برای تست انطباق کامل با یونیکد و زبان‌های راست‌به‌چپ (RTL) است.\n",
        "Đây là ghi chú thử nghiệm tiếng Việt có dấu đầy đủ: ă, â, đ, ê, ô, ơ, ư, cùng tất cả thanh sắc huyền hỏi ngã nặng chuẩn mực.\n",
        "🚀 📅 🧠 🇻🇳 🛡️ ⚡ 🎉 🔐 📝 ⏳ 📊 ✨ 🎯 💡 🔥\n",
        "这是一个多语言边界测试：简体中文、繁體中文、日本語テスト、한국어 텍스트 지원 확인.\n",
        "Multiline code section:\n```typescript\nconst boundaryTest = (val: string): boolean => val.length > 0;\n```\n",
      ];
      let note = "";
      let chunkIdx = 0;
      while ([...note].length < 4000) {
        const nextChunk = chunks[chunkIdx % chunks.length];
        const remaining = 4000 - [...note].length;
        if ([...nextChunk].length <= remaining) {
          note += nextChunk;
        } else {
          note += [...nextChunk].slice(0, remaining).join("");
        }
        chunkIdx++;
      }

      // Assert codepoint length is exactly 4.000
      expect([...note].length).toBe(4000);

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, opId, calId, note }) => {
          const {
            openDatabase,
            closeDatabase,
            generateTestKey,
            unlockOwner,
            createLocalStorageGateway,
            advanceHlc,
          } = window.__dayforge_storage_failures;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false, error: openRes.error.code };
          const db = openRes.value;

          const key = await generateTestKey();
          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { step: "unlock", ok: false, error: unlockRes.error.code };
          }
          const ctx = unlockRes.value;

          const gateway = createLocalStorageGateway({ name: testDbName });
          const editTime = advanceHlc(null, 1793150000000, calId, "calibrated");

          // Persist both in command payload and record overlay
          const persistRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: opId,
            commands: [{ root: { kind: "note", id: "note-1" }, action: "note.update", payload: { body: note } }],
            dependencies: [],
            editTime,
            recordOverlays: [{ kind: "note", id: "note-1", payload: { body: note } }],
          });

          if (!persistRes.ok) {
            closeDatabase(db);
            gateway.close();
            return { step: "persist", ok: false, error: persistRes.error.code };
          }

          // Read back overlay
          const recRes = await gateway.getRecord<{ body: string }>(ctx, "note", "note-1");
          // Read back outbox envelope
          const listRes = await gateway.listPending(ctx);

          closeDatabase(db);
          gateway.close();

          const recoveredRecordBody = recRes.ok ? recRes.value?.body : null;
          const recoveredCmdBody = listRes.ok
            ? (listRes.value[0].commands[0] as { payload: { body: string } })?.payload?.body
            : null;

          return {
            persistOk: true,
            recOk: recRes.ok,
            listOk: listRes.ok,
            recCodepoints: recoveredRecordBody ? [...recoveredRecordBody].length : 0,
            cmdCodepoints: recoveredCmdBody ? [...recoveredCmdBody].length : 0,
            recMatchesOriginal: recoveredRecordBody === note,
            cmdMatchesOriginal: recoveredCmdBody === note,
          };
        },
        { testDbName, ownerId, keyId, deviceId, opId, calId, note }
      );

      expect(result.persistOk).toBe(true);
      expect(result.recOk).toBe(true);
      expect(result.listOk).toBe(true);
      expect(result.recCodepoints).toBe(4000);
      expect(result.cmdCodepoints).toBe(4000);
      expect(result.recMatchesOriginal).toBe(true);
      expect(result.cmdMatchesOriginal).toBe(true);
    });
  });

  test.describe("ST-18: Non-Leakage Security Invariant", () => {
    test("verifies raw tokens, plaintext secrets, and raw keys never appear unencrypted in IndexedDB stores or console logs", async ({
      page,
    }) => {
      const testDbName = `st18_non_leakage_${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-st18-secret-1";
      const deviceId = "22222222-2222-4222-8222-222222222222";
      const opId = "st18-op-secret-uuid";
      const calId = "44444444-4444-4444-8444-444444444444";

      const rawSessionToken = "SESSION_TOKEN_TOP_SECRET_DAYFORGE_XYZ_987654321";
      const rawUserPassword = "SUPER_SECRET_USER_PLAINTEXT_PASSWORD_ABC";

      // Monitor console logs for sensitive leaks
      const consoleLogs: string[] = [];
      page.on("console", (msg) => {
        consoleLogs.push(msg.text());
      });

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, opId, calId, rawSessionToken, rawUserPassword }) => {
          const {
            openDatabase,
            closeDatabase,
            generateTestKey,
            unlockOwner,
            createLocalStorageGateway,
            advanceHlc,
            STORAGE_STORES,
          } = window.__dayforge_storage_failures;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false, error: openRes.error.code };
          const db = openRes.value;

          const key = await generateTestKey();
          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { step: "unlock", ok: false, error: unlockRes.error.code };
          }
          const ctx = unlockRes.value;

          const gateway = createLocalStorageGateway({ name: testDbName });
          const editTime = advanceHlc(null, 1793150000000, calId, "calibrated");

          // Persist sensitive information in commands and overlays
          const persistRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: opId,
            commands: [
              {
                root: { kind: "auth", id: "session-1" },
                action: "auth.bind",
                payload: { token: rawSessionToken, secret: rawUserPassword },
              },
            ],
            dependencies: [],
            editTime,
            recordOverlays: [
              {
                kind: "auth",
                id: "session-1",
                payload: { token: rawSessionToken, secret: rawUserPassword },
              },
            ],
          });

          if (!persistRes.ok) {
            closeDatabase(db);
            gateway.close();
            return { step: "persist", ok: false, error: persistRes.error.code };
          }

          // Inspect EVERY store directly in raw unencrypted IDB representation
          const storeNames = [
            STORAGE_STORES.owner_meta,
            STORAGE_STORES.device_meta,
            STORAGE_STORES.crypto_keys,
            STORAGE_STORES.operations,
            STORAGE_STORES.records,
            STORAGE_STORES.sync_meta,
            STORAGE_STORES.view_preferences,
            STORAGE_STORES.drafts,
          ];

          const tx = db.transaction(storeNames, "readonly");
          const storeDumps: Record<string, unknown[]> = {};

          for (const name of storeNames) {
            const req = tx.objectStore(name).getAll();
            req.onsuccess = () => {
              storeDumps[name] = req.result;
            };
          }

          await new Promise<void>((resolve) => {
            tx.oncomplete = () => resolve();
          });

          // Check crypto_keys store specifically:
          // Key must be stored as non-extractable CryptoKey, NOT raw byte array or plaintext string
          const cryptoKeyRecords = storeDumps[STORAGE_STORES.crypto_keys] as {
            key: CryptoKey;
          }[];
          const storedKey = cryptoKeyRecords[0]?.key;
          const keyIsCryptoKey = storedKey instanceof CryptoKey;
          const keyIsNonExtractable = storedKey?.extractable === false;

          // Check all dumped objects for raw secrets substring leakage
          let leakedSecretsFound: string[] = [];
          for (const [storeName, records] of Object.entries(storeDumps)) {
            const dumpedString = JSON.stringify(records, (key, value) => {
              if (value instanceof Uint8Array) {
                return `[Uint8Array ${value.byteLength} bytes]`;
              }
              if (value instanceof CryptoKey) {
                return `[CryptoKey extractable=${value.extractable}]`;
              }
              return value;
            });

            if (dumpedString.includes(rawSessionToken)) {
              leakedSecretsFound.push(`${storeName}: leaked rawSessionToken`);
            }
            if (dumpedString.includes(rawUserPassword)) {
              leakedSecretsFound.push(`${storeName}: leaked rawUserPassword`);
            }
          }

          closeDatabase(db);
          gateway.close();

          return {
            persistOk: true,
            keyIsCryptoKey,
            keyIsNonExtractable,
            leakedSecretsFound,
          };
        },
        { testDbName, ownerId, keyId, deviceId, opId, calId, rawSessionToken, rawUserPassword }
      );

      expect(result.persistOk).toBe(true);
      expect(result.keyIsCryptoKey).toBe(true);
      expect(result.keyIsNonExtractable).toBe(true);
      expect(result.leakedSecretsFound).toEqual([]);

      // Check console logs: ensure no sensitive token or key was logged
      for (const log of consoleLogs) {
        expect(log).not.toContain(rawSessionToken);
        expect(log).not.toContain(rawUserPassword);
      }
    });
  });

  test.describe("Performance: 100+ Encrypted Outbox Operations", () => {
    test("measures batch persist and read/decrypt times for 100 encrypted operations in real Chromium", async ({
      page,
    }) => {
      // Set 60s timeout for 100 encrypted operations in browser
      test.setTimeout(60000);

      const testDbName = `st_perf_100_${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-perf-1";
      const deviceId = "22222222-2222-4222-8222-222222222222";
      const calId = "44444444-4444-4444-8444-444444444444";

      const perfMetrics = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, calId }) => {
          const {
            openDatabase,
            closeDatabase,
            generateTestKey,
            unlockOwner,
            createLocalStorageGateway,
            advanceHlc,
          } = window.__dayforge_storage_failures;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false, error: openRes.error.code };
          const db = openRes.value;

          const key = await generateTestKey();
          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { step: "unlock", ok: false, error: unlockRes.error.code };
          }
          const ctx = unlockRes.value;

          const gateway = createLocalStorageGateway({ name: testDbName });
          let currentHlc = advanceHlc(null, 1793160000000, calId, "calibrated");

          const operationCount = 100;
          const batchPersistStart = performance.now();

          // Sequentially persist 100 distinct encrypted operations with record overlays
          for (let i = 1; i <= operationCount; i++) {
            currentHlc = advanceHlc(currentHlc, 1793160000000 + i * 10, calId, "calibrated");
            const opId = `perf-op-${i.toString().padStart(4, "0")}`;
            const planPayload = { title: `Performance Plan ${i}`, index: i };
            const taskPayload = { title: `Performance Task ${i}`, plan_id: `plan-${i}` };

            const pRes = await gateway.persistOperation({
              context: ctx,
              deviceId,
              operationId: opId,
              commands: [
                { root: { kind: "plan", id: `plan-${i}` }, action: "plan.create", payload: planPayload },
                { root: { kind: "task", id: `task-${i}` }, action: "task.create", payload: taskPayload },
              ],
              dependencies: i > 1 ? [`perf-op-${(i - 1).toString().padStart(4, "0")}`] : [],
              editTime: currentHlc,
              recordOverlays: [
                { kind: "plan", id: `plan-${i}`, payload: planPayload },
                { kind: "task", id: `task-${i}`, payload: taskPayload },
              ],
            });

            if (!pRes.ok) {
              closeDatabase(db);
              gateway.close();
              return { step: `persist_${i}`, ok: false, error: pRes.error.code };
            }
          }
          const batchPersistDuration = performance.now() - batchPersistStart;

          // Measure listPending: reads all 100 outbox entries, decrypts AES-256-GCM envelopes, sorts by sequence
          const listStart = performance.now();
          const listRes = await gateway.listPending(ctx);
          const listDuration = performance.now() - listStart;

          if (!listRes.ok) {
            closeDatabase(db);
            gateway.close();
            return { step: "listPending", ok: false, error: listRes.error.code };
          }

          closeDatabase(db);
          gateway.close();

          return {
            ok: true,
            operationCount,
            batchPersistDuration,
            avgPersistPerOp: batchPersistDuration / operationCount,
            listDuration,
            avgReadPerOp: listDuration / operationCount,
            recoveredCount: listRes.value.length,
          };
        },
        { testDbName, ownerId, keyId, deviceId, calId }
      );

      expect(perfMetrics.ok).toBe(true);
      expect(perfMetrics.recoveredCount).toBe(100);

      // Verify measured timings are sensible finite numbers
      expect(perfMetrics.batchPersistDuration).toBeGreaterThan(0);
      expect(perfMetrics.listDuration).toBeGreaterThan(0);

      console.log(`\n========================================`);
      console.log(`[PERFORMANCE METRICS - 100 ENCRYPTED OUTBOX OPS]`);
      console.log(`Persist 100 Operations Total: ${perfMetrics.batchPersistDuration?.toFixed(2)} ms`);
      console.log(`Avg Persist per Operation:    ${perfMetrics.avgPersistPerOp?.toFixed(2)} ms`);
      console.log(`List & Decrypt 100 Ops Total: ${perfMetrics.listDuration?.toFixed(2)} ms`);
      console.log(`Avg Read & Decrypt per Op:    ${perfMetrics.avgReadPerOp?.toFixed(2)} ms`);
      console.log(`========================================\n`);
    });
  });
});

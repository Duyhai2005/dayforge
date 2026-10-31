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
  type OwnerAccessContext,
  type HlcEditTime,
  validateHlc,
  advanceHlc,
  canonicalizeJson,
  sha256Hex,
  computeCanonicalHash,
  type OperationEnvelope,
  type OutboxEntry,
  type OutboxStatus,
  type PersistOperationInput,
  type PersistOperationResult,
  persistOperationAtomic,
  createLocalStorageGateway,
  type LocalStorageGateway,
} from "../lib/storage";

declare global {
  interface Window {
    __dayforge_storage_atomicity: {
      StorageError: typeof StorageError;
      DB_NAME: typeof DB_NAME;
      STORAGE_STORES: typeof STORAGE_STORES;
      openDatabase: typeof openDatabase;
      closeDatabase: typeof closeDatabase;
      generateTestKey: typeof generateTestKey;
      importRawKey: typeof importRawKey;
      unlockOwner: typeof unlockOwner;
      validateHlc: typeof validateHlc;
      advanceHlc: typeof advanceHlc;
      canonicalizeJson: typeof canonicalizeJson;
      sha256Hex: typeof sha256Hex;
      computeCanonicalHash: typeof computeCanonicalHash;
      persistOperationAtomic: typeof persistOperationAtomic;
      createLocalStorageGateway: typeof createLocalStorageGateway;
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
  ];

  const combined = files
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
    window.__dayforge_storage_atomicity = exports;
  })();`;
}

test.describe("Storage Atomicity, Outbox & Clock Specifications", () => {
  test.describe("RFC 8785 Canonical JSON & SHA-256 Vector", () => {
    test("canonicalizeJson and sha256Hex match T03 test vector fixture", async () => {
      const fixtureValue = {
        root: {
          kind: "plan",
          id: "11111111-1111-4111-8111-111111111111",
        },
        state: {
          owner_id: "11111111-1111-4111-8111-111111111111",
          deleted: false,
          data: {
            name: "Ôn giữa kỳ",
            color_id: "green",
          },
        },
      };

      const expectedCanonical =
        '{"root":{"id":"11111111-1111-4111-8111-111111111111","kind":"plan"},"state":{"data":{"color_id":"green","name":"Ôn giữa kỳ"},"deleted":false,"owner_id":"11111111-1111-4111-8111-111111111111"}}';
      const expectedSha256 =
        "8a27ece9d403ee7ec8de370bc8c77e3f119357803619c21bd951e753266f14bc";

      const canonical = canonicalizeJson(fixtureValue);
      expect(canonical).toBe(expectedCanonical);

      const hash = await sha256Hex(canonical);
      expect(hash).toBe(expectedSha256);

      const computed = await computeCanonicalHash(fixtureValue);
      expect(computed.canonicalJson).toBe(expectedCanonical);
      expect(computed.hash).toBe(expectedSha256);
    });

    test("canonicalizeJson preserves array order and sorts keys by UTF-16 code units", () => {
      const obj = {
        z: 1,
        a: [3, 2, 1],
        A: true,
        _: null,
        "1": -0,
      };

      const canonical = canonicalizeJson(obj);
      // UTF-16 code units: "1" (49) < "A" (65) < "_" (95) < "a" (97) < "z" (122)
      // -0 becomes 0, array retains [3,2,1]
      expect(canonical).toBe('{"1":0,"A":true,"_":null,"a":[3,2,1],"z":1}');
    });
  });

  test.describe("HLC Clock State & Advance Logic", () => {
    test("validateHlc checks physical_ms integer, logical >= 0, UUID calibration_id, quality enum", () => {
      const validHlc: HlcEditTime = {
        physical_ms: 1793140000000,
        logical: 0,
        calibration_id: "11111111-1111-4111-8111-111111111111",
        raw_wall_ms: 1793140000000,
        quality: "calibrated",
      };
      expect(validateHlc(validHlc)).toBe(true);

      // Rejections
      expect(validateHlc({ ...validHlc, physical_ms: 1.5 })).toBe(false);
      expect(validateHlc({ ...validHlc, logical: -1 })).toBe(false);
      expect(validateHlc({ ...validHlc, calibration_id: "not-a-uuid" })).toBe(false);
      expect(
        validateHlc({ ...validHlc, quality: "invalid_quality" as unknown as "calibrated" })
      ).toBe(false);
    });

    test("advanceHlc increments logical on same/backward wall clock and resets on forward wall clock", () => {
      const calId = "11111111-1111-4111-8111-111111111111";

      // Initial advance
      const hlc1 = advanceHlc(null, 1000, calId, "calibrated");
      expect(hlc1.physical_ms).toBe(1000);
      expect(hlc1.logical).toBe(0);
      expect(hlc1.calibration_id).toBe(calId);

      // Backward wall clock: physical remains at max, logical increments
      const hlc2 = advanceHlc(hlc1, 950, calId);
      expect(hlc2.physical_ms).toBe(1000);
      expect(hlc2.logical).toBe(1);

      // Same wall clock: physical remains, logical increments
      const hlc3 = advanceHlc(hlc2, 1000, calId);
      expect(hlc3.physical_ms).toBe(1000);
      expect(hlc3.logical).toBe(2);

      // Forward wall clock: physical advances, logical resets to 0
      const hlc4 = advanceHlc(hlc3, 1500, calId);
      expect(hlc4.physical_ms).toBe(1500);
      expect(hlc4.logical).toBe(0);
    });
  });

  test.describe("Browser Atomic Persistence & Outbox", () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(buildStorageScript());
      await page.goto("/work");
    });

    test("ST-03: Commit operation atomically: outbox + record overlays + device sequence + clock state in one transaction", async ({
      page,
    }) => {
      const testDbName = `st03_atomic_${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-test-1";
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
          } = window.__dayforge_storage_atomicity;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { ok: false as const, error: openRes.error.code, step: "open" };
          const db = openRes.value;

          const key = await generateTestKey();
          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { ok: false as const, error: unlockRes.error.code, step: "unlock" };
          }
          const ctx = unlockRes.value;

          const gateway = createLocalStorageGateway({ name: testDbName });
          await gateway.open();

          const editTime = advanceHlc(null, 1793140000000, calId, "calibrated");
          const planPayload = { name: "Atomic Plan", color_id: "green" };
          const taskPayload = { title: "Atomic Task", plan_id: "plan-1" };

          const persistRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: opId,
            commands: [{ root: { kind: "plan", id: "plan-1" }, action: "plan.create", payload: planPayload }],
            dependencies: [],
            editTime,
            recordOverlays: [
              { kind: "plan", id: "plan-1", payload: planPayload },
              { kind: "task", id: "task-1", payload: taskPayload },
            ],
          });

          if (!persistRes.ok) {
            gateway.close();
            closeDatabase(db);
            return { ok: false as const, error: persistRes.error.code, step: "persist" };
          }

          // Read direct from stores to verify atomic writes
          const storeInspection = await new Promise<{
            outboxEntry: unknown;
            planRecord: unknown;
            taskRecord: unknown;
            deviceMeta: unknown;
          }>((resolve, reject) => {
            const tx = db.transaction(
              [
                STORAGE_STORES.operations,
                STORAGE_STORES.records,
                STORAGE_STORES.device_meta,
              ],
              "readonly"
            );
            const opReq = tx.objectStore(STORAGE_STORES.operations).get([ownerId, opId]);
            const planReq = tx.objectStore(STORAGE_STORES.records).get([ownerId, "plan", "plan-1"]);
            const taskReq = tx.objectStore(STORAGE_STORES.records).get([ownerId, "task", "task-1"]);
            const devReq = tx.objectStore(STORAGE_STORES.device_meta).get([ownerId, deviceId]);

            tx.oncomplete = () => {
              resolve({
                outboxEntry: opReq.result,
                planRecord: planReq.result,
                taskRecord: taskReq.result,
                deviceMeta: devReq.result,
              });
            };
            tx.onerror = () => reject(tx.error);
          });

          // Verify through gateway APIs
          const pendingRes = await gateway.listPending(ctx);
          const getPlanRes = await gateway.getRecord<{ name: string; color_id: string }>(ctx, "plan", "plan-1");
          const getTaskRes = await gateway.getRecord<{ title: string; plan_id: string }>(ctx, "task", "task-1");

          gateway.close();
          closeDatabase(db);

          return {
            ok: true as const,
            persistValue: persistRes.value,
            storeInspection,
            pendingCount: pendingRes.ok ? pendingRes.value.length : -1,
            pendingEnvelope: pendingRes.ok ? pendingRes.value[0] : null,
            planData: getPlanRes.ok ? getPlanRes.value : null,
            taskData: getTaskRes.ok ? getTaskRes.value : null,
          };
        },
        { testDbName, ownerId, keyId, deviceId, opId, calId }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("ST-03 failed: " + JSON.stringify(result));

      expect(result.persistValue.operationId).toBe(opId);
      expect(result.persistValue.deviceSequence).toBe("1");
      expect(result.persistValue.durability).toBe("committed_to_indexeddb");

      // Verify raw store inspection
      const rawOutbox = result.storeInspection.outboxEntry as OutboxEntry;
      expect(rawOutbox).toBeDefined();
      expect(rawOutbox.owner_id).toBe(ownerId);
      expect(rawOutbox.operation_id).toBe(opId);
      expect(rawOutbox.device_sequence).toBe("1");
      expect(rawOutbox.status).toBe("pending");
      expect(rawOutbox.request_hash).toHaveLength(64);
      expect(rawOutbox.encrypted_envelope.ciphertext).toBeDefined();

      const rawDev = result.storeInspection.deviceMeta as { last_sequence: string; last_hlc: HlcEditTime };
      expect(rawDev.last_sequence).toBe("1");
      expect(rawDev.last_hlc.physical_ms).toBe(1793140000000);

      // Verify decrypted gateway view
      expect(result.pendingCount).toBe(1);
      expect(result.pendingEnvelope?.operation_id).toBe(opId);
      expect(result.pendingEnvelope?.device_sequence).toBe("1");
      expect(result.planData).toEqual({ name: "Atomic Plan", color_id: "green" });
      expect(result.taskData).toEqual({ title: "Atomic Task", plan_id: "plan-1" });
    });

    test("ST-04: Aborted transaction leaves zero partial changes (rollback verification)", async ({
      page,
    }) => {
      const testDbName = `st04_rollback_${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-test-1";
      const deviceId = "22222222-2222-4222-8222-222222222222";
      const op1 = "33333333-3333-4333-8333-333333333333";
      const op2 = "44444444-4444-4444-8444-444444444444";
      const calId = "55555555-5555-4555-8555-555555555555";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, op1, op2, calId }) => {
          const {
            openDatabase,
            closeDatabase,
            generateTestKey,
            unlockOwner,
            createLocalStorageGateway,
            advanceHlc,
            STORAGE_STORES,
          } = window.__dayforge_storage_atomicity;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { ok: false as const, error: openRes.error.code };
          const db = openRes.value;

          const key = await generateTestKey();
          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { ok: false as const, error: unlockRes.error.code };
          }
          const ctx = unlockRes.value;

          const gateway = createLocalStorageGateway({ name: testDbName });
          await gateway.open();

          const editTime = advanceHlc(null, 1793140000000, calId, "calibrated");

          // 1. Commit initial operation to advance sequence to "1"
          const op1Res = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: op1,
            commands: [{ root: { kind: "plan", id: "p1" }, action: "plan.create", payload: {} }],
            dependencies: [],
            editTime,
            recordOverlays: [{ kind: "plan", id: "p1", payload: { name: "Original Plan" } }],
          });
          if (!op1Res.ok) {
            gateway.close();
            closeDatabase(db);
            return { ok: false as const, error: op1Res.error.code, step: "op1" };
          }

          // 2. Attempt op2 with explicit abort
          const op2Res = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: op2,
            commands: [{ root: { kind: "plan", id: "p2" }, action: "plan.create", payload: {} }],
            dependencies: [],
            editTime,
            recordOverlays: [{ kind: "plan", id: "p2", payload: { name: "Aborted Plan" } }],
            _abortForTest: true,
          } as unknown as PersistOperationInput);

          // 3. Inspect stores to ensure op2 was completely rolled back
          const inspection = await new Promise<{
            op2Entry: unknown;
            p2Record: unknown;
            deviceMeta: unknown;
          }>((resolve, reject) => {
            const tx = db.transaction(
              [
                STORAGE_STORES.operations,
                STORAGE_STORES.records,
                STORAGE_STORES.device_meta,
              ],
              "readonly"
            );
            const op2Req = tx.objectStore(STORAGE_STORES.operations).get([ownerId, op2]);
            const p2Req = tx.objectStore(STORAGE_STORES.records).get([ownerId, "plan", "p2"]);
            const devReq = tx.objectStore(STORAGE_STORES.device_meta).get([ownerId, deviceId]);

            tx.oncomplete = () => {
              resolve({
                op2Entry: op2Req.result ?? null,
                p2Record: p2Req.result ?? null,
                deviceMeta: devReq.result,
              });
            };
            tx.onerror = () => reject(tx.error);
          });

          gateway.close();
          closeDatabase(db);

          return {
            ok: true as const,
            op1Sequence: op1Res.value.deviceSequence,
            op2Ok: op2Res.ok,
            op2ErrorCode: !op2Res.ok ? op2Res.error.code : null,
            inspection,
          };
        },
        { testDbName, ownerId, keyId, deviceId, op1, op2, calId }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("ST-03 failed: " + JSON.stringify(result));

      expect(result.op1Sequence).toBe("1");
      expect(result.op2Ok).toBe(false);
      expect(result.op2ErrorCode).toBe("transaction_aborted");

      // Verify zero partial changes
      expect(result.inspection.op2Entry).toBeNull();
      expect(result.inspection.p2Record).toBeNull();
      const dev = result.inspection.deviceMeta as { last_sequence: string };
      expect(dev.last_sequence).toBe("1");
    });

    test("ST-05: Concurrent writes in two tabs / contexts: unique strictly monotonic sequences, no lost updates", async ({
      browser,
    }) => {
      const testDbName = `st05_concurrent_${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-test-shared";
      const deviceId = "22222222-2222-4222-8222-222222222222";
      const calId = "33333333-3333-4333-8333-333333333333";

      // Two tabs (pages) sharing the same browser context / IndexedDB database
      const context = await browser.newContext();
      const page1 = await context.newPage();
      await page1.addInitScript(buildStorageScript());
      await page1.goto("/work");

      const page2 = await context.newPage();
      await page2.addInitScript(buildStorageScript());
      await page2.goto("/work");

      // Setup shared 32-byte key for both contexts
      const rawKeyBytes = Array.from({ length: 32 }, (_, i) => (i * 7 + 13) % 256);

      const unlockRes = await page1.evaluate(
        async ({ testDbName, ownerId, keyId, rawKeyBytes }) => {
          const { openDatabase, closeDatabase, importRawKey, unlockOwner } =
            window.__dayforge_storage_atomicity;
          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return false;
          const key = await importRawKey(new Uint8Array(rawKeyBytes));
          const unlRes = await unlockOwner(openRes.value, ownerId, keyId, key);
          closeDatabase(openRes.value);
          return unlRes.ok;
        },
        { testDbName, ownerId, keyId, rawKeyBytes }
      );

      expect(unlockRes).toBe(true);

      // Concurrent execution: 3 operations in Tab 1, 3 operations in Tab 2
      const tab1Promise = page1.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, calId, rawKeyBytes }) => {
          const { createLocalStorageGateway, advanceHlc, importRawKey } =
            window.__dayforge_storage_atomicity;
          const key = await importRawKey(new Uint8Array(rawKeyBytes));
          const ctx: OwnerAccessContext = { ownerId, keyId, lockEpoch: 1, key };

          const gateway = createLocalStorageGateway({ name: testDbName });
          await gateway.open();

          const results: { opId: string; seq: string }[] = [];
          for (let i = 1; i <= 3; i++) {
            const opId = `11111111-0000-0000-0000-00000000000${i}`;
            const editTime = advanceHlc(null, 1793140000000 + i * 10, calId);
            const res = await gateway.persistOperation({
              context: ctx,
              deviceId,
              operationId: opId,
              commands: [{ root: { kind: "task", id: `t1-${i}` }, action: "task.create", payload: {} }],
              dependencies: [],
              editTime,
            });
            if (res.ok) {
              results.push({ opId: res.value.operationId, seq: res.value.deviceSequence });
            } else {
              results.push({ opId, seq: `ERR:${res.error.code}:${res.error.message}` });
            }
          }
          gateway.close();
          return results;
        },
        { testDbName, ownerId, keyId, deviceId, calId, rawKeyBytes }
      );

      const tab2Promise = page2.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, calId, rawKeyBytes }) => {
          const { createLocalStorageGateway, advanceHlc, importRawKey } =
            window.__dayforge_storage_atomicity;
          const key = await importRawKey(new Uint8Array(rawKeyBytes));
          const ctx: OwnerAccessContext = { ownerId, keyId, lockEpoch: 1, key };

          const gateway = createLocalStorageGateway({ name: testDbName });
          await gateway.open();

          const results: { opId: string; seq: string }[] = [];
          for (let i = 1; i <= 3; i++) {
            const opId = `22222222-0000-0000-0000-00000000000${i}`;
            const editTime = advanceHlc(null, 1793140000000 + i * 10 + 5, calId);
            const res = await gateway.persistOperation({
              context: ctx,
              deviceId,
              operationId: opId,
              commands: [{ root: { kind: "task", id: `t2-${i}` }, action: "task.create", payload: {} }],
              dependencies: [],
              editTime,
            });
            if (res.ok) {
              results.push({ opId: res.value.operationId, seq: res.value.deviceSequence });
            } else {
              results.push({ opId, seq: `ERR:${res.error.code}:${res.error.message}` });
            }
          }
          gateway.close();
          return results;
        },
        { testDbName, ownerId, keyId, deviceId, calId, rawKeyBytes }
      );

      const [res1, res2] = await Promise.all([tab1Promise, tab2Promise]);
      expect(res1).toHaveLength(3);
      expect(res2).toHaveLength(3);

      const allSequences = [...res1.map((r) => r.seq), ...res2.map((r) => r.seq)];
      const uniqueSequences = new Set(allSequences);

      // Verify strictly unique sequences: all 6 numbers from 1 to 6
      expect(uniqueSequences.size).toBe(6);
      expect(Array.from(uniqueSequences).sort((a, b) => Number(a) - Number(b))).toEqual([
        "1",
        "2",
        "3",
        "4",
        "5",
        "6",
      ]);

      await context.close();
    });

    test("ST-06: Duplicate operation_id rejected without overwriting existing outbox", async ({
      page,
    }) => {
      const testDbName = `st06_dup_${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-test-1";
      const deviceId = "22222222-2222-4222-8222-222222222222";
      const dupOpId = "55555555-5555-4555-8555-555555555555";
      const calId = "66666666-6666-4666-8666-666666666666";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, dupOpId, calId }) => {
          const {
            openDatabase,
            closeDatabase,
            generateTestKey,
            unlockOwner,
            createLocalStorageGateway,
            advanceHlc,
          } = window.__dayforge_storage_atomicity;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { ok: false, error: openRes.error.code };
          const db = openRes.value;

          const key = await generateTestKey();
          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          closeDatabase(db);
          if (!unlockRes.ok) return { ok: false, error: unlockRes.error.code };
          const ctx = unlockRes.value;

          const gateway = createLocalStorageGateway({ name: testDbName });
          await gateway.open();

          const editTime = advanceHlc(null, 1793140000000, calId);

          // 1. Initial write
          const firstRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: dupOpId,
            commands: [{ root: { kind: "plan", id: "p1" }, action: "plan.create", payload: { name: "First Write" } }],
            dependencies: [],
            editTime,
            recordOverlays: [{ kind: "plan", id: "p1", payload: { name: "First Write" } }],
          });

          // 2. Duplicate operation ID with different data
          const dupRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: dupOpId,
            commands: [{ root: { kind: "plan", id: "p1" }, action: "plan.create", payload: { name: "Overwriting Attempt" } }],
            dependencies: [],
            editTime,
            recordOverlays: [{ kind: "plan", id: "p1", payload: { name: "Overwriting Attempt" } }],
          });

          // 3. Verify original plan record is still "First Write"
          const planRecord = await gateway.getRecord<{ name: string }>(ctx, "plan", "p1");

          gateway.close();

          return {
            ok: true,
            firstOk: firstRes.ok,
            dupOk: dupRes.ok,
            dupErrorCode: !dupRes.ok ? dupRes.error.code : null,
            dupErrorMessage: !dupRes.ok ? dupRes.error.message : null,
            planName: planRecord.ok ? planRecord.value?.name : null,
          };
        },
        { testDbName, ownerId, keyId, deviceId, dupOpId, calId }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("ST-03 failed: " + JSON.stringify(result));

      expect(result.firstOk).toBe(true);
      expect(result.dupOk).toBe(false);
      expect(result.dupErrorCode).toBe("invalid_data");
      expect(result.dupErrorMessage).toContain("Duplicate operation ID");
      expect(result.planName).toBe("First Write");
    });

    test("ST-07: Durability across page reload: envelope, hash, sequence, and record overlays immutable after reload", async ({
      page,
    }) => {
      const testDbName = `st07_reload_${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-test-1";
      const deviceId = "22222222-2222-4222-8222-222222222222";
      const opId = "77777777-7777-4777-8777-777777777777";
      const calId = "88888888-8888-4888-8888-888888888888";

      const rawKey = Array.from({ length: 32 }, (_, i) => (i * 11 + 5) % 256);

      // 1. Write before reload
      const beforeResult = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, opId, calId, rawKey }) => {
          const {
            openDatabase,
            closeDatabase,
            importRawKey,
            unlockOwner,
            createLocalStorageGateway,
            advanceHlc,
          } = window.__dayforge_storage_atomicity;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return null;
          const key = await importRawKey(new Uint8Array(rawKey));
          const unlockRes = await unlockOwner(openRes.value, ownerId, keyId, key);
          closeDatabase(openRes.value);
          if (!unlockRes.ok) return null;
          const ctx = unlockRes.value;

          const gateway = createLocalStorageGateway({ name: testDbName });
          await gateway.open();

          const editTime = advanceHlc(null, 1793140000000, calId);
          await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: opId,
            commands: [{ root: { kind: "plan", id: "p1" }, action: "plan.create", payload: { name: "Persistent Plan" } }],
            dependencies: [],
            editTime,
            recordOverlays: [{ kind: "plan", id: "p1", payload: { name: "Persistent Plan" } }],
          });

          const pending = await gateway.listPending(ctx);
          gateway.close();

          return {
            pendingEnvelope: pending.ok ? pending.value[0] : null,
          };
        },
        { testDbName, ownerId, keyId, deviceId, opId, calId, rawKey }
      );

      expect(beforeResult).not.toBeNull();
      if (!beforeResult) return;

      // 2. Reload page
      await page.reload();

      // 3. Verify after reload
      const afterResult = await page.evaluate(
        async ({ testDbName, ownerId, keyId, rawKey }) => {
          const { createLocalStorageGateway, importRawKey } = window.__dayforge_storage_atomicity;
          const key = await importRawKey(new Uint8Array(rawKey));
          const ctx: OwnerAccessContext = { ownerId, keyId, lockEpoch: 1, key };

          const gateway = createLocalStorageGateway({ name: testDbName });
          await gateway.open();

          const pending = await gateway.listPending(ctx);
          const planRecord = await gateway.getRecord<{ name: string }>(ctx, "plan", "p1");
          gateway.close();

          return {
            pendingEnvelope: pending.ok ? pending.value[0] : null,
            planData: planRecord.ok ? planRecord.value : null,
          };
        },
        { testDbName, ownerId, keyId, rawKey }
      );

      expect(afterResult.pendingEnvelope).toEqual(beforeResult.pendingEnvelope);
      expect(afterResult.planData).toEqual({ name: "Persistent Plan" });
    });

    test("ST-16: 64-bit max sequence string preservation without precision loss", async ({
      page,
    }) => {
      const testDbName = `st16_seq64_${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-test-1";
      const deviceId = "22222222-2222-4222-8222-222222222222";
      const opId = "99999999-9999-4999-8999-999999999999";
      const calId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

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
          } = window.__dayforge_storage_atomicity;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { ok: false, error: openRes.error.code };
          const db = openRes.value;

          // Seed device_meta with near-max 64-bit integer: 2^64 - 2 = 18446744073709551614
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORAGE_STORES.device_meta, "readwrite");
            tx.objectStore(STORAGE_STORES.device_meta).put({
              owner_id: ownerId,
              device_id: deviceId,
              last_sequence: "18446744073709551614",
              updated_at: new Date().toISOString(),
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });

          const key = await generateTestKey();
          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          closeDatabase(db);
          if (!unlockRes.ok) return { ok: false, error: unlockRes.error.code };
          const ctx = unlockRes.value;

          const gateway = createLocalStorageGateway({ name: testDbName });
          await gateway.open();

          const editTime = advanceHlc(null, 1793140000000, calId);
          const persistRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: opId,
            commands: [],
            dependencies: [],
            editTime,
          });

          gateway.close();

          return {
            ok: persistRes.ok,
            seq: persistRes.ok ? persistRes.value.deviceSequence : null,
          };
        },
        { testDbName, ownerId, keyId, deviceId, opId, calId }
      );

      expect(result.ok).toBe(true);
      // 18446744073709551614 + 1 = 18446744073709551615 (max 64-bit unsigned uint64)
      // Standard JS Number would round to 18446744073709552000; BigInt preserves exact digits
      expect(result.seq).toBe("18446744073709551615");
    });

    test("ST-17: Invalid clock quality (untrusted) flagged with time_invalid status", async ({
      page,
    }) => {
      const testDbName = `st17_clock_${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-test-1";
      const deviceId = "22222222-2222-4222-8222-222222222222";
      const calId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, calId }) => {
          const {
            openDatabase,
            closeDatabase,
            generateTestKey,
            unlockOwner,
            createLocalStorageGateway,
            STORAGE_STORES,
          } = window.__dayforge_storage_atomicity;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { ok: false, error: openRes.error.code };
          const db = openRes.value;

          const key = await generateTestKey();
          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          closeDatabase(db);
          if (!unlockRes.ok) return { ok: false, error: unlockRes.error.code };
          const ctx = unlockRes.value;

          const gateway = createLocalStorageGateway({ name: testDbName });
          await gateway.open();

          // 1. Untrusted quality HLC
          const untrustedHlc: HlcEditTime = {
            physical_ms: 1793140000000,
            logical: 0,
            calibration_id: calId,
            raw_wall_ms: 1793140000000,
            quality: "untrusted",
          };

          const persistUntrustedRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            commands: [],
            dependencies: [],
            editTime: untrustedHlc,
          });

          // 2. Outright malformed quality
          const malformedHlc = {
            physical_ms: 1793140000000,
            logical: 0,
            calibration_id: calId,
            raw_wall_ms: 1793140000000,
            quality: "garbage_quality",
          } as unknown as HlcEditTime;

          const persistMalformedRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            commands: [],
            dependencies: [],
            editTime: malformedHlc,
          });

          // Check direct outbox status for untrusted operation
          const inspectRes = await openDatabase({ name: testDbName });
          const outboxEntry = await new Promise<unknown>((resolve) => {
            if (!inspectRes.ok) return resolve(null);
            const tx = inspectRes.value.transaction(STORAGE_STORES.operations, "readonly");
            const req = tx.objectStore(STORAGE_STORES.operations).get([ownerId, "cccccccc-cccc-4ccc-8ccc-cccccccccccc"]);
            tx.oncomplete = () => {
              closeDatabase(inspectRes.value);
              resolve(req.result ?? null);
            };
          });

          // listPending must NOT return untrusted operations
          const pendingRes = await gateway.listPending(ctx);

          gateway.close();

          return {
            ok: true,
            untrustedPersistOk: persistUntrustedRes.ok,
            untrustedStatus: (outboxEntry as OutboxEntry | null)?.status ?? null,
            malformedPersistOk: persistMalformedRes.ok,
            malformedErrorCode: !persistMalformedRes.ok ? persistMalformedRes.error.code : null,
            pendingCount: pendingRes.ok ? pendingRes.value.length : -1,
          };
        },
        { testDbName, ownerId, keyId, deviceId, calId }
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("ST-03 failed: " + JSON.stringify(result));

      expect(result.untrustedPersistOk).toBe(true);
      expect(result.untrustedStatus).toBe("time_invalid");
      expect(result.pendingCount).toBe(0); // Excluded from pending pull queue

      expect(result.malformedPersistOk).toBe(false);
      expect(result.malformedErrorCode).toBe("invalid_data");
    });
  });
});

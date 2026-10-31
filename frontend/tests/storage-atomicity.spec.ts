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

    test("canonicalizeJson rejects lone surrogates in strings and object keys per RFC 8785", () => {
      // Lone high surrogate \uD800
      expect(() => canonicalizeJson({ key: "prefix\uD800suffix" })).toThrow(/surrogate/i);
      // Lone low surrogate \uDFFF
      expect(() => canonicalizeJson({ key: "\uDFFF" })).toThrow(/surrogate/i);
      // Lone surrogate in object key
      expect(() => canonicalizeJson({ ["bad\uD800key"]: 123 })).toThrow(/surrogate/i);
      // Valid surrogate pair must NOT throw
      expect(() => canonicalizeJson({ key: "Valid \uD83D\uDE00 emoji" })).not.toThrow();
    });

    test("canonicalizeJson handles scientific floats and sorts keys by UTF-16 code units", () => {
      expect(canonicalizeJson(-0)).toBe("0");
      expect(canonicalizeJson({ zero: -0 })).toBe('{"zero":0}');
      const obj = { "\u00e9": 1, e: 2, E: 3, a: 4, "\u0100": 5 };
      const expected = '{"E":3,"a":4,"e":2,"\u00e9":1,"\u0100":5}';
      expect(canonicalizeJson(obj)).toBe(expected);
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
          const planId = "aaaaaaaa-1111-4111-8111-111111111111";
          const taskId = "bbbbbbbb-2222-4222-8222-222222222222";
          const planPayload = { name: "Atomic Plan", color_id: "green" };
          const taskPayload = { title: "Atomic Task", plan_id: planId };

          const persistRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: opId,
            commands: [{ root: { kind: "plan", id: planId }, action: "plan.create", payload: { data: planPayload } }],
            dependencies: [],
            editTime,
            recordOverlays: [
              { kind: "plan", id: planId, payload: planPayload },
              { kind: "work_item", id: taskId, payload: taskPayload },
            ],
          });

          if (!persistRes.ok) {
            gateway.close();
            closeDatabase(db);
            return {
              ok: false as const,
              error: persistRes.error.code,
              msg: persistRes.error.message,
              step: "persist",
            };
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
            const planReq = tx.objectStore(STORAGE_STORES.records).get([ownerId, "plan", planId]);
            const taskReq = tx.objectStore(STORAGE_STORES.records).get([ownerId, "work_item", taskId]);
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
          const getPlanRes = await gateway.getRecord<{ name: string; color_id: string }>(ctx, "plan", planId);
          const getTaskRes = await gateway.getRecord<{ title: string; plan_id: string }>(ctx, "work_item", taskId);

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

      if (!result.ok) throw new Error("ST-03 failed: " + JSON.stringify(result));
      expect(result.ok).toBe(true);

      expect(result.persistValue.operationId).toBe(opId);
      expect(result.persistValue.deviceSequence).toBe("1");
      expect(result.persistValue.durability).toBe("committed_to_indexeddb");

      // Verify raw store inspection
      const rawOutbox = result.storeInspection.outboxEntry as OutboxEntry;
      expect(rawOutbox).toBeDefined();
      expect(rawOutbox.owner_id).toBe(ownerId);
      expect(rawOutbox.operation_id).toBe(opId);
      expect(rawOutbox.device_sequence).toBe("1");
      expect(rawOutbox.status).toBe("queued");
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
      expect(result.taskData).toEqual({
        title: "Atomic Task",
        plan_id: "aaaaaaaa-1111-4111-8111-111111111111",
      });
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

          const p1Id = "11111111-1111-4111-8111-111111111111";
          const p2Id = "22222222-2222-4222-8222-222222222222";

          // 1. Commit initial operation to advance sequence to "1"
          const op1Res = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: op1,
            commands: [{ root: { kind: "plan", id: p1Id }, action: "plan.create", payload: { data: { name: "Original Plan", color_id: "green" } } }],
            dependencies: [],
            editTime,
            recordOverlays: [{ kind: "plan", id: p1Id, payload: { name: "Original Plan" } }],
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
            commands: [{ root: { kind: "plan", id: p2Id }, action: "plan.create", payload: { data: { name: "Aborted Plan", color_id: "green" } } }],
            dependencies: [],
            editTime,
            recordOverlays: [{ kind: "plan", id: p2Id, payload: { name: "Aborted Plan" } }],
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
            const p2Req = tx.objectStore(STORAGE_STORES.records).get([ownerId, "plan", p2Id]);
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

      if (!result.ok) throw new Error("ST-03 failed: " + JSON.stringify(result));
      expect(result.ok).toBe(true);

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
            const opId = `11111111-0000-4000-8000-00000000000${i}`;
            const res = await gateway.persistOperation({
              context: ctx,
              deviceId,
              operationId: opId,
              commands: [{ root: { kind: "plan", id: `33333333-0000-4000-8000-00000000000${i}` }, action: "plan.create", payload: { data: { name: `Tab1 Plan ${i}`, color_id: "green" } } }],
              dependencies: [],
              clockInput: { estimatedUtcMs: 1793140000000 + i * 10, rawWallMs: 1793140000000 + i * 10, calibrationId: calId },
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
            const opId = `22222222-0000-4000-8000-00000000000${i}`;
            const res = await gateway.persistOperation({
              context: ctx,
              deviceId,
              operationId: opId,
              commands: [{ root: { kind: "plan", id: `44444444-0000-4000-8000-00000000000${i}` }, action: "plan.create", payload: { data: { name: `Tab2 Plan ${i}`, color_id: "blue" } } }],
              dependencies: [],
              clockInput: { estimatedUtcMs: 1793140000000 + i * 10 + 5, rawWallMs: 1793140000000 + i * 10 + 5, calibrationId: calId },
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

          const planId = "aaaaaaaa-1111-4111-8111-111111111111";

          // 1. Initial write
          const firstRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: dupOpId,
            commands: [{ root: { kind: "plan", id: planId }, action: "plan.create", payload: { data: { name: "First Write", color_id: "green" } } }],
            dependencies: [],
            editTime,
            recordOverlays: [{ kind: "plan", id: planId, payload: { name: "First Write" } }],
          });

          // 2. Duplicate operation ID with different data
          const dupRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: dupOpId,
            commands: [{ root: { kind: "plan", id: planId }, action: "plan.create", payload: { data: { name: "Overwriting Attempt", color_id: "blue" } } }],
            dependencies: [],
            editTime,
            recordOverlays: [{ kind: "plan", id: planId, payload: { name: "Overwriting Attempt" } }],
          });

          // 3. Verify original plan record is still "First Write"
          const planRecord = await gateway.getRecord<{ name: string }>(ctx, "plan", planId);

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

      if (!result.ok) throw new Error("ST-03 failed: " + JSON.stringify(result));
      expect(result.ok).toBe(true);

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

          const planId = "aaaaaaaa-1111-4111-8111-111111111111";
          const editTime = advanceHlc(null, 1793140000000, calId);
          await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: opId,
            commands: [{ root: { kind: "plan", id: planId }, action: "plan.create", payload: { data: { name: "Persistent Plan", color_id: "green" } } }],
            dependencies: [],
            editTime,
            recordOverlays: [{ kind: "plan", id: planId, payload: { name: "Persistent Plan" } }],
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
          const planRecord = await gateway.getRecord<{ name: string }>(ctx, "plan", "aaaaaaaa-1111-4111-8111-111111111111");
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
            commands: [{ root: { kind: "plan", id: "00000000-0000-4000-8000-000000000001" }, action: "plan.create", payload: { data: { name: "Max Seq Plan", color_id: "green" } } }],
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
            commands: [{ root: { kind: "plan", id: "00000000-0000-4000-8000-000000000001" }, action: "plan.create", payload: { data: { name: "Max Seq Plan", color_id: "green" } } }],
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
            commands: [{ root: { kind: "plan", id: "00000000-0000-4000-8000-000000000001" }, action: "plan.create", payload: { data: { name: "Max Seq Plan", color_id: "green" } } }],
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

      if (!result.ok) throw new Error("ST-03 failed: " + JSON.stringify(result));
      expect(result.ok).toBe(true);

      expect(result.untrustedPersistOk).toBe(true);
      expect(result.untrustedStatus).toBe("time_invalid");
      expect(result.pendingCount).toBe(0); // Excluded from pending pull queue

      expect(result.malformedPersistOk).toBe(false);
      expect(result.malformedErrorCode).toBe("invalid_data");
    });
  });

  test.describe("Atomicity & In-Transaction Derivation Regressions", () => {
    test("concurrent persists with same wall-clock time derive strictly monotonic in-transaction HLCs (T.0, T.1)", async ({
      page,
    }) => {
      const script = buildStorageScript();
      await page.addInitScript(script);
      await page.goto("/work");

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, calId }) => {
          const {
            generateTestKey,
            openDatabase,
            closeDatabase,
            unlockOwner,
            persistOperationAtomic,
            STORAGE_STORES,
          } = window.__dayforge_storage_atomicity;

          const key = await generateTestKey();
          const dbRes = await openDatabase({ name: testDbName });
          if (!dbRes.ok) return { ok: false, error: "open failed" };
          const db = dbRes.value;

          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { ok: false, error: "unlock failed" };
          }
          const ctx = unlockRes.value;

          const fixedWallMs = 1793200000000;

          // Tab 1 persist with fixed wallMs
          const res1 = await persistOperationAtomic(db, {
            context: ctx,
            deviceId,
            operationId: "11111111-1111-4111-8111-111111111111",
            commands: [
              {
                root: { kind: "plan", id: "11111111-1111-4111-8111-111111111111" },
                action: "plan.create",
                payload: { data: { name: "Test 1", color_id: "green" } },
                precondition: null,
              },
            ],
            dependencies: [],
            clockInput: {
              wallMs: fixedWallMs,
              calibrationId: calId,
              quality: "calibrated",
            },
          });

          // Tab 2 persist with the exact same fixed wallMs
          const res2 = await persistOperationAtomic(db, {
            context: ctx,
            deviceId,
            operationId: "22222222-2222-4222-8222-222222222222",
            commands: [
              {
                root: { kind: "plan", id: "11111111-1111-4111-8111-111111111111" },
                action: "plan.replace",
                payload: { data: { name: "Test 2", color_id: "green" } },
                precondition: null,
              },
            ],
            dependencies: ["11111111-1111-4111-8111-111111111111"],
            clockInput: {
              wallMs: fixedWallMs,
              calibrationId: calId,
              quality: "calibrated",
            },
          });

          // Read persisted device metadata
          const devMeta = await new Promise<any>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.device_meta, "readonly");
            const req = tx.objectStore(STORAGE_STORES.device_meta).get([ownerId, deviceId]);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => resolve(null);
          });

          closeDatabase(db);

          return {
            ok: true,
            res1Ok: res1.ok,
            res2Ok: res2.ok,
            hlc1: res1.ok ? res1.value.allocatedHlc : null,
            hlc2: res2.ok ? res2.value.allocatedHlc : null,
            persistedLastHlc: devMeta?.last_hlc ?? null,
            lastSeq: devMeta?.last_sequence ?? null,
          };
        },
        {
          testDbName: `test-hlc-mono-${Date.now()}`,
          ownerId: "11111111-1111-4111-8111-111111111111",
          keyId: "key-1",
          deviceId: "22222222-2222-4222-8222-222222222222",
          calId: "33333333-3333-4333-8333-333333333333",
        }
      );

      expect(result.ok).toBe(true);
      expect(result.res1Ok).toBe(true);
      expect(result.res2Ok).toBe(true);
      expect(result.hlc1?.physical_ms).toBe(1793200000000);
      expect(result.hlc1?.logical).toBe(0);
      expect(result.hlc2?.physical_ms).toBe(1793200000000);
      expect(result.hlc2?.logical).toBe(1); // Increment logical counter for same wall time
      expect(result.persistedLastHlc?.logical).toBe(1);
      expect(result.lastSeq).toBe("2");
    });

    test("stale explicit editTime fails closed when persisted last_hlc is ahead", async ({
      page,
    }) => {
      const script = buildStorageScript();
      await page.addInitScript(script);
      await page.goto("/work");

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, calId }) => {
          const {
            generateTestKey,
            openDatabase,
            closeDatabase,
            unlockOwner,
            persistOperationAtomic,
            STORAGE_STORES,
          } = window.__dayforge_storage_atomicity;

          const key = await generateTestKey();
          const dbRes = await openDatabase({ name: testDbName });
          if (!dbRes.ok) return { ok: false, error: "open failed" };
          const db = dbRes.value;

          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { ok: false, error: "unlock failed" };
          }
          const ctx = unlockRes.value;

          // Pre-populate device_meta with a future HLC (physical: 2000000000000, logical: 5)
          await new Promise<void>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.device_meta, "readwrite");
            tx.objectStore(STORAGE_STORES.device_meta).put({
              owner_id: ownerId,
              device_id: deviceId,
              last_sequence: "5",
              last_hlc: {
                physical_ms: 2000000000000,
                logical: 5,
                calibration_id: calId,
                raw_wall_ms: 2000000000000,
                quality: "calibrated",
              },
            });
            tx.oncomplete = () => resolve();
          });

          // Attempt to persist an operation with a stale editTime (physical: 1900000000000)
          const staleRes = await persistOperationAtomic(db, {
            context: ctx,
            deviceId,
            operationId: "33333333-3333-4333-8333-333333333333",
            commands: [
              {
                root: { kind: "plan", id: "11111111-1111-4111-8111-111111111111" },
                action: "plan.create",
                payload: { data: { name: "Stale Plan", color_id: "green" } },
                precondition: null,
              },
            ],
            dependencies: [],
            editTime: {
              physical_ms: 1900000000000,
              logical: 0,
              calibration_id: calId,
              raw_wall_ms: 1900000000000,
              quality: "calibrated",
            },
          });

          closeDatabase(db);
          return {
            ok: true,
            staleOk: staleRes.ok,
            staleErrorCode: !staleRes.ok ? staleRes.error.code : null,
            staleErrorMessage: !staleRes.ok ? staleRes.error.message : null,
          };
        },
        {
          testDbName: `test-stale-hlc-${Date.now()}`,
          ownerId: "11111111-1111-4111-8111-111111111111",
          keyId: "key-1",
          deviceId: "22222222-2222-4222-8222-222222222222",
          calId: "33333333-3333-4333-8333-333333333333",
        }
      );

      expect(result.ok).toBe(true);
      expect(result.staleOk).toBe(false);
      expect(result.staleErrorCode).toBe("invalid_data");
      expect(result.staleErrorMessage).toContain("Stale HLC");
    });

    test("HLC logical overflow (0xffffffff) and sequence uint64 overflow fail closed with invalid_data", async ({
      page,
    }) => {
      const script = buildStorageScript();
      await page.addInitScript(script);
      await page.goto("/work");

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, calId }) => {
          const {
            advanceHlc,
            generateTestKey,
            openDatabase,
            closeDatabase,
            unlockOwner,
            persistOperationAtomic,
            STORAGE_STORES,
          } = window.__dayforge_storage_atomicity;

          // 1. Direct advanceHlc overflow test
          let overflowThrown = false;
          try {
            advanceHlc(
              {
                physical_ms: 1700000000000,
                logical: 0xffffffff,
                calibration_id: calId,
                raw_wall_ms: 1700000000000,
                quality: "calibrated",
              },
              1700000000000,
              calId,
              "calibrated"
            );
          } catch (e: any) {
            if (e?.code === "invalid_data") overflowThrown = true;
          }

          // 2. Corrupted last_sequence test
          const key = await generateTestKey();
          const dbRes = await openDatabase({ name: testDbName });
          if (!dbRes.ok) return { ok: false, error: "open failed" };
          const db = dbRes.value;

          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { ok: false, error: "unlock failed" };
          }
          const ctx = unlockRes.value;

          await new Promise<void>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.device_meta, "readwrite");
            tx.objectStore(STORAGE_STORES.device_meta).put({
              owner_id: ownerId,
              device_id: deviceId,
              last_sequence: "corrupted_non_numeric_seq",
            });
            tx.oncomplete = () => resolve();
          });

          const corruptRes = await persistOperationAtomic(db, {
            context: ctx,
            deviceId,
            operationId: "44444444-4444-4444-8444-444444444444",
            commands: [
              {
                root: { kind: "plan", id: "11111111-1111-4111-8111-111111111111" },
                action: "plan.create",
                payload: { data: { name: "Stale Plan", color_id: "green" } },
                precondition: null,
              },
            ],
            dependencies: [],
            clockInput: { wallMs: Date.now(), calibrationId: calId },
          });

          // 3. Uint64 overflow test
          await new Promise<void>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.device_meta, "readwrite");
            tx.objectStore(STORAGE_STORES.device_meta).put({
              owner_id: ownerId,
              device_id: deviceId,
              last_sequence: "18446744073709551615", // UINT64_MAX
            });
            tx.oncomplete = () => resolve();
          });

          const uint64OverflowRes = await persistOperationAtomic(db, {
            context: ctx,
            deviceId,
            operationId: "55555555-5555-4555-8555-555555555555",
            commands: [
              {
                root: { kind: "plan", id: "11111111-1111-4111-8111-111111111111" },
                action: "plan.create",
                payload: { data: { name: "Stale Plan", color_id: "green" } },
                precondition: null,
              },
            ],
            dependencies: [],
            clockInput: { wallMs: Date.now(), calibrationId: calId },
          });

          closeDatabase(db);

          return {
            ok: true,
            overflowThrown,
            corruptOk: corruptRes.ok,
            corruptErrorCode: !corruptRes.ok ? corruptRes.error.code : null,
            uint64OverflowOk: uint64OverflowRes.ok,
            uint64OverflowErrorCode: !uint64OverflowRes.ok ? uint64OverflowRes.error.code : null,
          };
        },
        {
          testDbName: `test-overflow-${Date.now()}`,
          ownerId: "11111111-1111-4111-8111-111111111111",
          keyId: "key-1",
          deviceId: "22222222-2222-4222-8222-222222222222",
          calId: "33333333-3333-4333-8333-333333333333",
        }
      );

      expect(result.ok).toBe(true);
      expect(result.overflowThrown).toBe(true);
      expect(result.corruptOk).toBe(false);
      expect(result.corruptErrorCode).toBe("invalid_data");
      expect(result.uint64OverflowOk).toBe(false);
      expect(result.uint64OverflowErrorCode).toBe("invalid_data");
    });

    test("outbox entry transitions to ack_waiting_pull via markOperationAcked and is deleted via markOperationSynced", async ({
      page,
    }) => {
      const script = buildStorageScript();
      await page.addInitScript(script);
      await page.goto("/work");

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, calId }) => {
          const {
            createLocalStorageGateway,
            openDatabase,
            closeDatabase,
            unlockOwner,
            generateTestKey,
            STORAGE_STORES,
          } = window.__dayforge_storage_atomicity;

          const key = await generateTestKey();
          const dbRes = await openDatabase({ name: testDbName });
          if (!dbRes.ok) return { ok: false, error: "open failed" };
          const db = dbRes.value;

          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { ok: false, error: "unlock failed" };
          }
          const ctx = unlockRes.value;

          const gateway = createLocalStorageGateway({ name: testDbName });
          const opId = "66666666-6666-4666-8666-666666666666";

          // 1. Persist operation -> starts in 'pending'
          const persistRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: opId,
            commands: [
              {
                root: { kind: "plan", id: "11111111-1111-4111-8111-111111111111" },
                action: "plan.create",
                payload: { data: { name: "Ack Plan", color_id: "green" } },
                precondition: null,
              },
            ],
            dependencies: [],
            clockInput: { wallMs: Date.now(), calibrationId: calId },
          });

          // 2. listPending returns it
          const pending1 = await gateway.listPending(ctx);

          // 3. Mark operation acked (server acknowledged receipt)
          const ackRes = await gateway.markOperationAcked(ctx, opId);

          // 4. Inspect status in IndexedDB: MUST be 'ack_waiting_pull'
          const rowAfterAck = await new Promise<any>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.operations, "readonly");
            const req = tx.objectStore(STORAGE_STORES.operations).get([ownerId, opId]);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => resolve(null);
          });

          // 5. listPending should NO LONGER return it (since status is ack_waiting_pull, not pending)
          const pending2 = await gateway.listPending(ctx);

          // 6. Confirm sync via markOperationSynced (after server pull confirms processed)
          const syncRes = await gateway.markOperationSynced(ctx, opId, rowAfterAck.request_hash);

          // 7. Inspect store: entry MUST be removed
          const rowAfterSync = await new Promise<any>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.operations, "readonly");
            const req = tx.objectStore(STORAGE_STORES.operations).get([ownerId, opId]);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => resolve(null);
          });

          gateway.close();
          closeDatabase(db);

          return {
            ok: true,
            persistOk: persistRes.ok,
            pending1Count: pending1.ok ? pending1.value.length : -1,
            ackOk: ackRes.ok,
            statusAfterAck: rowAfterAck?.status ?? null,
            pending2Count: pending2.ok ? pending2.value.length : -1,
            syncOk: syncRes.ok,
            rowAfterSyncIsNull: rowAfterSync === null,
          };
        },
        {
          testDbName: `test-outbox-lifecycle-${Date.now()}`,
          ownerId: "11111111-1111-4111-8111-111111111111",
          keyId: "key-1",
          deviceId: "22222222-2222-4222-8222-222222222222",
          calId: "33333333-3333-4333-8333-333333333333",
        }
      );

      expect(result.ok).toBe(true);
      expect(result.persistOk).toBe(true);
      expect(result.pending1Count).toBe(1);
      expect(result.ackOk).toBe(true);
      expect(result.statusAfterAck).toBe("ack_waiting_pull");
      expect(result.pending2Count).toBe(0);
      expect(result.syncOk).toBe(true);
      expect(result.rowAfterSyncIsNull).toBe(true);
    });

    test("calibrated offset preserves estimatedUtcMs and rawWallMs separately, and missing clock evidence fails closed", async ({
      page,
    }) => {
      const script = buildStorageScript();
      await page.addInitScript(script);
      await page.goto("/work");

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, calId }) => {
          const {
            createLocalStorageGateway,
            openDatabase,
            closeDatabase,
            unlockOwner,
            generateTestKey,
          } = window.__dayforge_storage_atomicity;

          const key = await generateTestKey();
          const dbRes = await openDatabase({ name: testDbName });
          if (!dbRes.ok) return { ok: false, error: "open failed" };
          const db = dbRes.value;

          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { ok: false, error: "unlock failed" };
          }
          const ctx = unlockRes.value;
          const gateway = createLocalStorageGateway({ name: testDbName });

          // 1. Calibrated clock input with distinct estimatedUtcMs and rawWallMs
          const op1Id = "11111111-1111-4111-8111-111111111111";
          const res1 = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: op1Id,
            commands: [
              {
                root: { kind: "plan", id: "22222222-2222-4222-8222-222222222222" },
                action: "plan.create",
                payload: { data: { name: "Offset Plan", color_id: "green" } },
              },
            ],
            dependencies: [],
            clockInput: {
              estimatedUtcMs: 1793150005000,
              rawWallMs: 1793150000000,
              calibrationId: calId,
              quality: "calibrated",
            },
          });

          // 2. Persist with missing clock evidence (neither clockInput nor editTime) -> MUST fail closed
          const op2Id = "33333333-3333-4333-8333-333333333333";
          const res2 = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: op2Id,
            commands: [
              {
                root: { kind: "plan", id: "22222222-2222-4222-8222-222222222222" },
                action: "plan.replace",
                payload: { data: { name: "No Evidence Plan", color_id: "green" } },
              },
            ],
            dependencies: [],
          });

          gateway.close();
          closeDatabase(db);

          return {
            ok: true,
            res1Ok: res1.ok,
            res1Physical: res1.ok ? res1.value.allocatedHlc.physical_ms : null,
            res1RawWall: res1.ok ? res1.value.allocatedHlc.raw_wall_ms : null,
            res2Ok: res2.ok,
            res2ErrorCode: !res2.ok ? res2.error.code : null,
          };
        },
        {
          testDbName: `test-clock-evidence-${Date.now()}`,
          ownerId: "11111111-1111-4111-8111-111111111111",
          keyId: "key-1",
          deviceId: "22222222-2222-4222-8222-222222222222",
          calId: "33333333-3333-4333-8333-333333333333",
        }
      );

      expect(result.ok).toBe(true);
      expect(result.res1Ok).toBe(true);
      expect(result.res1Physical).toBe(1793150005000);
      expect(result.res1RawWall).toBe(1793150000000);
      expect(result.res2Ok).toBe(false);
      expect(result.res2ErrorCode).toBe("invalid_data");
    });

    test("corrupted persisted last_hlc in device_meta fails closed with invalid_data", async ({
      page,
    }) => {
      const script = buildStorageScript();
      await page.addInitScript(script);
      await page.goto("/work");

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, calId }) => {
          const {
            createLocalStorageGateway,
            openDatabase,
            closeDatabase,
            unlockOwner,
            generateTestKey,
            STORAGE_STORES,
          } = window.__dayforge_storage_atomicity;

          const key = await generateTestKey();
          const dbRes = await openDatabase({ name: testDbName });
          if (!dbRes.ok) return { ok: false, error: "open failed" };
          const db = dbRes.value;

          // Seed device_meta with corrupted last_hlc
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORAGE_STORES.device_meta, "readwrite");
            tx.objectStore(STORAGE_STORES.device_meta).put({
              owner_id: ownerId,
              device_id: deviceId,
              last_sequence: "1",
              last_hlc: {
                physical_ms: -999, // corrupted negative physical_ms
                logical: 0,
                calibration_id: "not-a-uuid",
                raw_wall_ms: 0,
                quality: "calibrated",
              },
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });

          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { ok: false, error: "unlock failed" };
          }
          const ctx = unlockRes.value;
          const gateway = createLocalStorageGateway({ name: testDbName });

          const opId = "11111111-1111-4111-8111-111111111111";
          const res = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: opId,
            commands: [
              {
                root: { kind: "plan", id: "22222222-2222-4222-8222-222222222222" },
                action: "plan.create",
                payload: { data: { name: "Test Plan", color_id: "green" } },
              },
            ],
            dependencies: [],
            clockInput: {
              estimatedUtcMs: 1793150000000,
              calibrationId: calId,
              quality: "calibrated",
            },
          });

          gateway.close();
          closeDatabase(db);

          return {
            ok: true,
            persistOk: res.ok,
            errorCode: !res.ok ? res.error.code : null,
          };
        },
        {
          testDbName: `test-corrupt-hlc-${Date.now()}`,
          ownerId: "11111111-1111-4111-8111-111111111111",
          keyId: "key-1",
          deviceId: "22222222-2222-4222-8222-222222222222",
          calId: "33333333-3333-4333-8333-333333333333",
        }
      );

      expect(result.ok).toBe(true);
      expect(result.persistOk).toBe(false);
      expect(result.errorCode).toBe("invalid_data");
    });

    test("T03 command contract: rejects zero commands, invalid UUIDs, unsupported root kind/action, and unknown precondition keys", async ({
      page,
    }) => {
      const script = buildStorageScript();
      await page.addInitScript(script);
      await page.goto("/work");

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, calId }) => {
          const {
            createLocalStorageGateway,
            openDatabase,
            closeDatabase,
            unlockOwner,
            generateTestKey,
          } = window.__dayforge_storage_atomicity;

          const key = await generateTestKey();
          const dbRes = await openDatabase({ name: testDbName });
          if (!dbRes.ok) return { ok: false, error: "open failed" };
          const db = dbRes.value;

          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { ok: false, error: "unlock failed" };
          }
          const ctx = unlockRes.value;
          const gateway = createLocalStorageGateway({ name: testDbName });

          const baseClock = {
            estimatedUtcMs: 1793150000000,
            calibrationId: calId,
            quality: "calibrated" as const,
          };
          const validPlanId = "22222222-2222-4222-8222-222222222222";

          // 1. Zero commands -> rejected
          const zeroRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-1111-4111-8111-111111111111",
            commands: [],
            dependencies: [],
            clockInput: baseClock,
          });

          // 2. Invalid operationId UUID -> rejected
          const badOpIdRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "not-a-valid-uuid",
            commands: [
              { root: { kind: "plan", id: validPlanId }, action: "plan.create", payload: {} },
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          // 3. Unsupported root kind ("task" or arbitrary string) -> rejected
          const badKindRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "33333333-3333-4333-8333-333333333333",
            commands: [
              { root: { kind: "unsupported_kind" as any, id: validPlanId }, action: "plan.create", payload: {} },
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          // 4. Unsupported action -> rejected
          const badActionRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "44444444-4444-4444-8444-444444444444",
            commands: [
              { root: { kind: "plan", id: validPlanId }, action: "invalid.action.custom", payload: {} },
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          // 5. Unknown precondition keys -> rejected
          const badPrecondRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "55555555-5555-4555-8555-555555555555",
            commands: [
              {
                root: { kind: "plan", id: validPlanId },
                action: "plan.create",
                payload: { data: { name: "Stale Plan", color_id: "green" } },
                precondition: { unknown_property_forbidden: "value" } as any,
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          gateway.close();
          closeDatabase(db);

          return {
            ok: true,
            zeroOk: zeroRes.ok,
            zeroCode: !zeroRes.ok ? zeroRes.error.code : null,
            badOpIdOk: badOpIdRes.ok,
            badOpIdCode: !badOpIdRes.ok ? badOpIdRes.error.code : null,
            badKindOk: badKindRes.ok,
            badKindCode: !badKindRes.ok ? badKindRes.error.code : null,
            badActionOk: badActionRes.ok,
            badActionCode: !badActionRes.ok ? badActionRes.error.code : null,
            badPrecondOk: badPrecondRes.ok,
            badPrecondCode: !badPrecondRes.ok ? badPrecondRes.error.code : null,
          };
        },
        {
          testDbName: `test-t03-command-contract-${Date.now()}`,
          ownerId: "11111111-1111-4111-8111-111111111111",
          keyId: "key-1",
          deviceId: "22222222-2222-4222-8222-222222222222",
          calId: "33333333-3333-4333-8333-333333333333",
        }
      );

      expect(result.ok).toBe(true);
      expect(result.zeroOk).toBe(false);
      expect(result.zeroCode).toBe("invalid_data");
      expect(result.badOpIdOk).toBe(false);
      expect(result.badOpIdCode).toBe("invalid_data");
      expect(result.badKindOk).toBe(false);
      expect(result.badKindCode).toBe("invalid_data");
      expect(result.badActionOk).toBe(false);
      expect(result.badActionCode).toBe("invalid_data");
      expect(result.badPrecondOk).toBe(false);
      expect(result.badPrecondCode).toBe("invalid_data");
    });

    test("outbox transitions: markOperationSynced before ACK is rejected, and wrong request_hash cannot delete row", async ({
      page,
    }) => {
      const script = buildStorageScript();
      await page.addInitScript(script);
      await page.goto("/work");

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, calId }) => {
          const {
            createLocalStorageGateway,
            openDatabase,
            closeDatabase,
            unlockOwner,
            generateTestKey,
            STORAGE_STORES,
          } = window.__dayforge_storage_atomicity;

          const key = await generateTestKey();
          const dbRes = await openDatabase({ name: testDbName });
          if (!dbRes.ok) return { ok: false, error: "open failed" };
          const db = dbRes.value;

          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { ok: false, error: "unlock failed" };
          }
          const ctx = unlockRes.value;
          const gateway = createLocalStorageGateway({ name: testDbName });

          const opId = "66666666-6666-4666-8666-666666666666";

          // 1. Persist operation -> starts in 'queued'
          const persistRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: opId,
            commands: [
              {
                root: { kind: "plan", id: "11111111-1111-4111-8111-111111111111" },
                action: "plan.create",
                payload: { data: { name: "Test Plan", color_id: "green" } },
              },
            ],
            dependencies: [],
            clockInput: { estimatedUtcMs: Date.now(), calibrationId: calId },
          });

          // 2. Attempt markOperationSynced before ACK -> MUST fail closed
          const dummyHash = "0000000000000000000000000000000000000000000000000000000000000000";
          const prematureSyncRes = await gateway.markOperationSynced(ctx, opId, dummyHash);

          // 3. Mark ACK -> transitions to ack_waiting_pull
          const ackRes = await gateway.markOperationAcked(ctx, opId);

          // 4. Attempt markOperationSynced with WRONG request_hash -> MUST fail closed with integrity_failed
          const wrongHash = "0000000000000000000000000000000000000000000000000000000000000000";
          const wrongHashSyncRes = await gateway.markOperationSynced(ctx, opId, wrongHash);

          // Verify row STILL exists in outbox
          const rowStillThere = await new Promise<any>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.operations, "readonly");
            const req = tx.objectStore(STORAGE_STORES.operations).get([ownerId, opId]);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => resolve(null);
          });

          // 5. Successful sync with correct request_hash (or omitted hash)
          const correctSyncRes = await gateway.markOperationSynced(ctx, opId, rowStillThere.request_hash);

          // Verify row is now deleted
          const rowAfterSync = await new Promise<any>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.operations, "readonly");
            const req = tx.objectStore(STORAGE_STORES.operations).get([ownerId, opId]);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => resolve(null);
          });

          gateway.close();
          closeDatabase(db);

          return {
            ok: true,
            persistOk: persistRes.ok,
            prematureSyncOk: prematureSyncRes.ok,
            prematureSyncCode: !prematureSyncRes.ok ? prematureSyncRes.error.code : null,
            ackOk: ackRes.ok,
            wrongHashSyncOk: wrongHashSyncRes.ok,
            wrongHashSyncCode: !wrongHashSyncRes.ok ? wrongHashSyncRes.error.code : null,
            rowStillExistsAfterWrongHash: rowStillThere !== null,
            correctSyncOk: correctSyncRes.ok,
            rowDeletedAfterCorrectSync: rowAfterSync === null,
          };
        },
        {
          testDbName: `test-transitions-guards-${Date.now()}`,
          ownerId: "11111111-1111-4111-8111-111111111111",
          keyId: "key-1",
          deviceId: "22222222-2222-4222-8222-222222222222",
          calId: "33333333-3333-4333-8333-333333333333",
        }
      );

      expect(result.ok).toBe(true);
      expect(result.persistOk).toBe(true);
      expect(result.prematureSyncOk).toBe(false);
      expect(result.prematureSyncCode).toBe("invalid_data");
      expect(result.ackOk).toBe(true);
      expect(result.wrongHashSyncOk).toBe(false);
      expect(result.wrongHashSyncCode).toBe("integrity_failed");
      expect(result.rowStillExistsAfterWrongHash).toBe(true);
      expect(result.correctSyncOk).toBe(true);
      expect(result.rowDeletedAfterCorrectSync).toBe(true);
    });

    test("T03 schema parity: rejects wrong root/action pair, missing payload.data, extra properties, non-canonical UUID, invalid set_order guards, mixed undo, mandatory sync hash, and fractional clock", async ({
      page,
    }) => {
      const script = buildStorageScript();
      await page.addInitScript(script);
      await page.goto("/work");

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, calId }) => {
          const {
            createLocalStorageGateway,
            openDatabase,
            closeDatabase,
            unlockOwner,
            generateTestKey,
            validateHlc,
            advanceHlc,
            StorageError,
          } = window.__dayforge_storage_atomicity;

          const key = await generateTestKey();
          const dbRes = await openDatabase({ name: testDbName });
          if (!dbRes.ok) return { ok: false, error: "open failed" };
          const db = dbRes.value;

          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) {
            closeDatabase(db);
            return { ok: false, error: "unlock failed" };
          }
          const ctx = unlockRes.value;
          const gateway = createLocalStorageGateway({ name: testDbName });

          const baseClock = {
            estimatedUtcMs: 1793150000000,
            calibrationId: calId,
            quality: "calibrated" as const,
          };
          const validPlanId = "22222222-2222-4222-8222-222222222222";
          const validTaskId = "33333333-3333-4333-8333-333333333333";
          const dummyHash64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

          // 1. Wrong root/action pair: root kind "plan", action "occurrence.replace" -> rejected
          const wrongRootActionRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-0001-4000-8000-000000000001",
            commands: [
              {
                root: { kind: "plan", id: validPlanId },
                action: "occurrence.replace" as any,
                payload: { data: { name: "Test Plan", color_id: "green" } },
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          // 2. Missing plan.create.payload.data -> rejected
          const missingDataRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-0002-4000-8000-000000000002",
            commands: [
              {
                root: { kind: "plan", id: validPlanId },
                action: "plan.create",
                payload: { name: "No Data Wrapper" } as any,
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          // 3. Extra nested properties in payload (additionalProperties: false) -> rejected
          const extraPropertyRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-0003-4000-8000-000000000003",
            commands: [
              {
                root: { kind: "plan", id: validPlanId },
                action: "plan.create",
                payload: {
                  data: { name: "Test Plan", color_id: "green", forbidden_extra: true },
                } as any,
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          // 4. Non-canonical UUIDs -> rejected
          // 4a. Uppercase UUID
          const uppercaseUuidRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-0004-4000-8000-000000000004",
            commands: [
              {
                root: { kind: "plan", id: "22222222-2222-4222-8222-22222222222A" },
                action: "plan.create",
                payload: { data: { name: "Test Plan", color_id: "green" } },
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });
          // 4b. Non-v4/v5 (v1 UUID)
          const v1UuidRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-0004-4000-8000-000000000005",
            commands: [
              {
                root: { kind: "plan", id: "22222222-2222-1222-8222-222222222222" },
                action: "plan.create",
                payload: { data: { name: "Test Plan", color_id: "green" } },
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });
          // 4c. Non-canonical variant (nibble '0' instead of 8,9,a,b)
          const badVariantUuidRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-0004-4000-8000-000000000006",
            commands: [
              {
                root: { kind: "plan", id: "22222222-2222-4222-0222-222222222222" },
                action: "plan.create",
                payload: { data: { name: "Test Plan", color_id: "green" } },
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          // 5. Invalid set_order guards
          // 5a. set_order missing expected_root_hash
          const setOrderMissingHashRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-0005-4000-8000-000000000007",
            commands: [
              {
                root: { kind: "work_item", id: validTaskId },
                action: "set_order",
                payload: {
                  target: { kind: "single" },
                  order_key: "100",
                  intent: "user_reorder",
                },
                precondition: {
                  expected_bucket: { date: "2026-10-31", period: "morning", order_hash: dummyHash64 },
                } as any,
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });
          // 5b. set_order with expected_root_hash but operation missing expected_bucket
          const setOrderMissingBucketRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-0005-4000-8000-000000000008",
            commands: [
              {
                root: { kind: "work_item", id: validTaskId },
                action: "set_order",
                payload: {
                  target: { kind: "single" },
                  order_key: "100",
                  intent: "user_reorder",
                },
                precondition: { expected_root_hash: dummyHash64 },
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });
          // 5c. Valid set_order with both guards
          const validSetOrderRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-0005-4000-8000-000000000009",
            commands: [
              {
                root: { kind: "work_item", id: validTaskId },
                action: "set_order",
                payload: {
                  target: { kind: "single" },
                  order_key: "100",
                  intent: "user_reorder",
                },
                precondition: {
                  expected_root_hash: dummyHash64,
                  expected_bucket: { date: "2026-10-31", period: "morning", order_hash: dummyHash64 },
                },
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          // 6. Solitary undo requirement
          const validUndoPayload = {
            original_operation_id: "11111111-0005-4000-8000-000000000009",
            expected_states: [
              {
                root: { kind: "work_item", id: validTaskId },
                hash: dummyHash64,
              },
            ],
          };
          // 6a. undo combined with another command -> rejected
          const mixedUndoRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-0006-4000-8000-00000000000a",
            commands: [
              {
                root: { kind: "plan", id: validPlanId },
                action: "undo",
                payload: validUndoPayload,
              },
              {
                root: { kind: "plan", id: validPlanId },
                action: "plan.replace",
                payload: { data: { name: "Test Plan 2", color_id: "green" } },
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });
          // 6b. Single undo command -> succeeds
          const singleUndoRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-0006-4000-8000-00000000000b",
            commands: [
              {
                root: { kind: "plan", id: validPlanId },
                action: "undo",
                payload: validUndoPayload,
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          // 7. markOperationSynced mandatory hash validation
          // Setup an op waiting for pull
          await gateway.markOperationAcked(ctx, "11111111-0006-4000-8000-00000000000b");
          const syncUndefinedHash = await gateway.markOperationSynced(ctx, "11111111-0006-4000-8000-00000000000b", undefined as any);
          const syncShortHash = await gateway.markOperationSynced(ctx, "11111111-0006-4000-8000-00000000000b", "not-a-hash");
          const syncUpperHash = await gateway.markOperationSynced(ctx, "11111111-0006-4000-8000-00000000000b", "A".repeat(64));

          // 8. Strict HLC validation: fractional raw_wall_ms and non-canonical calibration_id
          const fractionalRawWallRejected = !validateHlc({
            physical_ms: 1793150000000,
            logical: 0,
            calibration_id: calId,
            raw_wall_ms: 1793150000000.5,
            quality: "calibrated",
          });

          const badCalIdRejected = !validateHlc({
            physical_ms: 1793150000000,
            logical: 0,
            calibration_id: "UPPERCASE-CALIB-0000-0000-000000000000",
            raw_wall_ms: 1793150000000,
            quality: "calibrated",
          });

          let fractionalAdvanceRejected = false;
          try {
            advanceHlc(null, 1793150000000.5, calId, "calibrated");
          } catch (e: any) {
            fractionalAdvanceRejected = e instanceof StorageError && e.code === "invalid_data";
          }

          gateway.close();
          closeDatabase(db);

          return {
            ok: true,
            wrongRootActionOk: wrongRootActionRes.ok,
            wrongRootActionCode: !wrongRootActionRes.ok ? wrongRootActionRes.error.code : null,
            missingDataOk: missingDataRes.ok,
            missingDataCode: !missingDataRes.ok ? missingDataRes.error.code : null,
            extraPropertyOk: extraPropertyRes.ok,
            extraPropertyCode: !extraPropertyRes.ok ? extraPropertyRes.error.code : null,
            uppercaseUuidOk: uppercaseUuidRes.ok,
            uppercaseUuidCode: !uppercaseUuidRes.ok ? uppercaseUuidRes.error.code : null,
            v1UuidOk: v1UuidRes.ok,
            v1UuidCode: !v1UuidRes.ok ? v1UuidRes.error.code : null,
            badVariantUuidOk: badVariantUuidRes.ok,
            badVariantUuidCode: !badVariantUuidRes.ok ? badVariantUuidRes.error.code : null,
            setOrderMissingHashOk: setOrderMissingHashRes.ok,
            setOrderMissingHashCode: !setOrderMissingHashRes.ok ? setOrderMissingHashRes.error.code : null,
            setOrderMissingBucketOk: setOrderMissingBucketRes.ok,
            setOrderMissingBucketCode: !setOrderMissingBucketRes.ok ? setOrderMissingBucketRes.error.code : null,
            validSetOrderOk: validSetOrderRes.ok,
            mixedUndoOk: mixedUndoRes.ok,
            mixedUndoCode: !mixedUndoRes.ok ? mixedUndoRes.error.code : null,
            singleUndoOk: singleUndoRes.ok,
            syncUndefinedHashOk: syncUndefinedHash.ok,
            syncUndefinedHashCode: !syncUndefinedHash.ok ? syncUndefinedHash.error.code : null,
            syncShortHashOk: syncShortHash.ok,
            syncShortHashCode: !syncShortHash.ok ? syncShortHash.error.code : null,
            syncUpperHashOk: syncUpperHash.ok,
            syncUpperHashCode: !syncUpperHash.ok ? syncUpperHash.error.code : null,
            fractionalRawWallRejected,
            badCalIdRejected,
            fractionalAdvanceRejected,
          };
        },
        {
          testDbName: `test-schema-parity-${Date.now()}`,
          ownerId: "11111111-1111-4111-8111-111111111111",
          keyId: "key-1",
          deviceId: "22222222-2222-4222-8222-222222222222",
          calId: "33333333-3333-4333-8333-333333333333",
        }
      );

      expect(result.ok).toBe(true);
      expect(result.wrongRootActionOk).toBe(false);
      expect(result.wrongRootActionCode).toBe("invalid_data");
      expect(result.missingDataOk).toBe(false);
      expect(result.missingDataCode).toBe("invalid_data");
      expect(result.extraPropertyOk).toBe(false);
      expect(result.extraPropertyCode).toBe("invalid_data");
      expect(result.uppercaseUuidOk).toBe(false);
      expect(result.uppercaseUuidCode).toBe("invalid_data");
      expect(result.v1UuidOk).toBe(false);
      expect(result.v1UuidCode).toBe("invalid_data");
      expect(result.badVariantUuidOk).toBe(false);
      expect(result.badVariantUuidCode).toBe("invalid_data");
      expect(result.setOrderMissingHashOk).toBe(false);
      expect(result.setOrderMissingHashCode).toBe("invalid_data");
      expect(result.setOrderMissingBucketOk).toBe(false);
      expect(result.setOrderMissingBucketCode).toBe("invalid_data");
      expect(result.validSetOrderOk).toBe(true);
      expect(result.mixedUndoOk).toBe(false);
      expect(result.mixedUndoCode).toBe("invalid_data");
      expect(result.singleUndoOk).toBe(true);
      expect(result.syncUndefinedHashOk).toBe(false);
      expect(result.syncUndefinedHashCode).toBe("invalid_data");
      expect(result.syncShortHashOk).toBe(false);
      expect(result.syncShortHashCode).toBe("invalid_data");
      expect(result.syncUpperHashOk).toBe(false);
      expect(result.syncUpperHashCode).toBe("invalid_data");
      expect(result.fractionalRawWallRejected).toBe(true);
      expect(result.badCalIdRejected).toBe(true);
      expect(result.fractionalAdvanceRejected).toBe(true);
    });
  });
});

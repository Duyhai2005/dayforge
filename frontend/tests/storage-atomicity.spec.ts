import { expect, test } from "@playwright/test";
import { buildStorageBrowserHarness } from "./helpers/storage-browser-harness";
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
  decryptPayload,
  encryptPayload,
  listOutboxForReplay,
  type OperationEnvelope,
  type OutboxEntry,
  type OutboxStatus,
  type PersistOperationInput,
  type PersistOperationResult,
  persistOperationAtomic,
  isCanonicalLocalDate,
  isCanonicalInt64,
  MAX_OPERATION_WIRE_BYTES,
  assertOperationWireSize,
  createLocalStorageGateway,
  type LocalStorageGateway,
} from "./storage-api";

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
      decryptPayload: typeof decryptPayload;
      encryptPayload: typeof encryptPayload;
      listOutboxForReplay: typeof listOutboxForReplay;
      persistOperationAtomic: typeof persistOperationAtomic;
      createLocalStorageGateway: typeof createLocalStorageGateway;
      isCanonicalLocalDate: typeof isCanonicalLocalDate;
      isCanonicalInt64: typeof isCanonicalInt64;
    };
  }
}

function buildStorageScript(): string {
  return buildStorageBrowserHarness("__dayforge_storage_atomicity");
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
      const hlc2 = advanceHlc(hlc1, 950, calId, "calibrated");
      expect(hlc2.physical_ms).toBe(1000);
      expect(hlc2.logical).toBe(1);

      // Same wall clock: physical remains, logical increments
      const hlc3 = advanceHlc(hlc2, 1000, calId, "calibrated");
      expect(hlc3.physical_ms).toBe(1000);
      expect(hlc3.logical).toBe(2);

      // Forward wall clock: physical advances, logical resets to 0
      const hlc4 = advanceHlc(hlc3, 1500, calId, "calibrated");
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
            isCanonicalLocalDate,
  isCanonicalInt64,
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
            commands: [{ root: { kind: "plan", id: planId }, action: "plan.create", payload: { data: planPayload }, precondition: null }],
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
          const pendingRes = await gateway.listSendableOperations(ctx);
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
            isCanonicalLocalDate,
  isCanonicalInt64,
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
            commands: [{ root: { kind: "plan", id: p1Id }, action: "plan.create", payload: { data: { name: "Original Plan", color_id: "green" } }, precondition: null }],
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
            commands: [{ root: { kind: "plan", id: p2Id }, action: "plan.create", payload: { data: { name: "Aborted Plan", color_id: "green" } }, precondition: null }],
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
              commands: [{ root: { kind: "plan", id: `33333333-0000-4000-8000-00000000000${i}` }, action: "plan.create", payload: { data: { name: `Tab1 Plan ${i}`, color_id: "green" } }, precondition: null }],
              dependencies: [],
              clockInput: { estimatedUtcMs: 1793140000000 + i * 10, rawWallMs: 1793140000000 + i * 10, calibrationId: calId, quality: "calibrated" },
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
              commands: [{ root: { kind: "plan", id: `44444444-0000-4000-8000-00000000000${i}` }, action: "plan.create", payload: { data: { name: `Tab2 Plan ${i}`, color_id: "blue" } }, precondition: null }],
              dependencies: [],
              clockInput: { estimatedUtcMs: 1793140000000 + i * 10 + 5, rawWallMs: 1793140000000 + i * 10 + 5, calibrationId: calId, quality: "calibrated" },
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
            isCanonicalLocalDate,
  isCanonicalInt64,
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

          const editTime = advanceHlc(null, 1793140000000, calId, "calibrated");

          const planId = "aaaaaaaa-1111-4111-8111-111111111111";

          // 1. Initial write
          const firstRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: dupOpId,
            commands: [{ root: { kind: "plan", id: planId }, action: "plan.create", payload: { data: { name: "First Write", color_id: "green" } }, precondition: null }],
            dependencies: [],
            editTime,
            recordOverlays: [{ kind: "plan", id: planId, payload: { name: "First Write" } }],
          });

          // 2. Duplicate operation ID with different data
          const dupRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: dupOpId,
            commands: [{ root: { kind: "plan", id: planId }, action: "plan.create", payload: { data: { name: "Overwriting Attempt", color_id: "blue" } }, precondition: null }],
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
            isCanonicalLocalDate,
  isCanonicalInt64,
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
          const editTime = advanceHlc(null, 1793140000000, calId, "calibrated");
          await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: opId,
            commands: [{ root: { kind: "plan", id: planId }, action: "plan.create", payload: { data: { name: "Persistent Plan", color_id: "green" } }, precondition: null }],
            dependencies: [],
            editTime,
            recordOverlays: [{ kind: "plan", id: planId, payload: { name: "Persistent Plan" } }],
          });

          const pending = await gateway.listSendableOperations(ctx);
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

          const pending = await gateway.listSendableOperations(ctx);
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
            isCanonicalLocalDate,
  isCanonicalInt64,
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

          const editTime = advanceHlc(null, 1793140000000, calId, "calibrated");
          const persistRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: opId,
            commands: [{ root: { kind: "plan", id: "00000000-0000-4000-8000-000000000001" }, action: "plan.create", payload: { data: { name: "Max Seq Plan", color_id: "green" } }, precondition: null }],
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
            isCanonicalLocalDate,
  isCanonicalInt64,
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
            commands: [{ root: { kind: "plan", id: "00000000-0000-4000-8000-000000000001" }, action: "plan.create", payload: { data: { name: "Max Seq Plan", color_id: "green" } }, precondition: null }],
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
            commands: [{ root: { kind: "plan", id: "00000000-0000-4000-8000-000000000001" }, action: "plan.create", payload: { data: { name: "Max Seq Plan", color_id: "green" } }, precondition: null }],
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
          const pendingRes = await gateway.listSendableOperations(ctx);

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
            clockInput: { wallMs: Date.now(), calibrationId: calId, quality: "calibrated" },
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
            clockInput: { wallMs: Date.now(), calibrationId: calId, quality: "calibrated" },
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
            isCanonicalLocalDate,
  isCanonicalInt64,
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
            clockInput: { wallMs: Date.now(), calibrationId: calId, quality: "calibrated" },
          });

          // 2. listPending returns it
          const pending1 = await gateway.listSendableOperations(ctx);

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
          const pending2 = await gateway.listSendableOperations(ctx);

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
            isCanonicalLocalDate,
  isCanonicalInt64,
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
          await gateway.open();

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
                precondition: null,
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
                precondition: null,
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
            isCanonicalLocalDate,
  isCanonicalInt64,
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
          await gateway.open();

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
                precondition: null,
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
            isCanonicalLocalDate,
  isCanonicalInt64,
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
          await gateway.open();

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
              { root: { kind: "plan", id: validPlanId }, action: "plan.create", payload: {}, precondition: null },
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
              { root: { kind: "unsupported_kind" as any, id: validPlanId }, action: "plan.create", payload: {}, precondition: null },
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
              { root: { kind: "plan", id: validPlanId }, action: "invalid.action.custom", payload: {}, precondition: null },
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
            isCanonicalLocalDate,
  isCanonicalInt64,
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
          await gateway.open();

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
                precondition: null,
              },
            ],
            dependencies: [],
            clockInput: { estimatedUtcMs: Date.now(), calibrationId: calId, quality: "calibrated" },
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
            isCanonicalLocalDate,
  isCanonicalInt64,
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
          await gateway.open();

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
                precondition: null,
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
                precondition: null,
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
                precondition: null,
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
                precondition: null,
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
                precondition: null,
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
                precondition: null,
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
                precondition: null,
              },
              {
                root: { kind: "plan", id: validPlanId },
                action: "plan.replace",
                payload: { data: { name: "Test Plan 2", color_id: "green" } },
                precondition: null,
              },
            ],
            dependencies: [validUndoPayload.original_operation_id],
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
                precondition: null,
              },
            ],
            dependencies: [validUndoPayload.original_operation_id],
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

    test("isCanonicalLocalDate correctly validates Gregorian calendar semantic rules", () => {
      // Leap year calculations
      expect(isCanonicalLocalDate("2024-02-29")).toBe(true);
      expect(isCanonicalLocalDate("2000-02-29")).toBe(true);
      expect(isCanonicalLocalDate("2025-02-29")).toBe(false);
      expect(isCanonicalLocalDate("1900-02-29")).toBe(false);
      expect(isCanonicalLocalDate("2026-02-30")).toBe(false);

      // Month bounds & 30-day months
      expect(isCanonicalLocalDate("2026-04-30")).toBe(true);
      expect(isCanonicalLocalDate("2026-04-31")).toBe(false);
      expect(isCanonicalLocalDate("2026-06-31")).toBe(false);
      expect(isCanonicalLocalDate("2026-09-31")).toBe(false);
      expect(isCanonicalLocalDate("2026-11-31")).toBe(false);

      // Boundaries & format
      expect(isCanonicalLocalDate("0001-01-01")).toBe(true);
      expect(isCanonicalLocalDate("9999-12-31")).toBe(true);
      expect(isCanonicalLocalDate("0000-01-01")).toBe(false);
      expect(isCanonicalLocalDate("2026-00-10")).toBe(false);
      expect(isCanonicalLocalDate("2026-13-01")).toBe(false);
      expect(isCanonicalLocalDate("2026-10-00")).toBe(false);
      expect(isCanonicalLocalDate("2026-10-32")).toBe(false);
      expect(isCanonicalLocalDate("2026/10/31")).toBe(false);
      expect(isCanonicalLocalDate("")).toBe(false);
      expect(isCanonicalLocalDate(null as any)).toBe(false);
    });

    test("isCanonicalInt64 correctly enforces signed 64-bit integer range [-2^63, 2^63 - 1]", () => {
      // Boundaries
      expect(isCanonicalInt64("-9223372036854775808")).toBe(true);
      expect(isCanonicalInt64("9223372036854775807")).toBe(true);
      expect(isCanonicalInt64("0")).toBe(true);
      expect(isCanonicalInt64("-1")).toBe(true);
      expect(isCanonicalInt64("100")).toBe(true);

      // Out of bounds
      expect(isCanonicalInt64("-9223372036854775809")).toBe(false);
      expect(isCanonicalInt64("9223372036854775808")).toBe(false);
      expect(isCanonicalInt64("18446744073709551615")).toBe(false);

      // Format constraints
      expect(isCanonicalInt64("01")).toBe(false);
      expect(isCanonicalInt64("-0")).toBe(false);
      expect(isCanonicalInt64("+5")).toBe(false);
      expect(isCanonicalInt64("1.5")).toBe(false);
      expect(isCanonicalInt64("abc")).toBe(false);
      expect(isCanonicalInt64("")).toBe(false);
      expect(isCanonicalInt64(" 10 ")).toBe(false);
      expect(isCanonicalInt64(null as any)).toBe(false);
    });

    test("T03 Precondition & Semantic Invariants (F02, F03, F04, F06) in browser engine", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });

      const testDbName = `test-invariants-${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-inv-1";
      const deviceId = "22222222-2222-4222-8222-222222222222";
      const calId = "33333333-3333-4333-8333-333333333333";
      const dummyHash = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, deviceId, calId, dummyHash }) => {
          const {
            openDatabase,
            closeDatabase,
            generateTestKey,
            unlockOwner,
            createLocalStorageGateway,
          } = window.__dayforge_storage_atomicity;

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
          await gateway.open();
          const baseClock = { estimatedUtcMs: 1793150000000, calibrationId: calId, quality: "calibrated" as const };
          const validPlanId = "22222222-2222-4222-8222-222222222222";
          const validTaskId = "33333333-3333-4333-8333-333333333333";

          // 1. Missing precondition property -> rejected
          const missingPreconditionRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-1001-4000-8000-000000000001",
            commands: [
              {
                root: { kind: "plan", id: validPlanId },
                action: "plan.create",
                payload: { data: { name: "Plan", color_id: "green" } },
              } as any,
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          // 2. Precondition: undefined -> rejected
          const undefinedPreconditionRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-1002-4000-8000-000000000002",
            commands: [
              {
                root: { kind: "plan", id: validPlanId },
                action: "plan.create",
                payload: { data: { name: "Plan", color_id: "green" } },
                precondition: undefined,
              } as any,
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          // 3. Precondition: {} empty object -> rejected
          const emptyPreconditionRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-1003-4000-8000-000000000003",
            commands: [
              {
                root: { kind: "plan", id: validPlanId },
                action: "plan.create",
                payload: { data: { name: "Plan", color_id: "green" } },
                precondition: {} as any,
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          // 4. set_order with precondition: null -> rejected
          const setOrderNullPreconditionRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-1004-4000-8000-000000000004",
            commands: [
              {
                root: { kind: "work_item", id: validTaskId },
                action: "set_order",
                payload: {
                  target: { kind: "single" },
                  order_key: "100",
                  intent: "user_reorder",
                },
                precondition: null as any,
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          // 5. Invalid Gregorian date in milestone.create -> rejected
          const badDateMilestoneRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-1005-4000-8000-000000000005",
            commands: [
              {
                root: { kind: "milestone", id: "44444444-4444-4444-8444-444444444444" },
                action: "milestone.create",
                payload: {
                  data: {
                    title: "Bad Date",
                    date: "2026-02-30",
                    period: null,
                    note: null,
                    plan_id: null,
                    standalone_color_id: "green",
                    show_in_work_calendar: false,
                  },
                },
                precondition: null,
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          // 6. Invalid OrderKey int64 out-of-bounds -> rejected
          const badOrderKeyRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-1006-4000-8000-000000000006",
            commands: [
              {
                root: { kind: "work_item", id: validTaskId },
                action: "work_item.create_single",
                payload: {
                  data: {
                    title: "Bad OrderKey",
                    date: "2026-10-31",
                    period: "morning",
                    duration_minutes: 30,
                    plan_id: validPlanId,
                    standalone_color_id: "green",
                    status: "pending",
                    order_key: "9223372036854775808",
                  },
                },
                precondition: null,
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          // 7. Unsorted weekdays in recurrence -> rejected
          const unsortedWeekdaysRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-1007-4000-8000-000000000007",
            commands: [
              {
                root: { kind: "work_item", id: validTaskId },
                action: "work_item.create_recurrence",
                payload: {
                  start_date: "2026-10-31",
                  rule: {
                    weekdays: [5, 1, 3],
                  },
                  template: {
                    title: "Recurrence Task",
                    period: "morning",
                    duration_minutes: 30,
                    plan_id: validPlanId,
                    standalone_color_id: "green",
                    order_key: "0",
                  },
                },
                precondition: null,
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          // 8. Strict undo: extra property on expected_states -> rejected
          const undoExtraStatePropRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-1008-4000-8000-000000000008",
            commands: [
              {
                root: { kind: "work_item", id: validTaskId },
                action: "undo",
                payload: {
                  original_operation_id: "11111111-0000-4000-8000-000000000000",
                  expected_states: [
                    {
                      root: { kind: "work_item", id: validTaskId },
                      hash: dummyHash,
                      extra_forbidden: "bad",
                    } as any,
                  ],
                },
                precondition: null,
              },
            ],
            dependencies: ["11111111-0000-4000-8000-000000000000"],
            clockInput: baseClock,
          });

          // 9. Strict undo: duplicate root in expected_states -> rejected
          const undoDuplicateRootRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-1009-4000-8000-000000000009",
            commands: [
              {
                root: { kind: "work_item", id: validTaskId },
                action: "undo",
                payload: {
                  original_operation_id: "11111111-0000-4000-8000-000000000000",
                  expected_states: [
                    { root: { kind: "work_item", id: validTaskId }, hash: dummyHash },
                    { root: { kind: "work_item", id: validTaskId }, hash: dummyHash },
                  ],
                },
                precondition: null,
              },
            ],
            dependencies: ["11111111-0000-4000-8000-000000000000"],
            clockInput: baseClock,
          });

          // 10. Strict undo: missing original_operation_id in operation dependencies -> rejected
          const undoMissingDepRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-1010-4000-8000-000000000010",
            commands: [
              {
                root: { kind: "work_item", id: validTaskId },
                action: "undo",
                payload: {
                  original_operation_id: "11111111-0000-4000-8000-000000000000",
                  expected_states: [
                    { root: { kind: "work_item", id: validTaskId }, hash: dummyHash },
                  ],
                },
                precondition: null,
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          // 11. Valid strictly ascending weekdays -> accepted
          const validWeekdaysRes = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId: "11111111-1011-4000-8000-000000000011",
            commands: [
              {
                root: { kind: "work_item", id: validTaskId },
                action: "work_item.create_recurrence",
                payload: {
                  start_date: "2026-10-31",
                  rule: {
                    weekdays: [1, 3, 5],
                  },
                  template: {
                    title: "Recurrence Task",
                    period: "morning",
                    duration_minutes: 30,
                    plan_id: validPlanId,
                    standalone_color_id: "green",
                    order_key: "0",
                  },
                },
                precondition: null,
              },
            ],
            dependencies: [],
            clockInput: baseClock,
          });

          gateway.close();
          closeDatabase(db);

          return {
            ok: true,
            missingPreconditionOk: missingPreconditionRes.ok,
            missingPreconditionCode: !missingPreconditionRes.ok ? missingPreconditionRes.error.code : null,
            undefinedPreconditionOk: undefinedPreconditionRes.ok,
            undefinedPreconditionCode: !undefinedPreconditionRes.ok ? undefinedPreconditionRes.error.code : null,
            emptyPreconditionOk: emptyPreconditionRes.ok,
            emptyPreconditionCode: !emptyPreconditionRes.ok ? emptyPreconditionRes.error.code : null,
            setOrderNullPreconditionOk: setOrderNullPreconditionRes.ok,
            setOrderNullPreconditionCode: !setOrderNullPreconditionRes.ok ? setOrderNullPreconditionRes.error.code : null,
            badDateMilestoneOk: badDateMilestoneRes.ok,
            badDateMilestoneCode: !badDateMilestoneRes.ok ? badDateMilestoneRes.error.code : null,
            badOrderKeyOk: badOrderKeyRes.ok,
            badOrderKeyCode: !badOrderKeyRes.ok ? badOrderKeyRes.error.code : null,
            unsortedWeekdaysOk: unsortedWeekdaysRes.ok,
            unsortedWeekdaysCode: !unsortedWeekdaysRes.ok ? unsortedWeekdaysRes.error.code : null,
            undoExtraStatePropOk: undoExtraStatePropRes.ok,
            undoExtraStatePropCode: !undoExtraStatePropRes.ok ? undoExtraStatePropRes.error.code : null,
            undoDuplicateRootOk: undoDuplicateRootRes.ok,
            undoDuplicateRootCode: !undoDuplicateRootRes.ok ? undoDuplicateRootRes.error.code : null,
            undoMissingDepOk: undoMissingDepRes.ok,
            undoMissingDepCode: !undoMissingDepRes.ok ? undoMissingDepRes.error.code : null,
            validWeekdaysOk: validWeekdaysRes.ok,
            validWeekdaysError: !validWeekdaysRes.ok ? validWeekdaysRes.error.message : null,
          };
        },
        { testDbName, ownerId, keyId, deviceId, calId, dummyHash }
      );

      expect(result.ok).toBe(true);
      expect(result.missingPreconditionOk).toBe(false);
      expect(result.missingPreconditionCode).toBe("invalid_data");
      expect(result.undefinedPreconditionOk).toBe(false);
      expect(result.undefinedPreconditionCode).toBe("invalid_data");
      expect(result.emptyPreconditionOk).toBe(false);
      expect(result.emptyPreconditionCode).toBe("invalid_data");
      expect(result.setOrderNullPreconditionOk).toBe(false);
      expect(result.setOrderNullPreconditionCode).toBe("invalid_data");
      expect(result.badDateMilestoneOk).toBe(false);
      expect(result.badDateMilestoneCode).toBe("invalid_data");
      expect(result.badOrderKeyOk).toBe(false);
      expect(result.badOrderKeyCode).toBe("invalid_data");
      expect(result.unsortedWeekdaysOk).toBe(false);
      expect(result.unsortedWeekdaysCode).toBe("invalid_data");
      expect(result.undoExtraStatePropOk).toBe(false);
      expect(result.undoExtraStatePropCode).toBe("invalid_data");
      expect(result.undoDuplicateRootOk).toBe(false);
      expect(result.undoDuplicateRootCode).toBe("invalid_data");
      expect(result.undoMissingDepOk).toBe(false);
      expect(result.undoMissingDepCode).toBe("invalid_data");
      expect(result.validWeekdaysError).toBe(null);
      expect(result.validWeekdaysOk).toBe(true);
    });
    test("N01: canonical text is normalized before immutable hashing and Unicode limits count code points", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });
      const dbName = `test-n01-${Date.now()}`;
      const result = await page.evaluate(async (dbName) => {
        const {
          openDatabase, closeDatabase, importRawKey, unlockOwner,
          createLocalStorageGateway,
        } = window.__dayforge_storage_atomicity;
        const ownerId = "11111111-2101-4000-8000-000000000001";
        const keyId = "key-n01";
        const deviceId = "22222222-2101-4000-8000-000000000001";
        const calId = "33333333-2101-4000-8000-000000000001";
        const opened = await openDatabase({ name: dbName });
        if (!opened.ok) return { setup: false };
        const db = opened.value;
        const key = await importRawKey(new Uint8Array(32).fill(0x21));
        const unlock = await unlockOwner(db, ownerId, keyId, key);
        if (!unlock.ok) return { setup: false };
        const ctx = unlock.value;
        const gateway = createLocalStorageGateway({ name: dbName });

        const canonicalized = await gateway.persistOperation({
          context: ctx,
          deviceId,
          operationId: "44444444-2101-4000-8000-000000000001",
          commands: [
            {
              root: { kind: "plan", id: "55555555-2101-4000-8000-000000000001" },
              action: "plan.create",
              payload: { data: { name: "  Cafe\u0301  ", color_id: "green" } },
              precondition: null,
            },
            {
              root: { kind: "milestone", id: "66666666-2101-4000-8000-000000000001" },
              action: "milestone.create",
              payload: {
                data: {
                  title: "  A\u030A  ",
                  date: "2026-11-01",
                  period: null,
                  note: "line1\r\nline2\rline3",
                  plan_id: null,
                  standalone_color_id: "blue",
                  show_in_work_calendar: true,
                },
              },
              precondition: null,
            },
          ],
          dependencies: [],
          clockInput: {
            estimatedUtcMs: 1793480000000,
            rawWallMs: 1793480000000,
            calibrationId: calId,
            quality: "calibrated",
          },
        });

        const astral120 = "😀".repeat(120);
        const astral121 = "😀".repeat(121);
        const validAstral = await gateway.persistOperation({
          context: ctx,
          deviceId,
          operationId: "44444444-2101-4000-8000-000000000002",
          commands: [{
            root: { kind: "work_item", id: "77777777-2101-4000-8000-000000000001" },
            action: "work_item.create_single",
            payload: { data: {
              title: astral120,
              date: "2026-11-01",
              period: "morning",
              duration_minutes: 30,
              plan_id: null,
              standalone_color_id: "green",
              status: "pending",
              order_key: "0",
            } },
            precondition: null,
          }],
          dependencies: [],
          clockInput: {
            estimatedUtcMs: 1793480000001,
            rawWallMs: 1793480000001,
            calibrationId: calId,
            quality: "calibrated",
          },
        });
        const invalidAstral = await gateway.persistOperation({
          context: ctx,
          deviceId,
          operationId: "44444444-2101-4000-8000-000000000003",
          commands: [{
            root: { kind: "work_item", id: "77777777-2101-4000-8000-000000000002" },
            action: "work_item.create_single",
            payload: { data: {
              title: astral121,
              date: "2026-11-01",
              period: "morning",
              duration_minutes: 30,
              plan_id: null,
              standalone_color_id: "green",
              status: "pending",
              order_key: "0",
            } },
            precondition: null,
          }],
          dependencies: [],
          clockInput: {
            estimatedUtcMs: 1793480000002,
            rawWallMs: 1793480000002,
            calibrationId: calId,
            quality: "calibrated",
          },
        });

        const sendable = await gateway.listSendableOperations(ctx);
        const first = sendable.ok ? sendable.value.find(
          (op: any) => op.operation_id === "44444444-2101-4000-8000-000000000001"
        ) as any : null;
        const planData = first?.commands?.[0]?.payload?.data;
        const milestoneData = first?.commands?.[1]?.payload?.data;

        gateway.close();
        closeDatabase(db);
        return {
          setup: true,
          canonicalizedOk: canonicalized.ok,
          planName: planData?.name ?? null,
          milestoneTitle: milestoneData?.title ?? null,
          milestoneNote: milestoneData?.note ?? null,
          validAstralOk: validAstral.ok,
          invalidAstralOk: invalidAstral.ok,
          invalidAstralCode: !invalidAstral.ok ? invalidAstral.error.code : null,
        };
      }, dbName);

      expect(result.setup).toBe(true);
      expect(result.canonicalizedOk).toBe(true);
      expect(result.planName).toBe("Café");
      expect(result.milestoneTitle).toBe("Å");
      expect(result.milestoneNote).toBe("line1\nline2\nline3");
      expect(result.validAstralOk).toBe(true);
      expect(result.invalidAstralOk).toBe(false);
      expect(result.invalidAstralCode).toBe("invalid_data");
    });

    test("N02: 2 MiB canonical UTF-8 boundary is enforced before durable outbox commit", async ({
      page,
    }) => {
      const exact = canonicalizeJson("x".repeat(MAX_OPERATION_WIRE_BYTES - 2));
      const over = canonicalizeJson("x".repeat(MAX_OPERATION_WIRE_BYTES - 1));
      expect(assertOperationWireSize(exact)).toBe(MAX_OPERATION_WIRE_BYTES);
      expect(() => assertOperationWireSize(over)).toThrow(StorageError);

      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });
      const dbName = `test-n02-${Date.now()}`;
      const result = await page.evaluate(async (dbName) => {
        const {
          openDatabase, closeDatabase, importRawKey, unlockOwner,
          createLocalStorageGateway, STORAGE_STORES,
        } = window.__dayforge_storage_atomicity;
        const ownerId = "11111111-2202-4000-8000-000000000001";
        const deviceId = "22222222-2202-4000-8000-000000000001";
        const calId = "33333333-2202-4000-8000-000000000001";
        const operationId = "44444444-2202-4000-8000-000000000001";
        const opened = await openDatabase({ name: dbName });
        if (!opened.ok) return { setup: false };
        const db = opened.value;
        const key = await importRawKey(new Uint8Array(32).fill(0x22));
        const unlock = await unlockOwner(db, ownerId, "key-n02", key);
        if (!unlock.ok) return { setup: false };
        const gateway = createLocalStorageGateway({ name: dbName });
        const commands = Array.from({ length: 525 }, (_, i) => ({
          root: {
            kind: "milestone",
            id:
              i.toString(16).padStart(8, "0") +
              "-2202-4000-8000-" +
              (i + 1).toString(16).padStart(12, "0"),
          },
          action: "milestone.create",
          payload: { data: {
            title: "Large operation",
            date: "2026-11-01",
            period: null,
            note: "x".repeat(4000),
            plan_id: null,
            standalone_color_id: "neutral",
            show_in_work_calendar: true,
          } },
          precondition: null,
        }));
        const saved = await gateway.persistOperation({
          context: unlock.value,
          deviceId,
          operationId,
          commands,
          dependencies: [],
          clockInput: {
            estimatedUtcMs: 1793480001000,
            rawWallMs: 1793480001000,
            calibrationId: calId,
            quality: "calibrated",
          },
        });
        const row = await new Promise<any>((resolve) => {
          const tx = db.transaction(STORAGE_STORES.operations, "readonly");
          const req = tx.objectStore(STORAGE_STORES.operations).get([ownerId, operationId]);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        });
        gateway.close();
        closeDatabase(db);
        return {
          setup: true,
          savedOk: saved.ok,
          code: !saved.ok ? saved.error.code : null,
          persisted: Boolean(row),
        };
      }, dbName);

      expect(result.setup).toBe(true);
      expect(result.savedOk).toBe(false);
      expect(result.code).toBe("invalid_data");
      expect(result.persisted).toBe(false);
    });

    test("N03/N05: enable_recurrence requires matching weekday and operations reject self-dependency", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });
      const dbName = `test-n03-n05-${Date.now()}`;
      const result = await page.evaluate(async (dbName) => {
        const {
          openDatabase, closeDatabase, importRawKey, unlockOwner,
          createLocalStorageGateway,
        } = window.__dayforge_storage_atomicity;
        const ownerId = "11111111-2303-4000-8000-000000000001";
        const deviceId = "22222222-2303-4000-8000-000000000001";
        const calId = "33333333-2303-4000-8000-000000000001";
        const opened = await openDatabase({ name: dbName });
        if (!opened.ok) return { setup: false };
        const db = opened.value;
        const key = await importRawKey(new Uint8Array(32).fill(0x23));
        const unlock = await unlockOwner(db, ownerId, "key-n03", key);
        if (!unlock.ok) return { setup: false };
        const gateway = createLocalStorageGateway({ name: dbName });
        const data = {
          title: "Monday task",
          date: "2026-11-02",
          period: "morning",
          duration_minutes: 30,
          plan_id: null,
          standalone_color_id: "green",
          status: "pending",
          order_key: "0",
        };
        const make = (operationId: string, weekdays: number[], dependencies: string[] = []) =>
          gateway.persistOperation({
            context: unlock.value,
            deviceId,
            operationId,
            commands: [{
              root: { kind: "work_item", id: "55555555-2303-4000-8000-000000000001" },
              action: "work_item.enable_recurrence",
              payload: { data, rule: { weekdays } },
              precondition: null,
            }],
            dependencies,
            clockInput: {
              estimatedUtcMs: 1793480002000 + Number(operationId.slice(-1)),
              rawWallMs: 1793480002000 + Number(operationId.slice(-1)),
              calibrationId: calId,
              quality: "calibrated",
            },
          });
        const valid = await make("44444444-2303-4000-8000-000000000001", [1]);
        const mismatch = await make("44444444-2303-4000-8000-000000000002", [2, 4]);
        const selfId = "44444444-2303-4000-8000-000000000003";
        const self = await make(selfId, [1], [selfId]);
        gateway.close();
        closeDatabase(db);
        return {
          setup: true,
          validOk: valid.ok,
          mismatchOk: mismatch.ok,
          mismatchCode: !mismatch.ok ? mismatch.error.code : null,
          selfOk: self.ok,
          selfCode: !self.ok ? self.error.code : null,
        };
      }, dbName);

      expect(result.setup).toBe(true);
      expect(result.validOk).toBe(true);
      expect(result.mismatchOk).toBe(false);
      expect(result.mismatchCode).toBe("invalid_data");
      expect(result.selfOk).toBe(false);
      expect(result.selfCode).toBe("invalid_data");
    });

    test("N04: ACKed operation remains replay-visible after gateway reload until pull confirmation", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });
      const dbName = `test-n04-${Date.now()}`;
      const result = await page.evaluate(async (dbName) => {
        const {
          openDatabase, closeDatabase, importRawKey, unlockOwner,
          createLocalStorageGateway, STORAGE_STORES,
        } = window.__dayforge_storage_atomicity;
        const ownerId = "11111111-2404-4000-8000-000000000001";
        const deviceId = "22222222-2404-4000-8000-000000000001";
        const calId = "33333333-2404-4000-8000-000000000001";
        const operationId = "44444444-2404-4000-8000-000000000001";
        const opened = await openDatabase({ name: dbName });
        if (!opened.ok) return { setup: false };
        const db = opened.value;
        const key = await importRawKey(new Uint8Array(32).fill(0x24));
        const unlock = await unlockOwner(db, ownerId, "key-n04", key);
        if (!unlock.ok) return { setup: false };
        const ctx = unlock.value;

        const gateway1 = createLocalStorageGateway({ name: dbName });
        const saved = await gateway1.persistOperation({
          context: ctx,
          deviceId,
          operationId,
          commands: [{
            root: { kind: "plan", id: "55555555-2404-4000-8000-000000000001" },
            action: "plan.create",
            payload: { data: { name: "Replay plan", color_id: "green" } },
            precondition: null,
          }],
          dependencies: [],
          clockInput: {
            estimatedUtcMs: 1793480003000,
            rawWallMs: 1793480003000,
            calibrationId: calId,
            quality: "calibrated",
          },
        });
        if (!saved.ok) return { setup: false };
        const ack = await gateway1.markOperationAcked(ctx, operationId);
        const sendableBefore = await gateway1.listSendableOperations(ctx);
        const optimisticBefore = await gateway1.listOutboxForReplay(ctx);
        gateway1.close();

        const gateway2 = createLocalStorageGateway({ name: dbName });
        const sendableReload = await gateway2.listSendableOperations(ctx);
        const optimisticReload = await gateway2.listOutboxForReplay(ctx);
        const row = await new Promise<any>((resolve) => {
          const tx = db.transaction(STORAGE_STORES.operations, "readonly");
          const req = tx.objectStore(STORAGE_STORES.operations).get([ownerId, operationId]);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        });
        const confirmed = row
          ? await gateway2.markOperationSynced(ctx, operationId, row.request_hash)
          : null;
        const optimisticAfter = await gateway2.listOutboxForReplay(ctx);
        gateway2.close();
        closeDatabase(db);
        return {
          setup: true,
          ackOk: ack.ok,
          sendableBefore: sendableBefore.ok ? sendableBefore.value.length : -1,
          optimisticBefore: optimisticBefore.ok ? optimisticBefore.value.length : -1,
          sendableReload: sendableReload.ok ? sendableReload.value.length : -1,
          optimisticReload: optimisticReload.ok ? optimisticReload.value.length : -1,
          confirmedOk: confirmed?.ok ?? false,
          optimisticAfter: optimisticAfter.ok ? optimisticAfter.value.length : -1,
        };
      }, dbName);

      expect(result.setup).toBe(true);
      expect(result.ackOk).toBe(true);
      expect(result.sendableBefore).toBe(0);
      expect(result.optimisticBefore).toBe(1);
      expect(result.sendableReload).toBe(0);
      expect(result.optimisticReload).toBe(1);
      expect(result.confirmedOk).toBe(true);
      expect(result.optimisticAfter).toBe(0);
    });

    test("R01: snapshot immutable operation inputs before hashing and encryption", async ({ page }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });
      const result = await page.evaluate(async () => {
        const s = window.__dayforge_storage_atomicity;
        const ownerId = "11111111-9001-4000-8000-000000000001";
        const operationId = "22222222-9001-4000-8000-000000000001";
        const open = await s.openDatabase({ name: `r01-${crypto.randomUUID()}` });
        if (!open.ok) return { setup: false };
        const db = open.value;
        const key = await s.generateTestKey();
        const unlocked = await s.unlockOwner(db, ownerId, "r01-key", key);
        if (!unlocked.ok) return { setup: false };
        const input: any = {
          context: unlocked.value,
          deviceId: "33333333-9001-4000-8000-000000000001",
          operationId,
          commands: [{
            root: { kind: "plan", id: "44444444-9001-4000-8000-000000000001" },
            action: "plan.create",
            payload: { data: { name: "stable", color_id: "green" } },
            precondition: null,
          }],
          dependencies: [],
          clockInput: {
            estimatedUtcMs: 1793480000000,
            rawWallMs: 1793480000000,
            calibrationId: "55555555-9001-4000-8000-000000000001",
            quality: "calibrated",
          },
        };
        const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
        crypto.subtle.digest = async (...args) => {
          const digest = await originalDigest(...args);
          input.commands[0].root.id = "66666666-9001-4000-8000-000000000001";
          input.dependencies.push("77777777-9001-4000-8000-000000000001");
          return digest;
        };
        const saved = await s.persistOperationAtomic(db, input);
        crypto.subtle.digest = originalDigest;
        const row = await new Promise<any>((resolve) => {
          const tx = db.transaction(s.STORAGE_STORES.operations, "readonly");
          const req = tx.objectStore(s.STORAGE_STORES.operations).get([ownerId, operationId]);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        });
        if (!row) return { setup: true, saveOk: saved.ok, rowExists: false };
        const decoded = await s.decryptPayload<OperationEnvelope>(unlocked.value.key, row.encrypted_envelope, ownerId, "operations", operationId);
        const hashed = decoded.ok ? await s.computeCanonicalHash(decoded.value) : null;
        db.close();
        return {
          setup: true,
          saveOk: saved.ok,
          rowExists: true,
          hashMatches: hashed?.hash === row.request_hash,
          storedRootId: decoded.ok ? decoded.value.commands[0].root.id : null,
          storedDependencies: decoded.ok ? decoded.value.dependencies : null,
        };
      });
      expect(result.setup).toBe(true);
      expect(result.saveOk).toBe(true);
      expect(result.rowExists).toBe(true);
      expect(result.hashMatches).toBe(true);
      expect(result.storedRootId).toBe("44444444-9001-4000-8000-000000000001");
      expect(result.storedDependencies).toEqual([]);
    });

    test("R02: malformed persisted sequence metadata fails closed without reusing sequence one", async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });
      const result = await page.evaluate(async () => {
        const s = window.__dayforge_storage_atomicity;
        const ownerId = "11111111-9002-4000-8000-000000000001";
        const deviceId = "33333333-9002-4000-8000-000000000001";
        const open = await s.openDatabase({ name: `r02-${crypto.randomUUID()}` });
        if (!open.ok) return { setup: false };
        const db = open.value;
        const key = await s.generateTestKey();
        const unlocked = await s.unlockOwner(db, ownerId, "r02-key", key);
        if (!unlocked.ok) return { setup: false };
        const makeInput = (operationId: string): any => ({
          context: unlocked.value,
          deviceId,
          operationId,
          commands: [{ root: { kind: "plan", id: "44444444-9002-4000-8000-000000000001" }, action: "plan.create", payload: { data: { name: "seq", color_id: "green" } }, precondition: null }],
          dependencies: [],
          clockInput: { estimatedUtcMs: 1793480000000, rawWallMs: 1793480000000, calibrationId: "55555555-9002-4000-8000-000000000001", quality: "calibrated" },
        });
        const first = await s.persistOperationAtomic(db, makeInput("22222222-9002-4000-8000-000000000001"));
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(s.STORAGE_STORES.device_meta, "readwrite");
          const store = tx.objectStore(s.STORAGE_STORES.device_meta);
          const req = store.get([ownerId, deviceId]);
          req.onsuccess = () => { const row = req.result; delete row.last_sequence; store.put(row); };
          req.onerror = () => reject(req.error);
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
        const next = await s.persistOperationAtomic(db, makeInput("22222222-9002-4000-8000-000000000002"));
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(s.STORAGE_STORES.device_meta, "readwrite");
          const store = tx.objectStore(s.STORAGE_STORES.device_meta);
          const req = store.get([ownerId, deviceId]);
          req.onsuccess = () => { const row = req.result; row.last_sequence = { toString: null }; store.put(row); };
          req.onerror = () => reject(req.error);
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
        const hostile = await s.persistOperationAtomic(db, makeInput("22222222-9002-4000-8000-000000000003"));
        const state = await new Promise<{ count: number; lastSequence: unknown }>((resolve) => {
          const tx = db.transaction([s.STORAGE_STORES.operations, s.STORAGE_STORES.device_meta], "readonly");
          const countReq = tx.objectStore(s.STORAGE_STORES.operations).count();
          const metaReq = tx.objectStore(s.STORAGE_STORES.device_meta).get([ownerId, deviceId]);
          tx.oncomplete = () => resolve({ count: countReq.result, lastSequence: metaReq.result.last_sequence });
        });
        db.close();
        return {
          setup: true,
          firstOk: first.ok,
          secondOk: next.ok,
          errorCode: next.ok ? null : next.error.code,
          reusedSequenceOne: next.ok && next.value.deviceSequence === "1",
          hostileOk: hostile.ok,
          hostileCode: hostile.ok ? null : hostile.error.code,
          operationCount: state.count,
          sequenceStillMalformed: typeof state.lastSequence === "object",
        };
      });
      expect(result.setup).toBe(true);
      expect(result.firstOk).toBe(true);
      expect(result.secondOk).toBe(false);
      expect(result.errorCode).toBe("invalid_data");
      expect(result.reusedSequenceOne).toBe(false);
      expect(result.hostileOk).toBe(false);
      expect(result.hostileCode).toBe("invalid_data");
      expect(result.operationCount).toBe(1);
      expect(result.sequenceStillMalformed).toBe(true);
      expect(pageErrors).toEqual([]);
    });

    test("R03: invalid clock quality and extra HLC fields are rejected before commit", async ({ page }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });
      const result = await page.evaluate(async () => {
        const s = window.__dayforge_storage_atomicity;
        const ownerId = "11111111-9003-4000-8000-000000000001";
        const open = await s.openDatabase({ name: `r03-${crypto.randomUUID()}` });
        if (!open.ok) return { setup: false };
        const db = open.value;
        const key = await s.generateTestKey();
        const unlocked = await s.unlockOwner(db, ownerId, "r03-key", key);
        if (!unlocked.ok) return { setup: false };
        const makeInput = (operationId: string, deviceId: string, extras: object = {}): any => ({
          context: unlocked.value,
          deviceId,
          operationId,
          commands: [{ root: { kind: "plan", id: "44444444-9003-4000-8000-000000000001" }, action: "plan.create", payload: { data: { name: "clock", color_id: "green" } }, precondition: null }],
          dependencies: [],
          clockInput: { estimatedUtcMs: 1793480000000, rawWallMs: 1793480000000, calibrationId: "55555555-9003-4000-8000-000000000001", quality: "calibrated" },
          ...extras,
        });
        const badQuality = await s.persistOperationAtomic(db, makeInput("22222222-9003-4000-8000-000000000001", "33333333-9003-4000-8000-000000000001", { clockInput: { estimatedUtcMs: 1793480000000, rawWallMs: 1793480000000, calibrationId: "55555555-9003-4000-8000-000000000001", quality: "bogus" } }));
        const badEditTime = await s.persistOperationAtomic(db, makeInput("22222222-9003-4000-8000-000000000002", "33333333-9003-4000-8000-000000000002", { clockInput: undefined, editTime: { physical_ms: 1793480000000, logical: 0, calibration_id: "55555555-9003-4000-8000-000000000001", raw_wall_ms: 1793480000000, quality: "calibrated", debug: "extra" } }));
        const nullQuality = await s.persistOperationAtomic(db, makeInput("22222222-9003-4000-8000-000000000003", "33333333-9003-4000-8000-000000000003", { clockInput: { estimatedUtcMs: 1793480000000, rawWallMs: 1793480000000, calibrationId: "55555555-9003-4000-8000-000000000001", quality: null } }));
        db.close();
        return {
          setup: true,
          badQualityOk: badQuality.ok,
          badQualityCode: badQuality.ok ? null : badQuality.error.code,
          badEditTimeOk: badEditTime.ok,
          badEditTimeCode: badEditTime.ok ? null : badEditTime.error.code,
          nullQualityOk: nullQuality.ok,
          nullQualityCode: nullQuality.ok ? null : nullQuality.error.code,
        };
      });
      expect(result.setup).toBe(true);
      expect(result.badQualityOk).toBe(false);
      expect(result.badQualityCode).toBe("invalid_data");
      expect(result.badEditTimeOk).toBe(false);
      expect(result.badEditTimeCode).toBe("invalid_data");
      expect(result.nullQualityOk).toBe(false);
      expect(result.nullQualityCode).toBe("invalid_data");
    });

    test("R05: undefined precondition guards are rejected before commit", async ({ page }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });
      const result = await page.evaluate(async () => {
        const s = window.__dayforge_storage_atomicity;
        const ownerId = "11111111-9004-4000-8000-000000000001";
        const deviceId = "33333333-9004-4000-8000-000000000001";
        const open = await s.openDatabase({ name: `r04-${crypto.randomUUID()}` });
        if (!open.ok) return { setup: false, results: [], operationCount: -1, deviceMetaCount: -1 };
        const db = open.value;
        const key = await s.generateTestKey();
        const unlocked = await s.unlockOwner(db, ownerId, "r04-key", key);
        if (!unlocked.ok) return { setup: false, results: [], operationCount: -1, deviceMetaCount: -1 };
        const guardValues = [
          { expected_root_hash: undefined },
          { expected_bucket: undefined },
        ];
        const results = [] as Array<{ ok: boolean; code: string | null }>;
        for (let index = 0; index < guardValues.length; index += 1) {
          const saved = await s.persistOperationAtomic(db, {
            context: unlocked.value,
            deviceId,
            operationId: `22222222-9004-4000-8000-${(index + 1).toString().padStart(12, "0")}`,
            commands: [{
              root: { kind: "plan", id: "44444444-9004-4000-8000-000000000001" },
              action: "plan.create",
              payload: { data: { name: "undefined guard", color_id: "green" } },
              precondition: guardValues[index],
            }],
            dependencies: [],
            clockInput: {
              estimatedUtcMs: 1793480000000 + index,
              rawWallMs: 1793480000000 + index,
              calibrationId: "55555555-9004-4000-8000-000000000001",
              quality: "calibrated",
            },
          } as any);
          results.push({ ok: saved.ok, code: saved.ok ? null : saved.error.code });
        }
        const counts = await new Promise<{ operations: number; deviceMeta: number }>((resolve, reject) => {
          const tx = db.transaction([s.STORAGE_STORES.operations, s.STORAGE_STORES.device_meta], "readonly");
          const operations = tx.objectStore(s.STORAGE_STORES.operations).count();
          const deviceMeta = tx.objectStore(s.STORAGE_STORES.device_meta).count();
          tx.oncomplete = () => resolve({ operations: operations.result, deviceMeta: deviceMeta.result });
          tx.onerror = () => reject(tx.error);
        });
        db.close();
        return { setup: true, results, operationCount: counts.operations, deviceMetaCount: counts.deviceMeta };
      });

      expect(result.setup).toBe(true);
      expect(result.results).toEqual([
        { ok: false, code: "invalid_data" },
        { ok: false, code: "invalid_data" },
      ]);
      expect(result.operationCount).toBe(0);
      expect(result.deviceMetaCount).toBe(0);
    });

    test("N07: replay preserves persisted status and request hash after gateway reload", async ({ page }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });
      const result = await page.evaluate(async () => {
        const s = window.__dayforge_storage_atomicity;
        const ownerId = "11111111-9010-4000-8000-000000000001";
        const deviceId = "33333333-9010-4000-8000-000000000001";
        const calibrationId = "55555555-9010-4000-8000-000000000001";
        const open = await s.openDatabase({ name: `n07-${crypto.randomUUID()}` });
        if (!open.ok) return { setup: false, replayOk: false, replayItems: [], sendableIds: [], sendableCode: null };
        const db = open.value;
        const key = await s.generateTestKey();
        const unlocked = await s.unlockOwner(db, ownerId, "n07-key", key);
        if (!unlocked.ok) return { setup: false, replayOk: false, replayItems: [], sendableIds: [], sendableCode: null };
        const ctx = unlocked.value;
        const gateway1 = s.createLocalStorageGateway({ name: db.name });
        const operationIds = [1, 2, 3, 4].map((index) =>
          `22222222-9010-4000-8000-${index.toString().padStart(12, "0")}`
        );
        for (let index = 0; index < operationIds.length; index += 1) {
          const saved = await gateway1.persistOperation({
            context: ctx,
            deviceId,
            operationId: operationIds[index],
            commands: [{
              root: { kind: "plan", id: `44444444-9010-4000-8000-${(index + 1).toString().padStart(12, "0")}` },
              action: "plan.create",
              payload: { data: { name: `Replay ${index}`, color_id: "green" } },
              precondition: null,
            }],
            dependencies: [],
            clockInput: {
              estimatedUtcMs: 1793480100000 + index,
              rawWallMs: 1793480100000 + index,
              calibrationId,
              quality: "calibrated",
            },
          });
          if (!saved.ok) return { setup: false, replayOk: false, replayItems: [], sendableIds: [], sendableCode: null };
        }
        const ack = await gateway1.markOperationAcked(ctx, operationIds[0]);
        if (!ack.ok) return { setup: false, replayOk: false, replayItems: [], sendableIds: [], sendableCode: null };
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(s.STORAGE_STORES.operations, "readwrite");
          const store = tx.objectStore(s.STORAGE_STORES.operations);
          for (const [operationId, status] of [[operationIds[1], "blocked"], [operationIds[2], "time_invalid"]] as const) {
            const req = store.get([ownerId, operationId]);
            req.onsuccess = () => { const row = req.result; row.status = status; store.put(row); };
            req.onerror = () => reject(req.error);
          }
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });
        const rows = await new Promise<any[]>((resolve, reject) => {
          const tx = db.transaction(s.STORAGE_STORES.operations, "readonly");
          const req = tx.objectStore(s.STORAGE_STORES.operations).getAll();
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        });
        gateway1.close();

        const gateway2 = s.createLocalStorageGateway({ name: db.name });
        const replayMethod = (gateway2 as any).listOutboxForReplay;
        const replay = typeof replayMethod === "function" ? await replayMethod.call(gateway2, ctx) : null;
        const sendable = await gateway2.listSendableOperations(ctx);
        const result = {
          setup: true,
          replayOk: replay?.ok ?? false,
          replayItems: replay?.ok ? replay.value.map((item: any) => ({
            operationId: item.envelope.operation_id,
            status: item.status,
            requestHashMatches: rows.some((row) => row.operation_id === item.envelope.operation_id && row.request_hash === item.requestHash),
          })) : [],
          sendableIds: sendable.ok ? sendable.value.map((envelope: any) => envelope.operation_id) : [],
          sendableCode: sendable.ok ? null : sendable.error.code,
        };
        gateway2.close();
        s.closeDatabase(db);
        return result;
      });

      expect(result.setup).toBe(true);
      expect(result.replayOk).toBe(true);
      expect(result.replayItems.map((item: any) => item.status).sort()).toEqual([
        "ack_waiting_pull", "blocked", "queued", "time_invalid",
      ]);
      expect(result.replayItems.every((item: any) => item.requestHashMatches)).toBe(true);
      expect(result.sendableCode).toBe(null);
      expect(result.sendableIds).toEqual(["22222222-9010-4000-8000-000000000004"]);
    });

    test("N10: every owner-scoped outbox row is validated before status filtering", async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });
      const result = await page.evaluate(async () => {
        const s = window.__dayforge_storage_atomicity;
        const ownerId = "11111111-9011-4000-8000-000000000001";
        const deviceId = "33333333-9011-4000-8000-000000000001";
        const calibrationId = "55555555-9011-4000-8000-000000000001";
        const open = await s.openDatabase({ name: `n10-${crypto.randomUUID()}` });
        if (!open.ok) return { setup: false, codes: [] };
        const db = open.value;
        const key = await s.generateTestKey();
        const unlocked = await s.unlockOwner(db, ownerId, "n10-key", key);
        if (!unlocked.ok) return { setup: false, codes: [] };
        const ctx = unlocked.value;
        const gateway = s.createLocalStorageGateway({ name: db.name });
        const cases: Array<{ name: string; apply: (row: any, operationId: string) => Promise<void> | void }> = [
          { name: "unknown-status", apply: (row) => { row.status = "garbage"; } },
          { name: "operation-uuid", apply: (row) => { row.operation_id = "not-a-uuid"; } },
          { name: "operation-id-number", apply: (row) => { row.operation_id = 123; } },
          { name: "operation-id-array", apply: (row) => { row.operation_id = ["bad"]; } },
          { name: "operation-id-high-sentinel", apply: (row) => { row.operation_id = "\uffffx"; } },
          { name: "sequence-type", apply: (row) => { row.device_sequence = 1; } },
          { name: "sequence-overflow", apply: (row) => { row.device_sequence = "18446744073709551616"; } },
          { name: "request-hash-shape", apply: (row) => { row.request_hash = "A".repeat(64); } },
          { name: "request-hash-mismatch", apply: (row) => { row.request_hash = `${row.request_hash.slice(0, -1)}${row.request_hash.endsWith("0") ? "1" : "0"}`; } },
          { name: "encrypted-owner", apply: (row) => { row.encrypted_envelope.owner_id = "99999999-9011-4000-8000-000000000001"; } },
          { name: "encrypted-store", apply: (row) => { row.encrypted_envelope.store = "records"; } },
          { name: "encrypted-record-id", apply: (row) => { row.encrypted_envelope.record_id = "99999999-9011-4000-8000-000000000002"; } },
          { name: "encrypted-key-id", apply: (row) => { row.encrypted_envelope.key_id = "wrong-key"; } },
          { name: "iv-type", apply: (row) => { row.encrypted_envelope.iv = Array.from(row.encrypted_envelope.iv); } },
          { name: "iv-length", apply: (row) => { row.encrypted_envelope.iv = row.encrypted_envelope.iv.slice(1); } },
          { name: "ciphertext-type", apply: (row) => { row.encrypted_envelope.ciphertext = Array.from(row.encrypted_envelope.ciphertext); } },
          { name: "ciphertext-short", apply: (row) => { row.encrypted_envelope.ciphertext = new Uint8Array(15); } },
          { name: "excluded-row-hash", apply: (row) => { row.status = "superseded_by"; row.superseded_by = "44444444-9011-4000-8000-000000000099"; row.request_hash = "bad"; } },
          { name: "superseded-valid-hash-mismatch", apply: (row) => {
            row.status = "superseded_by";
            row.superseded_by = "44444444-9011-4000-8000-000000000099";
            row.request_hash = `${row.request_hash.slice(0, -1)}${row.request_hash.endsWith("0") ? "1" : "0"}`;
          } },
          { name: "superseded-ciphertext-tamper", apply: (row) => {
            row.status = "superseded_by";
            row.superseded_by = "44444444-9011-4000-8000-000000000099";
            const tampered = new Uint8Array(row.encrypted_envelope.ciphertext);
            tampered[0] ^= 0x01;
            row.encrypted_envelope.ciphertext = tampered;
          } },
          { name: "superseded-self-reference", apply: (row) => {
            row.status = "superseded_by";
            row.superseded_by = row.operation_id;
          } },
          { name: "queued-with-superseded-marker", apply: (row) => {
            row.superseded_by = "44444444-9011-4000-8000-000000000099";
          } },
          { name: "envelope-id-mismatch", apply: async (row, operationId) => {
            const decrypted = await s.decryptPayload(ctx.key, row.encrypted_envelope, ownerId, s.STORAGE_STORES.operations, operationId);
            if (!decrypted.ok) throw new Error("test setup could not decrypt the envelope");
            const envelope = decrypted.value as any;
            envelope.operation_id = "44444444-9011-4000-8000-000000000099";
            const encrypted = await s.encryptPayload(ctx.key, ownerId, ctx.keyId, s.STORAGE_STORES.operations, operationId, envelope);
            const hash = await s.computeCanonicalHash(envelope);
            if (!encrypted.ok || !hash) throw new Error("test setup could not prepare corrupted envelope");
            row.encrypted_envelope = encrypted.value;
            row.request_hash = hash.hash;
          } },
        ];
        const codes: Array<{ name: string; sendableCode: string | null; replayCode: string | null; rowRetained: boolean; baselineOk: boolean }> = [];
        for (let index = 0; index < cases.length; index += 1) {
          const baselineSendable = await gateway.listSendableOperations(ctx);
          const baselineReplay = await (gateway as any).listOutboxForReplay(ctx);
          const baselineOk = baselineSendable.ok && baselineSendable.value.length === 0 &&
            baselineReplay?.ok && baselineReplay.value.length === 0;
          const operationId = `22222222-9011-4000-8000-${(index + 1).toString().padStart(12, "0")}`;
          const saved = await gateway.persistOperation({
            context: ctx,
            deviceId,
            operationId,
            commands: [{
              root: { kind: "plan", id: `44444444-9011-4000-8000-${(index + 1).toString().padStart(12, "0")}` },
              action: "plan.create",
              payload: { data: { name: `Integrity ${index}`, color_id: "green" } },
              precondition: null,
            }],
            dependencies: [],
            clockInput: {
              estimatedUtcMs: 1793480200000 + index,
              rawWallMs: 1793480200000 + index,
              calibrationId,
              quality: "calibrated",
            },
          });
          if (!saved.ok) return { setup: false, codes };
          const row = await new Promise<any>((resolve, reject) => {
            const tx = db.transaction(s.STORAGE_STORES.operations, "readonly");
            const req = tx.objectStore(s.STORAGE_STORES.operations).get([ownerId, operationId]);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          await cases[index].apply(row, operationId);
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(s.STORAGE_STORES.operations, "readwrite");
            const store = tx.objectStore(s.STORAGE_STORES.operations);
            if (row.operation_id !== operationId) store.delete([ownerId, operationId]);
            store.put(row);
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
          });
          const beforeCount = await new Promise<number>((resolve, reject) => {
            const tx = db.transaction(s.STORAGE_STORES.operations, "readonly");
            const req = tx.objectStore(s.STORAGE_STORES.operations).count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          const sendable = await gateway.listSendableOperations(ctx);
          const replayMethod = (gateway as any).listOutboxForReplay;
          const replay = typeof replayMethod === "function" ? await replayMethod.call(gateway, ctx) : null;
          const afterCount = await new Promise<number>((resolve, reject) => {
            const tx = db.transaction(s.STORAGE_STORES.operations, "readonly");
            const req = tx.objectStore(s.STORAGE_STORES.operations).count();
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });
          codes.push({
            name: cases[index].name,
            sendableCode: sendable.ok ? null : sendable.error.code,
            replayCode: replay?.ok ? null : replay?.error.code ?? "missing_api",
            rowRetained: beforeCount === afterCount,
            baselineOk,
          });
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(s.STORAGE_STORES.operations, "readwrite");
            tx.objectStore(s.STORAGE_STORES.operations).delete([ownerId, row.operation_id]);
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
          });
        }
        gateway.close();
        s.closeDatabase(db);
        return { setup: true, codes };
      });

      expect(result.setup).toBe(true);
      expect(result.codes.map((entry: any) => entry.sendableCode)).toEqual(Array(result.codes.length).fill("integrity_failed"));
      expect(result.codes.map((entry: any) => entry.replayCode)).toEqual(Array(result.codes.length).fill("integrity_failed"));
      expect(result.codes.every((entry: any) => entry.rowRetained)).toBe(true);
      expect(result.codes.every((entry: any) => entry.baselineOk)).toBe(true);
      expect(pageErrors).toEqual([]);
    });

    test("N09: clock quality must be explicit and rejected inputs leave outbox and sequence untouched", async ({ page }) => {
      const rawAdvanceHlc = advanceHlc as unknown as (...args: any[]) => HlcEditTime;
      const directErrorCode = (run: () => unknown): string | null => {
        try {
          run();
          return null;
        } catch (error) {
          return error instanceof StorageError ? error.code : "unexpected_error";
        }
      };
      const calibrationId = "55555555-9012-4000-8000-000000000001";
      const directCodes = [
        directErrorCode(() => rawAdvanceHlc(null, 1793480300000, calibrationId)),
        directErrorCode(() => rawAdvanceHlc(null, 1793480300000, calibrationId, undefined)),
        directErrorCode(() => rawAdvanceHlc(null, 1793480300000, calibrationId, null)),
      ];

      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });
      const result = await page.evaluate(async () => {
        const s = window.__dayforge_storage_atomicity;
        const ownerId = "11111111-9012-4000-8000-000000000001";
        const deviceId = "33333333-9012-4000-8000-000000000001";
        const calibrationId = "55555555-9012-4000-8000-000000000001";
        const open = await s.openDatabase({ name: `n09-${crypto.randomUUID()}` });
        if (!open.ok) return { setup: false, rejected: [], directCodes: [], countAfterRejected: -1, metadataAfterRejected: true, untrustedOk: false, untrustedStatus: null };
        const db = open.value;
        const key = await s.generateTestKey();
        const unlocked = await s.unlockOwner(db, ownerId, "n09-key", key);
        if (!unlocked.ok) return { setup: false, rejected: [], directCodes: [], countAfterRejected: -1, metadataAfterRejected: true, untrustedOk: false, untrustedStatus: null };
        const gateway = s.createLocalStorageGateway({ name: db.name });
        const makeInput = (index: number, clockInput: any, editTime?: any) => ({
          context: unlocked.value,
          deviceId,
          operationId: `22222222-9012-4000-8000-${index.toString().padStart(12, "0")}`,
          commands: [{
            root: { kind: "plan", id: `44444444-9012-4000-8000-${index.toString().padStart(12, "0")}` },
            action: "plan.create",
            payload: { data: { name: `Clock ${index}`, color_id: "green" } },
            precondition: null,
          }],
          dependencies: [],
          clockInput,
          editTime,
        });
        const clockBase = { estimatedUtcMs: 1793480300000, rawWallMs: 1793480300000, calibrationId };
        const editTimeBase = { physical_ms: 1793480300000, logical: 0, calibration_id: calibrationId, raw_wall_ms: 1793480300000 };
        const invalidInputs = [
          makeInput(1, clockBase),
          makeInput(2, { ...clockBase, quality: undefined }),
          makeInput(3, { ...clockBase, quality: null }),
          makeInput(4, { ...clockBase, quality: "bogus" }),
          makeInput(5, { ...clockBase }, { ...editTimeBase, quality: "calibrated" }),
          makeInput(6, undefined, editTimeBase),
        ];
        const rejected = [];
        for (const input of invalidInputs) {
          const saved = await (gateway.persistOperation as any)(input);
          rejected.push({ ok: saved.ok, code: saved.ok ? null : saved.error.code });
        }
        const stateAfterRejected = await new Promise<{ count: number; deviceMeta: unknown }>((resolve, reject) => {
          const tx = db.transaction([s.STORAGE_STORES.operations, s.STORAGE_STORES.device_meta], "readonly");
          const countReq = tx.objectStore(s.STORAGE_STORES.operations).count(IDBKeyRange.bound([ownerId, ""], [ownerId, "\uffff"]));
          const metaReq = tx.objectStore(s.STORAGE_STORES.device_meta).get([ownerId, deviceId]);
          tx.oncomplete = () => resolve({ count: countReq.result, deviceMeta: metaReq.result ?? null });
          tx.onerror = () => reject(tx.error);
        });
        const untrusted = await (gateway.persistOperation as any)(makeInput(99, { ...clockBase, quality: "untrusted" }));
        const row = await new Promise<any>((resolve, reject) => {
          const tx = db.transaction(s.STORAGE_STORES.operations, "readonly");
          const req = tx.objectStore(s.STORAGE_STORES.operations).get([ownerId, "22222222-9012-4000-8000-000000000099"]);
          req.onsuccess = () => resolve(req.result ?? null);
          req.onerror = () => reject(req.error);
        });
        gateway.close();
        s.closeDatabase(db);
        return {
          setup: true,
          rejected,
          countAfterRejected: stateAfterRejected.count,
          metadataAfterRejected: stateAfterRejected.deviceMeta !== null,
          untrustedOk: untrusted.ok,
          untrustedStatus: row?.status ?? null,
        };
      });

      expect(directCodes).toEqual(["invalid_data", "invalid_data", "invalid_data"]);
      expect(result.setup).toBe(true);
      expect(result.rejected.map((entry: any) => entry.code)).toEqual(Array(6).fill("invalid_data"));
      expect(result.countAfterRejected).toBe(0);
      expect(result.metadataAfterRejected).toBe(false);
      expect(result.untrustedOk).toBe(true);
      expect(result.untrustedStatus).toBe("time_invalid");
    });

    test("R04: connection closing during outbox decryption returns a typed storage error", async ({ page }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });
      const result = await page.evaluate(async () => {
        const s = window.__dayforge_storage_atomicity;
        const ownerId = "11111111-9004-4000-8000-000000000001";
        const open = await s.openDatabase({ name: `r04-${crypto.randomUUID()}` });
        if (!open.ok) return { setup: false };
        const db = open.value;
        const key = await s.generateTestKey();
        const unlocked = await s.unlockOwner(db, ownerId, "r04-key", key);
        if (!unlocked.ok) return { setup: false };
        const gateway = s.createLocalStorageGateway({ name: db.name });
        const saved = await gateway.persistOperation({
          context: unlocked.value,
          deviceId: "33333333-9004-4000-8000-000000000001",
          operationId: "22222222-9004-4000-8000-000000000001",
          commands: [{ root: { kind: "plan", id: "44444444-9004-4000-8000-000000000001" }, action: "plan.create", payload: { data: { name: "read", color_id: "green" } }, precondition: null }],
          dependencies: [],
          clockInput: { estimatedUtcMs: 1793480000000, rawWallMs: 1793480000000, calibrationId: "55555555-9004-4000-8000-000000000001", quality: "calibrated" },
        });
        if (!saved.ok) return { setup: false };
        const originalDecrypt = crypto.subtle.decrypt.bind(crypto.subtle);
        crypto.subtle.decrypt = async (...args) => { const plaintext = await originalDecrypt(...args); db.close(); return plaintext; };
        try {
          const read = await s.listOutboxForReplay(db, unlocked.value);
          return { setup: true, returnedResult: true, ok: read.ok, errorCode: read.ok ? null : read.error.code };
        } catch (error) {
          return { setup: true, returnedResult: false, errorName: error instanceof Error ? error.name : "unknown" };
        } finally {
          crypto.subtle.decrypt = originalDecrypt;
          gateway.close();
        }
      });
      expect(result.setup).toBe(true);
      expect(result.returnedResult).toBe(true);
      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("unavailable");
    });
  });
});

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
  createAad,
  generateTestKey,
  importRawKey,
  encryptPayload,
  decryptPayload,
  storeCryptoKey,
  getCryptoKey,
  removeCryptoKey,
  getOwnerMeta,
  setOwnerMeta,
  validateOwnerAccess,
  lockOwner,
  unlockOwner,
  isOwnerUnlocked,
  getRecord,
  createLocalStorageGateway,
  type EncryptedRecord,
  type OwnerAccessContext,
  type OwnerMetadata,
} from "../lib/storage";

declare global {
  interface Window {
    __dayforge_security_storage: {
      StorageError: typeof StorageError;
      DB_NAME: typeof DB_NAME;
      STORAGE_STORES: typeof STORAGE_STORES;
      openDatabase: typeof openDatabase;
      closeDatabase: typeof closeDatabase;
      createAad: typeof createAad;
      generateTestKey: typeof generateTestKey;
      importRawKey: typeof importRawKey;
      encryptPayload: typeof encryptPayload;
      decryptPayload: typeof decryptPayload;
      storeCryptoKey: typeof storeCryptoKey;
      getCryptoKey: typeof getCryptoKey;
      removeCryptoKey: typeof removeCryptoKey;
      getOwnerMeta: typeof getOwnerMeta;
      setOwnerMeta: typeof setOwnerMeta;
      validateOwnerAccess: typeof validateOwnerAccess;
      lockOwner: typeof lockOwner;
      unlockOwner: typeof unlockOwner;
      isOwnerUnlocked: typeof isOwnerUnlocked;
      getRecord: typeof getRecord;
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
    window.__dayforge_security_storage = exports;
  })();`;
}

test.describe("Storage Security Specifications", () => {
  test.describe("Cryptographic Foundation & AAD Binding", () => {
    test("createAad produces canonical UTF-8 encoded binding format", () => {
      const aad = createAad("owner-123", "key-456", "records", "rec-789");
      const decoded = new TextDecoder().decode(aad);
      expect(decoded).toBe("owner-123:key-456:records:rec-789");
    });

    test("generateTestKey creates a 256-bit nonextractable AES-GCM key", async () => {
      const key = await generateTestKey();
      expect(key.type).toBe("secret");
      expect(key.extractable).toBe(false);
      expect(key.algorithm.name).toBe("AES-GCM");
      expect(key.usages).toContain("encrypt");
      expect(key.usages).toContain("decrypt");
    });

    test("importRawKey imports 32-byte raw bytes as nonextractable key and rejects invalid length", async () => {
      const rawBytes = new Uint8Array(32).fill(0x42);
      const key = await importRawKey(rawBytes);
      expect(key.extractable).toBe(false);
      expect(key.algorithm.name).toBe("AES-GCM");

      const shortBytes = new Uint8Array(16).fill(0x42);
      await expect(importRawKey(shortBytes)).rejects.toThrow();
    });

    test("encryptPayload and decryptPayload roundtrip Unicode, multiline text, nulls, and nested structures", async () => {
      const key = await generateTestKey();
      const testCases = [
        {
          note: "Multiline note\nLine 2 with special chars: 🧑‍💻 🎉 \u2028 \t and Tiếng Việt: Cà phê sữa đá!",
          count: 42,
          active: true,
          tags: ["alpha", "beta", "gamma"],
        },
        null,
        "",
        {
          nested: {
            deep: {
              value: null,
              arr: [1, null, "test", false],
            },
          },
        },
      ];

      for (const [idx, payload] of testCases.entries()) {
        const recordId = `rec-${idx}`;
        const encRes = await encryptPayload(
          key,
          "owner-alice",
          "key-1",
          "records",
          recordId,
          payload
        );
        expect(encRes.ok).toBe(true);
        if (!encRes.ok) continue;

        const record: EncryptedRecord = encRes.value;
        expect(record.owner_id).toBe("owner-alice");
        expect(record.store).toBe("records");
        expect(record.record_id).toBe(recordId);
        expect(record.key_id).toBe("key-1");
        expect(record.iv.byteLength).toBe(12);
        expect(record.ciphertext.byteLength).toBeGreaterThan(0);

        const decRes = await decryptPayload<typeof payload>(
          key,
          record,
          "owner-alice",
          "records",
          recordId
        );
        expect(decRes.ok).toBe(true);
        if (!decRes.ok) continue;

        expect(decRes.value).toEqual(payload);
      }
    });

    test("tampered ciphertext fails closed with integrity_failed error", async () => {
      const key = await generateTestKey();
      const encRes = await encryptPayload(
        key,
        "owner-alice",
        "key-1",
        "records",
        "rec-safe",
        { secret: "confidential" }
      );
      expect(encRes.ok).toBe(true);
      if (!encRes.ok) return;

      const record = encRes.value;
      const corruptedCiphertext = new Uint8Array(record.ciphertext);
      corruptedCiphertext[0] ^= 0xff;

      const tamperedRecord: EncryptedRecord = {
        ...record,
        ciphertext: corruptedCiphertext,
      };

      const decRes = await decryptPayload(
        key,
        tamperedRecord,
        "owner-alice",
        "records",
        "rec-safe"
      );
      expect(decRes.ok).toBe(false);
      if (!decRes.ok) {
        expect(decRes.error).toBeInstanceOf(StorageError);
        expect(decRes.error.code).toBe("integrity_failed");
        expect(decRes.error.message).toContain("Failed to decrypt or authenticate record");
      }
    });

    test("tampered IV fails closed with integrity_failed error", async () => {
      const key = await generateTestKey();
      const encRes = await encryptPayload(
        key,
        "owner-alice",
        "key-1",
        "records",
        "rec-iv-test",
        { data: "sensitive" }
      );
      expect(encRes.ok).toBe(true);
      if (!encRes.ok) return;

      const record = encRes.value;
      const corruptedIv = new Uint8Array(record.iv);
      corruptedIv[0] ^= 0x01;

      const tamperedRecord: EncryptedRecord = {
        ...record,
        iv: corruptedIv,
      };

      const decRes = await decryptPayload(
        key,
        tamperedRecord,
        "owner-alice",
        "records",
        "rec-iv-test"
      );
      expect(decRes.ok).toBe(false);
      if (!decRes.ok) {
        expect(decRes.error.code).toBe("integrity_failed");
      }
    });

    test("ST-09: AAD tampering and ciphertext swap across records or stores fails closed with integrity_failed", async () => {
      const key = await generateTestKey();
      const enc1 = await encryptPayload(
        key,
        "owner-alice",
        "key-1",
        "records",
        "event-1",
        { title: "Meeting 1" }
      );
      const enc2 = await encryptPayload(
        key,
        "owner-alice",
        "key-1",
        "records",
        "event-2",
        { title: "Meeting 2" }
      );
      expect(enc1.ok).toBe(true);
      expect(enc2.ok).toBe(true);
      if (!enc1.ok || !enc2.ok) return;

      // 1. Swapping recordId in expected parameter
      const swapRecordId = await decryptPayload(
        key,
        enc1.value,
        "owner-alice",
        "records",
        "event-2"
      );
      expect(swapRecordId.ok).toBe(false);
      if (!swapRecordId.ok) {
        expect(swapRecordId.error.code).toBe("integrity_failed");
      }

      // 2. Swapping store in expected parameter
      const swapStore = await decryptPayload(
        key,
        enc1.value,
        "owner-alice",
        "drafts",
        "event-1"
      );
      expect(swapStore.ok).toBe(false);
      if (!swapStore.ok) {
        expect(swapStore.error.code).toBe("integrity_failed");
      }

      // 3. Swapping owner in expected parameter
      const swapOwner = await decryptPayload(
        key,
        enc1.value,
        "owner-bob",
        "records",
        "event-1"
      );
      expect(swapOwner.ok).toBe(false);
      if (!swapOwner.ok) {
        expect(swapOwner.error.code).toBe("integrity_failed");
      }

      // 4. Record envelope claims event-2 but holds event-1 ciphertext
      const forgedRecord: EncryptedRecord = {
        ...enc1.value,
        record_id: "event-2",
      };
      const forgedDec = await decryptPayload(
        key,
        forgedRecord,
        "owner-alice",
        "records",
        "event-2"
      );
      expect(forgedDec.ok).toBe(false);
      if (!forgedDec.ok) {
        expect(forgedDec.error.code).toBe("integrity_failed");
      }
    });

    test("ST-08: Owner isolation — Owner A cannot decrypt with Owner B key", async () => {
      const keyA = await generateTestKey();
      const keyB = await generateTestKey();

      const encA = await encryptPayload(
        keyA,
        "owner-alice",
        "key-alice-1",
        "records",
        "shared-id",
        { sensitive: "Alice confidential payroll" }
      );
      expect(encA.ok).toBe(true);
      if (!encA.ok) return;

      // Bob tries to decrypt Alice's record using Bob's key
      const bobDecWithBobKey = await decryptPayload(
        keyB,
        encA.value,
        "owner-alice",
        "records",
        "shared-id"
      );
      expect(bobDecWithBobKey.ok).toBe(false);
      if (!bobDecWithBobKey.ok) {
        expect(bobDecWithBobKey.error.code).toBe("integrity_failed");
      }

      // Bob tries to claim record belongs to Bob and decrypt with Bob's key
      const bobDecAsBob = await decryptPayload(
        keyB,
        encA.value,
        "owner-bob",
        "records",
        "shared-id"
      );
      expect(bobDecAsBob.ok).toBe(false);
      if (!bobDecAsBob.ok) {
        expect(bobDecAsBob.error.code).toBe("integrity_failed");
      }
    });
  });

  test.describe("Browser IndexedDB Security, Key Lifecycle & Owner Gating", () => {
    test.beforeEach(async ({ page }) => {
      const script = buildStorageScript();
      await page.addInitScript({ content: script });
      await page.goto("/work");
      await page.evaluate(async (dbName) => {
        return new Promise<void>((resolve, reject) => {
          const req = indexedDB.deleteDatabase(dbName);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
          req.onblocked = () => resolve();
        });
      }, DB_NAME);
    });

    test("Nonextractable CryptoKey storage in IndexedDB, structured clone, reload, and unexportability", async ({
      page,
    }) => {
      // 1. Generate key in browser, store via storeCryptoKey, verify unexportable
      const initialStep = await page.evaluate(async () => {
        const { openDatabase, closeDatabase, generateTestKey, storeCryptoKey, getCryptoKey } =
          window.__dayforge_security_storage;

        const dbRes = await openDatabase();
        if (!dbRes.ok) return { ok: false as const, error: dbRes.error.code };
        const db = dbRes.value;

        const key = await generateTestKey();
        const storeRes = await storeCryptoKey(db, "owner-alice", "key-1", key);
        if (!storeRes.ok) {
          closeDatabase(db);
          return { ok: false as const, error: storeRes.error.code };
        }

        const retrievedRes = await getCryptoKey(db, "owner-alice", "key-1");
        if (!retrievedRes.ok) {
          closeDatabase(db);
          return { ok: false as const, error: retrievedRes.error.code };
        }

        const retrievedKey = retrievedRes.value;
        const isNonExtractable = retrievedKey.extractable === false;

        let exportThrew = false;
        try {
          await crypto.subtle.exportKey("raw", retrievedKey);
        } catch {
          exportThrew = true;
        }

        closeDatabase(db);
        return {
          ok: true as const,
          isNonExtractable,
          exportThrew,
        };
      });

      expect(initialStep.ok).toBe(true);
      if (!initialStep.ok) return;
      expect(initialStep.isNonExtractable).toBe(true);
      expect(initialStep.exportThrew).toBe(true);

      // 2. Encrypt record with stored key, reload page, reopen DB, retrieve key, and decrypt successfully
      const encryptBeforeReload = await page.evaluate(async () => {
        const { openDatabase, closeDatabase, getCryptoKey, encryptPayload } =
          window.__dayforge_security_storage;

        const dbRes = await openDatabase();
        if (!dbRes.ok) return { ok: false as const, error: dbRes.error.code };
        const db = dbRes.value;

        const keyRes = await getCryptoKey(db, "owner-alice", "key-1");
        if (!keyRes.ok) {
          closeDatabase(db);
          return { ok: false as const, error: keyRes.error.code };
        }

        const encRes = await encryptPayload(
          keyRes.value,
          "owner-alice",
          "key-1",
          "records",
          "rec-persistent-1",
          { secretNote: "Preserved across page reload!" }
        );

        closeDatabase(db);
        if (!encRes.ok) return { ok: false as const, error: encRes.error.code };

        return {
          ok: true as const,
          record: {
            owner_id: encRes.value.owner_id,
            store: encRes.value.store,
            record_id: encRes.value.record_id,
            key_id: encRes.value.key_id,
            iv: Array.from(encRes.value.iv),
            ciphertext: Array.from(encRes.value.ciphertext),
          },
        };
      });

      expect(encryptBeforeReload.ok).toBe(true);
      if (!encryptBeforeReload.ok) return;

      // Reload page to verify persistence across sessions/pages
      await page.reload();

      const decryptAfterReload = await page.evaluate(
        async (recData: {
          owner_id: string;
          store: string;
          record_id: string;
          key_id: string;
          iv: number[];
          ciphertext: number[];
        }) => {
          const { openDatabase, closeDatabase, getCryptoKey, decryptPayload } =
            window.__dayforge_security_storage;

          const dbRes = await openDatabase();
          if (!dbRes.ok) return { ok: false as const, error: dbRes.error.code };
          const db = dbRes.value;

          const keyRes = await getCryptoKey(db, "owner-alice", "key-1");
          if (!keyRes.ok) {
            closeDatabase(db);
            return { ok: false as const, error: keyRes.error.code };
          }

          const record = {
            owner_id: recData.owner_id,
            store: recData.store,
            record_id: recData.record_id,
            key_id: recData.key_id,
            iv: new Uint8Array(recData.iv),
            ciphertext: new Uint8Array(recData.ciphertext),
          };

          const decRes = await decryptPayload<{ secretNote: string }>(
            keyRes.value,
            record,
            "owner-alice",
            "records",
            "rec-persistent-1"
          );

          closeDatabase(db);
          if (!decRes.ok) return { ok: false as const, error: decRes.error.code };

          return { ok: true as const, value: decRes.value };
        },
        encryptBeforeReload.record
      );

      expect(decryptAfterReload.ok).toBe(true);
      if (!decryptAfterReload.ok) return;
      expect(decryptAfterReload.value).toEqual({
        secretNote: "Preserved across page reload!",
      });

      // 3. removeCryptoKey deletes the key cleanly
      const removeStep = await page.evaluate(async () => {
        const { openDatabase, closeDatabase, removeCryptoKey, getCryptoKey } =
          window.__dayforge_security_storage;

        const dbRes = await openDatabase();
        if (!dbRes.ok) return { ok: false as const, error: dbRes.error.code };
        const db = dbRes.value;

        const remRes = await removeCryptoKey(db, "owner-alice", "key-1");
        if (!remRes.ok) {
          closeDatabase(db);
          return { ok: false as const, error: remRes.error.code };
        }

        const getAgain = await getCryptoKey(db, "owner-alice", "key-1");
        closeDatabase(db);

        return {
          ok: true as const,
          getOk: getAgain.ok,
          errorCode: !getAgain.ok ? getAgain.error.code : null,
        };
      });

      expect(removeStep.ok).toBe(true);
      if (!removeStep.ok) return;
      expect(removeStep.getOk).toBe(false);
      expect(removeStep.errorCode).toBe("unavailable");
    });

    test("ST-10: Owner gating, lockOwner, unlockOwner, and lock epoch validation", async ({
      page,
    }) => {
      const result = await page.evaluate(async () => {
        const {
          openDatabase,
          closeDatabase,
          generateTestKey,
          unlockOwner,
          lockOwner,
          validateOwnerAccess,
          getCryptoKey,
          getOwnerMeta,
        } = window.__dayforge_security_storage;

        const dbRes = await openDatabase();
        if (!dbRes.ok) return { step: "open", ok: false as const, error: dbRes.error.code };
        const db = dbRes.value;

        // Step 1: Owner before unlock
        const metaBefore = await getOwnerMeta(db, "owner-bob");
        if (!metaBefore.ok) {
          closeDatabase(db);
          return { step: "metaBefore", ok: false as const, error: metaBefore.error.code };
        }

        const key1 = await generateTestKey();

        // Step 2: Unlock owner for the first time
        const unlock1Res = await unlockOwner(db, "owner-bob", "key-bob-1", key1);
        if (!unlock1Res.ok) {
          closeDatabase(db);
          return { step: "unlock1", ok: false as const, error: unlock1Res.error.code };
        }
        const ctx1 = unlock1Res.value;

        // Validate access with ctx1 -> should succeed
        const val1 = await validateOwnerAccess(db, ctx1);
        if (!val1.ok) {
          closeDatabase(db);
          return { step: "val1", ok: false as const, error: val1.error.code };
        }

        // Key should be present in crypto_keys
        const keyCheck1 = await getCryptoKey(db, "owner-bob", "key-bob-1");
        if (!keyCheck1.ok) {
          closeDatabase(db);
          return { step: "keyCheck1", ok: false as const, error: keyCheck1.error.code };
        }

        // Step 3: Lock owner (simulate logout)
        const lockRes = await lockOwner(db, "owner-bob");
        if (!lockRes.ok) {
          closeDatabase(db);
          return { step: "lock", ok: false as const, error: lockRes.error.code };
        }
        const newEpoch = lockRes.value;

        // Verify owner_meta is locked and epoch incremented
        const metaAfterLock = await getOwnerMeta(db, "owner-bob");
        if (!metaAfterLock.ok) {
          closeDatabase(db);
          return { step: "metaAfterLock", ok: false as const, error: metaAfterLock.error.code };
        }

        // Validate access with ctx1 -> MUST fail with 'locked'
        const valAfterLock = await validateOwnerAccess(db, ctx1);

        // Crypto key in IDB MUST have been purged
        const keyAfterLock = await getCryptoKey(db, "owner-bob", "key-bob-1");

        // Step 4: Re-unlock with the same stable key after lock and verify stale context rejection
        const unlock2Res = await unlockOwner(db, "owner-bob", "key-bob-1", key1);
        if (!unlock2Res.ok) {
          closeDatabase(db);
          return { step: "unlock2", ok: false as const, error: unlock2Res.error.code };
        }
        const ctx2 = unlock2Res.value;

        // ctx2 should be valid
        const val2 = await validateOwnerAccess(db, ctx2);

        // STALE ctx1 (epoch 1) MUST be rejected with 'locked' because current epoch is 2
        const valStaleCtx1 = await validateOwnerAccess(db, ctx1);

        closeDatabase(db);
        return {
          step: "done",
          ok: true as const,
          initialMetaNull: metaBefore.value === null,
          ctx1Epoch: ctx1.lockEpoch,
          newEpoch,
          metaLocked: metaAfterLock.value?.locked,
          metaEpoch: metaAfterLock.value?.lock_epoch,
          valAfterLockOk: valAfterLock.ok,
          valAfterLockError: !valAfterLock.ok ? valAfterLock.error.code : null,
          keyAfterLockOk: keyAfterLock.ok,
          keyAfterLockError: !keyAfterLock.ok ? keyAfterLock.error.code : null,
          val2Ok: val2.ok,
          ctx2Epoch: ctx2.lockEpoch,
          valStaleCtx1Ok: valStaleCtx1.ok,
          valStaleCtx1Error: !valStaleCtx1.ok ? valStaleCtx1.error.code : null,
        };
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.initialMetaNull).toBe(true);
      expect(result.ctx1Epoch).toBe(1);
      expect(result.newEpoch).toBe(2);
      expect(result.metaLocked).toBe(true);
      expect(result.metaEpoch).toBe(2);
      expect(result.valAfterLockOk).toBe(false);
      expect(result.valAfterLockError).toBe("locked");
      expect(result.keyAfterLockOk).toBe(false);
      expect(result.keyAfterLockError).toBe("unavailable");
      expect(result.val2Ok).toBe(true);
      expect(result.ctx2Epoch).toBe(2);
      expect(result.valStaleCtx1Ok).toBe(false);
      expect(result.valStaleCtx1Error).toBe("locked");
    });

    test("unlockOwner rejects unexpected different keyId (both when unlocked and after lock) and fails closed on missing active_key_id", async ({
      page,
    }) => {
      const script = buildStorageScript();
      await page.addInitScript(script);
      await page.goto("/work");

      const result = await page.evaluate(async () => {
        const {
          openDatabase,
          closeDatabase,
          unlockOwner,
          lockOwner,
          validateOwnerAccess,
          generateTestKey,
          getOwnerMeta,
          isOwnerUnlocked,
          STORAGE_STORES,
        } = window.__dayforge_security_storage;

        const dbRes = await openDatabase({ name: "test-reject-diff-key" });
        if (!dbRes.ok) return { ok: false, error: "open failed" };
        const db = dbRes.value;

        const key1 = await generateTestKey();
        const unlock1 = await unlockOwner(db, "owner-alice", "key-1", key1);
        if (!unlock1.ok) {
          closeDatabase(db);
          return { ok: false, error: "unlock1 failed" };
        }
        const ctx1 = unlock1.value;

        // 1. Attempt re-unlock with different key while unlocked -> MUST be rejected with invalid_data
        const key2 = await generateTestKey();
        const unlockDiffWhileUnlocked = await unlockOwner(db, "owner-alice", "key-2", key2);

        // 2. Lock owner
        const lockRes = await lockOwner(db, "owner-alice");
        if (!lockRes.ok) {
          closeDatabase(db);
          return { ok: false, error: "lock failed" };
        }

        // 3. Attempt unlock with different key while locked -> MUST be rejected with invalid_data
        const unlockDiffWhileLocked = await unlockOwner(db, "owner-alice", "key-2", key2);

        // 4. Missing active_key_id fail-closed check
        await new Promise<void>((resolve) => {
          const tx = db.transaction(STORAGE_STORES.owner_meta, "readwrite");
          tx.objectStore(STORAGE_STORES.owner_meta).put({
            owner_id: "owner-alice",
            lock_epoch: 2,
            locked: false,
            // active_key_id omitted
          });
          tx.oncomplete = () => resolve();
        });

        // Missing active_key_id fails closed in validateOwnerAccess
        const missingKeyAccess = await validateOwnerAccess(db, ctx1);

        // Missing active_key_id also fails closed in unlockOwner
        const unlockMissingKey = await unlockOwner(db, "owner-alice", "key-1", key1);

        // Restore stable state after lock: re-unlock with key-1 succeeds
        await lockOwner(db, "owner-alice");
        await new Promise<void>((resolve) => {
          const tx = db.transaction(STORAGE_STORES.owner_meta, "readwrite");
          tx.objectStore(STORAGE_STORES.owner_meta).put({
            owner_id: "owner-alice",
            lock_epoch: 3,
            locked: true,
            active_key_id: "key-1",
          });
          tx.oncomplete = () => resolve();
        });
        const unlockStable = await unlockOwner(db, "owner-alice", "key-1", key1);

        closeDatabase(db);

        return {
          ok: true,
          unlockDiffWhileUnlockedOk: unlockDiffWhileUnlocked.ok,
          unlockDiffWhileUnlockedCode: !unlockDiffWhileUnlocked.ok ? unlockDiffWhileUnlocked.error.code : null,
          unlockDiffWhileLockedOk: unlockDiffWhileLocked.ok,
          unlockDiffWhileLockedCode: !unlockDiffWhileLocked.ok ? unlockDiffWhileLocked.error.code : null,
          missingKeyAccessOk: missingKeyAccess.ok,
          missingKeyAccessCode: !missingKeyAccess.ok ? missingKeyAccess.error.code : null,
          unlockMissingKeyOk: unlockMissingKey.ok,
          unlockMissingKeyCode: !unlockMissingKey.ok ? unlockMissingKey.error.code : null,
          unlockStableOk: unlockStable.ok,
        };
      });

      expect(result.ok).toBe(true);
      expect(result.unlockDiffWhileUnlockedOk).toBe(false);
      expect(result.unlockDiffWhileUnlockedCode).toBe("invalid_data");
      expect(result.unlockDiffWhileLockedOk).toBe(false);
      expect(result.unlockDiffWhileLockedCode).toBe("invalid_data");
      expect(result.missingKeyAccessOk).toBe(false);
      expect(result.missingKeyAccessCode).toBe("locked");
      expect(result.unlockMissingKeyOk).toBe(false);
      expect(result.unlockMissingKeyCode).toBe("invalid_data");
      expect(result.unlockStableOk).toBe(true);
    });

    test("unlockOwner rejects keys that are extractable or lack encrypt/decrypt usages", async ({
      page,
    }) => {
      const script = buildStorageScript();
      await page.addInitScript(script);
      await page.goto("/work");

      const result = await page.evaluate(async () => {
        const { openDatabase, closeDatabase, unlockOwner } =
          window.__dayforge_security_storage;

        const dbRes = await openDatabase({ name: "test-invalid-key" });
        if (!dbRes.ok) return { ok: false, error: "open failed" };
        const db = dbRes.value;

        // 1. Extractable key (forbidden)
        const extractableKey = await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          true, // extractable = true
          ["encrypt", "decrypt"]
        );

        const res1 = await unlockOwner(db, "owner-bad", "key-ext", extractableKey);

        // 2. Key missing encrypt usage
        const encryptOnlyKey = await crypto.subtle.generateKey(
          { name: "AES-GCM", length: 256 },
          false,
          ["encrypt"]
        );
        const res2 = await unlockOwner(db, "owner-bad", "key-enc", encryptOnlyKey);

        closeDatabase(db);

        return {
          ok: true,
          res1Ok: res1.ok,
          res1Error: !res1.ok ? res1.error.code : null,
          res2Ok: res2.ok,
          res2Error: !res2.ok ? res2.error.code : null,
        };
      });

      expect(result.ok).toBe(true);
      expect(result.res1Ok).toBe(false);
      expect(result.res1Error).toBe("invalid_data");
      expect(result.res2Ok).toBe(false);
      expect(result.res2Error).toBe("invalid_data");
    });

    test("full-row substitution across record IDs fails closed with integrity_failed via derived AAD", async ({
      page,
    }) => {
      const script = buildStorageScript();
      await page.addInitScript(script);
      await page.goto("/work");

      const result = await page.evaluate(async () => {
        const {
          openDatabase,
          closeDatabase,
          unlockOwner,
          generateTestKey,
          encryptPayload,
          getRecord,
          STORAGE_STORES,
        } = window.__dayforge_security_storage;

        const dbRes = await openDatabase({ name: "test-row-substitution" });
        if (!dbRes.ok) return { ok: false, error: "open failed" };
        const db = dbRes.value;

        const key = await generateTestKey();
        const unlockRes = await unlockOwner(db, "owner-sub", "key-1", key);
        if (!unlockRes.ok) {
          closeDatabase(db);
          return { ok: false, error: "unlock failed" };
        }
        const ctx = unlockRes.value;

        const idA = "11111111-1111-4111-8111-111111111111";
        const idB = "22222222-2222-4222-8222-222222222222";

        // Encrypt record B with its legitimate record_id "plan:idB"
        const encB = await encryptPayload(
          key,
          ctx.ownerId,
          ctx.keyId,
          STORAGE_STORES.records,
          `plan:${idB}`,
          { secret: "Top secret content of Record B" }
        );
        if (!encB.ok) {
          closeDatabase(db);
          return { ok: false, error: "encrypt failed" };
        }

        // Attacker substitutes record B's ciphertext under record A's row key:
        // Attempting to fool getRecord into decrypting row B as if it were record A
        const maliciousRow = {
          owner_id: ctx.ownerId,
          kind: "plan",
          id: idA,
          key_id: encB.value.key_id,
          store: STORAGE_STORES.records,
          record_id: `plan:${idB}`, // attacker leaves original or tampered field
          iv: encB.value.iv,
          ciphertext: encB.value.ciphertext,
        };

        await new Promise<void>((resolve) => {
          const tx = db.transaction(STORAGE_STORES.records, "readwrite");
          tx.objectStore(STORAGE_STORES.records).put(maliciousRow);
          tx.oncomplete = () => resolve();
        });

        // Calling getRecord for record A:
        // getRecord derives expected AAD strictly as STORAGE_STORES.records and "plan:idA"
        const getRes = await getRecord(db, ctx, "plan", idA);

        closeDatabase(db);

        return {
          ok: true,
          getResOk: getRes.ok,
          errorCode: !getRes.ok ? getRes.error.code : null,
        };
      });

      expect(result.ok).toBe(true);
      expect(result.getResOk).toBe(false);
      expect(result.errorCode).toBe("integrity_failed");
    });

    test("anti-TOCTOU: locked owner meta fails closed inside single-transaction read", async ({
      page,
    }) => {
      const script = buildStorageScript();
      await page.addInitScript(script);
      await page.goto("/work");

      const result = await page.evaluate(async () => {
        const {
          openDatabase,
          closeDatabase,
          unlockOwner,
          lockOwner,
          generateTestKey,
          getRecord,
        } = window.__dayforge_security_storage;

        const dbRes = await openDatabase({ name: "test-anti-toctou" });
        if (!dbRes.ok) return { ok: false, error: "open failed" };
        const db = dbRes.value;

        const key = await generateTestKey();
        const unlockRes = await unlockOwner(db, "owner-toctou", "key-1", key);
        if (!unlockRes.ok) {
          closeDatabase(db);
          return { ok: false, error: "unlock failed" };
        }
        const ctx = unlockRes.value;

        // Now lock the owner
        await lockOwner(db, "owner-toctou");

        // getRecord must fail immediately with 'locked' inside its single transaction
        const getRes = await getRecord(
          db,
          ctx,
          "plan",
          "11111111-1111-4111-8111-111111111111"
        );

        closeDatabase(db);

        return {
          ok: true,
          getResOk: getRes.ok,
          errorCode: !getRes.ok ? getRes.error.code : null,
        };
      });

      expect(result.ok).toBe(true);
      expect(result.getResOk).toBe(false);
      expect(result.errorCode).toBe("locked");
    });

    test("AES-128-GCM key is rejected by unlockOwner (enforcing A256GCM)", async ({
      page,
    }) => {
      const script = buildStorageScript();
      await page.addInitScript(script);
      await page.goto("/work");

      const result = await page.evaluate(async () => {
        const {
          openDatabase,
          closeDatabase,
          unlockOwner,
        } = window.__dayforge_security_storage;

        const dbRes = await openDatabase({ name: "test-aes128-rejected" });
        if (!dbRes.ok) return { ok: false, error: "open failed" };
        const db = dbRes.value;

        // Generate a 128-bit key
        const key128 = await window.crypto.subtle.generateKey(
          { name: "AES-GCM", length: 128 },
          false,
          ["encrypt", "decrypt"]
        );

        const unlockRes = await unlockOwner(db, "owner-aes128", "key-128", key128);
        closeDatabase(db);

        return {
          ok: true,
          unlockOk: unlockRes.ok,
          errorCode: !unlockRes.ok ? unlockRes.error.code : null,
          errorMessage: !unlockRes.ok ? unlockRes.error.message : null,
        };
      });

      expect(result.ok).toBe(true);
      expect(result.unlockOk).toBe(false);
      expect(result.errorCode).toBe("invalid_data");
      expect(result.errorMessage).toContain("256-bit");
    });

    test("old-AAD ciphertext remains readable across upgrades", async ({
      page,
    }) => {
      const script = buildStorageScript();
      await page.addInitScript(script);
      await page.goto("/work");

      const result = await page.evaluate(async () => {
        const {
          openDatabase,
          closeDatabase,
          unlockOwner,
          generateTestKey,
          getRecord,
          STORAGE_STORES,
        } = window.__dayforge_security_storage;

        const dbRes = await openDatabase({ name: "test-old-aad-compat" });
        if (!dbRes.ok) return { ok: false, error: "open failed" };
        const db = dbRes.value;

        const ownerId = "11111111-1111-4111-8111-111111111111";
        const keyId = "key-compat-1";
        const recordId = "22222222-2222-4222-8222-222222222222";
        const key = await generateTestKey();

        const unlockRes = await unlockOwner(db, ownerId, keyId, key);
        if (!unlockRes.ok) {
          closeDatabase(db);
          return { ok: false, error: "unlock failed" };
        }
        const ctx = unlockRes.value;

        // Encrypt with legacy/standard AAD format: `${ownerId}:${keyId}:${store}:${recordId}`
        const iv = window.crypto.getRandomValues(new Uint8Array(12));
        const aad = new TextEncoder().encode(`${ownerId}:${keyId}:${STORAGE_STORES.records}:plan:${recordId}`);
        const plaintext = new TextEncoder().encode(JSON.stringify({ name: "Legacy AAD Plan", upgraded: true }));

        const ciphertextBuffer = await window.crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
          key,
          plaintext
        );

        // Store directly in records store
        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORAGE_STORES.records, "readwrite");
          tx.objectStore(STORAGE_STORES.records).put({
            owner_id: ownerId,
            kind: "plan",
            id: recordId,
            key_id: keyId,
            iv,
            ciphertext: new Uint8Array(ciphertextBuffer),
            created_at: new Date().toISOString(),
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });

        // Read through getRecord - must successfully authenticate and decrypt
        const getRes = await getRecord<{ name: string; upgraded: boolean }>(db, ctx, "plan", recordId);
        closeDatabase(db);

        return {
          ok: true,
          getOk: getRes.ok,
          data: getRes.ok ? getRes.value : null,
        };
      });

      expect(result.ok).toBe(true);
      expect(result.getOk).toBe(true);
      expect(result.data?.name).toBe("Legacy AAD Plan");
      expect(result.data?.upgraded).toBe(true);
    });

    test("lock commits after ciphertext read but before plaintext returns: fails closed with locked", async ({
      page,
    }) => {
      const script = buildStorageScript();
      await page.addInitScript(script);
      await page.goto("/work");

      const result = await page.evaluate(async () => {
        const {
          openDatabase,
          closeDatabase,
          unlockOwner,
          lockOwner,
          generateTestKey,
          getRecord,
          encryptPayload,
          STORAGE_STORES,
        } = window.__dayforge_security_storage;

        const dbRes = await openDatabase({ name: "test-lock-race-decryption" });
        if (!dbRes.ok) return { ok: false, error: "open failed" };
        const db = dbRes.value;

        const ownerId = "11111111-1111-4111-8111-111111111111";
        const keyId = "key-race-1";
        const planId = "33333333-3333-4333-8333-333333333333";
        const key = await generateTestKey();

        const unlockRes = await unlockOwner(db, ownerId, keyId, key);
        if (!unlockRes.ok) {
          closeDatabase(db);
          return { ok: false, error: "unlock failed" };
        }
        const ctx = unlockRes.value;

        // Persist legitimate record
        const enc = await encryptPayload(
          key,
          ownerId,
          keyId,
          STORAGE_STORES.records,
          `plan:${planId}`,
          { secret: "sensitive data" }
        );
        if (!enc.ok) return { ok: false, error: "encrypt failed" };

        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(STORAGE_STORES.records, "readwrite");
          tx.objectStore(STORAGE_STORES.records).put({
            owner_id: ownerId,
            kind: "plan",
            id: planId,
            key_id: keyId,
            iv: enc.value.iv,
            ciphertext: enc.value.ciphertext,
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });

        // Hook decrypt to commit lock concurrently before plaintext return
        const originalDecrypt = window.crypto.subtle.decrypt;
        let lockCommittedDuringDecrypt = false;

        window.crypto.subtle.decrypt = async function (...args) {
          await lockOwner(db, ownerId);
          lockCommittedDuringDecrypt = true;
          return originalDecrypt.apply(window.crypto.subtle, args);
        };

        let getRes;
        try {
          getRes = await getRecord(db, ctx, "plan", planId);
        } finally {
          window.crypto.subtle.decrypt = originalDecrypt;
        }

        closeDatabase(db);

        return {
          ok: true,
          lockCommittedDuringDecrypt,
          getOk: getRes.ok,
          errorCode: !getRes.ok ? getRes.error.code : null,
        };
      });

      expect(result.ok).toBe(true);
      expect(result.lockCommittedDuringDecrypt).toBe(true);
      expect(result.getOk).toBe(false);
      expect(result.errorCode).toBe("locked");
    });
  });
});

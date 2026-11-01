import { expect, test } from "@playwright/test";
import { buildStorageBrowserHarness } from "./helpers/storage-browser-harness";
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
  confirmPulledOperationInTx,
  readOwnerViewPreference,
  writeOwnerViewPreference,
  OWNER_KEY_SENTINEL_RECORD_ID,
  type EncryptedRecord,
  type OwnerAccessContext,
  type OwnerMetadata,
} from "./storage-api";

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
      confirmPulledOperationInTx: typeof confirmPulledOperationInTx;
      readOwnerViewPreference: typeof readOwnerViewPreference;
      writeOwnerViewPreference: typeof writeOwnerViewPreference;
      OWNER_KEY_SENTINEL_RECORD_ID: string;
    };
  }
}

function buildStorageScript(): string {
  return buildStorageBrowserHarness("__dayforge_security_storage");
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

    test("N11: lockOwner deletes every crypto key across the full owner prefix", async ({ page }) => {
      const script = buildStorageScript();
      await page.addInitScript(script);
      await page.goto("/work");

      const result = await page.evaluate(async () => {
        const {
          openDatabase,
          closeDatabase,
          generateTestKey,
          storeCryptoKey,
          getCryptoKey,
          unlockOwner,
          lockOwner,
          STORAGE_STORES,
        } = window.__dayforge_security_storage;

        const ownerId = "owner-n11";
        const activeKeyId = "key-active";
        const highKeyId = "\uffff-extra-key";
        const dbRes = await openDatabase({ name: `test-n11-${crypto.randomUUID()}` });
        if (!dbRes.ok) return { setup: false };
        const db = dbRes.value;

        const activeKey = await generateTestKey();
        const extraKey = await generateTestKey();
        const unlock = await unlockOwner(db, ownerId, activeKeyId, activeKey);
        if (!unlock.ok) {
          closeDatabase(db);
          return { setup: false };
        }

        const storedExtra = await storeCryptoKey(db, ownerId, highKeyId, extraKey);
        const extraBefore = await getCryptoKey(db, ownerId, highKeyId);
        const locked = await lockOwner(db, ownerId);
        const activeAfter = await getCryptoKey(db, ownerId, activeKeyId);
        const extraAfter = await getCryptoKey(db, ownerId, highKeyId);

        const remainingOwnerKeys = await new Promise<number>((resolve, reject) => {
          const tx = db.transaction(STORAGE_STORES.crypto_keys, "readonly");
          const store = tx.objectStore(STORAGE_STORES.crypto_keys);
          const req = store.openCursor(IDBKeyRange.lowerBound([ownerId]));
          let count = 0;
          req.onsuccess = () => {
            const cursor = req.result;
            if (!cursor) {
              resolve(count);
              return;
            }
            const key = cursor.key;
            if (!Array.isArray(key) || key[0] !== ownerId) {
              resolve(count);
              return;
            }
            count += 1;
            cursor.continue();
          };
          req.onerror = () => reject(req.error);
        });

        closeDatabase(db);
        return {
          setup: true,
          storedExtraOk: storedExtra.ok,
          extraBeforeOk: extraBefore.ok,
          lockOk: locked.ok,
          activeAfterOk: activeAfter.ok,
          activeAfterCode: activeAfter.ok ? null : activeAfter.error.code,
          extraAfterOk: extraAfter.ok,
          extraAfterCode: extraAfter.ok ? null : extraAfter.error.code,
          remainingOwnerKeys,
        };
      });

      expect(result.setup).toBe(true);
      if (!result.setup) return;
      expect(result.storedExtraOk).toBe(true);
      expect(result.extraBeforeOk).toBe(true);
      expect(result.lockOk).toBe(true);
      expect(result.activeAfterOk).toBe(false);
      expect(result.activeAfterCode).toBe("unavailable");
      expect(result.extraAfterOk).toBe(false);
      expect(result.extraAfterCode).toBe("unavailable");
      expect(result.remainingOwnerKeys).toBe(0);
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

    test("F05: unlockOwner authenticated sentinel enforces key continuity across lock/unlock cycles", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });

      const testDbName = `test-sentinel-${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-sentinel-1";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId }) => {
          const {
            openDatabase,
            closeDatabase,
            importRawKey,
            unlockOwner,
            lockOwner,
            STORAGE_STORES,
          } = window.__dayforge_security_storage;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false, error: openRes.error.code };
          const db = openRes.value;

          // 1. Initial unlock with key1 generates and writes sentinel to sync_meta
          const key1Raw = new Uint8Array(32);
          for (let i = 0; i < 32; i++) key1Raw[i] = i + 1;
          const key1 = await importRawKey(key1Raw);

          const unlock1Res = await unlockOwner(db, ownerId, keyId, key1);
          if (!unlock1Res.ok) {
            closeDatabase(db);
            return { step: "unlock1", ok: false, error: unlock1Res.error.code };
          }

          // Insert a sample record overlay to represent existing owner data
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORAGE_STORES.records, "readwrite");
            tx.objectStore(STORAGE_STORES.records).put({
              owner_id: ownerId,
              kind: "plan",
              id: "22222222-2222-4222-8222-222222222222",
              key_id: keyId,
              iv: "000000000000000000000000",
              ciphertext: "00000000",
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });

          // Verify sentinel exists in sync_meta store
          const sentinelRecord = await new Promise<any>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.sync_meta, "readonly");
            const req = tx.objectStore(STORAGE_STORES.sync_meta).get([ownerId, "owner-key-sentinel"]);
            req.onsuccess = () => resolve(req.result);
          });

          // 2. Lock owner
          await lockOwner(db, ownerId);

          // 3. Unlock attempt with a DIFFERENT key2 (same keyId) -> MUST fail with integrity_failed
          const key2Raw = new Uint8Array(32);
          for (let i = 0; i < 32; i++) key2Raw[i] = 255 - i;
          const key2 = await importRawKey(key2Raw);

          const wrongKeyUnlockRes = await unlockOwner(db, ownerId, keyId, key2);

          // 4. Unlock attempt with SAME key1 re-imported from raw bytes -> MUST succeed
          const key1Reimported = await importRawKey(key1Raw);
          const sameKeyUnlockRes = await unlockOwner(db, ownerId, keyId, key1Reimported);

          // 5. Lock and delete the sentinel while existing records remain -> MUST fail closed with integrity_failed
          await lockOwner(db, ownerId);
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORAGE_STORES.sync_meta, "readwrite");
            tx.objectStore(STORAGE_STORES.sync_meta).delete([ownerId, "owner-key-sentinel"]);
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });

          const missingSentinelUnlockRes = await unlockOwner(db, ownerId, keyId, key1Reimported);

          closeDatabase(db);

          return {
            ok: true,
            hasSentinel: !!sentinelRecord,
            wrongKeyOk: wrongKeyUnlockRes.ok,
            wrongKeyCode: !wrongKeyUnlockRes.ok ? wrongKeyUnlockRes.error.code : null,
            sameKeyOk: sameKeyUnlockRes.ok,
            missingSentinelOk: missingSentinelUnlockRes.ok,
            missingSentinelCode: !missingSentinelUnlockRes.ok ? missingSentinelUnlockRes.error.code : null,
          };
        },
        { testDbName, ownerId, keyId }
      );

      expect(result.ok).toBe(true);
      expect(result.hasSentinel).toBe(true);
      expect(result.wrongKeyOk).toBe(false);
      expect(result.wrongKeyCode).toBe("integrity_failed");
      expect(result.sameKeyOk).toBe(true);
      expect(result.missingSentinelOk).toBe(false);
      expect(result.missingSentinelCode).toBe("integrity_failed");
    });

    test("ST-S01: Concurrent unlockOwner on fresh owner with different keys enforces single-winner CAS (loser fails integrity_failed)", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });

      const testDbName = `test-sentinel-s01-${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const keyId = "key-sentinel-s01";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId }) => {
          const {
            openDatabase,
            closeDatabase,
            importRawKey,
            unlockOwner,
            STORAGE_STORES,
          } = window.__dayforge_security_storage;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false };
          const db = openRes.value;

          const key1Raw = new Uint8Array(32).fill(0x11);
          const key2Raw = new Uint8Array(32).fill(0x22);
          const key1 = await importRawKey(key1Raw);
          const key2 = await importRawKey(key2Raw);

          // Coordinate Phase 1 barrier so both tabs snapshot null state before either commits
          let barrierResolver: (() => void) | null = null;
          const barrierPromise = new Promise<void>((r) => {
            barrierResolver = r;
          });

          let p1ReadyCount = 0;
          const onPhase1 = async () => {
            p1ReadyCount++;
            if (p1ReadyCount >= 2 && barrierResolver) {
              barrierResolver();
            }
            await barrierPromise;
          };

          const [res1, res2] = await Promise.all([
            unlockOwner(db, ownerId, keyId, key1, { afterPhase1Barrier: onPhase1 }),
            unlockOwner(db, ownerId, keyId, key2, { afterPhase1Barrier: onPhase1 }),
          ]);

          const metaRecord = await new Promise<any>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.owner_meta, "readonly");
            const req = tx.objectStore(STORAGE_STORES.owner_meta).get(ownerId);
            req.onsuccess = () => resolve(req.result);
          });

          const sentinelRecord = await new Promise<any>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.sync_meta, "readonly");
            const req = tx.objectStore(STORAGE_STORES.sync_meta).get([ownerId, "owner-key-sentinel"]);
            req.onsuccess = () => resolve(req.result);
          });

          closeDatabase(db);

          return {
            ok: true,
            res1Ok: res1.ok,
            res1ErrCode: !res1.ok ? res1.error.code : null,
            res2Ok: res2.ok,
            res2ErrCode: !res2.ok ? res2.error.code : null,
            metaLocked: metaRecord ? metaRecord.locked : null,
            hasSentinel: Boolean(sentinelRecord),
          };
        },
        { testDbName, ownerId, keyId }
      );

      expect(result.ok).toBe(true);
      const oneSucceeded = (result.res1Ok && !result.res2Ok) || (!result.res1Ok && result.res2Ok);
      expect(oneSucceeded).toBe(true);
      const failedCode = result.res1Ok ? result.res2ErrCode : result.res1ErrCode;
      expect(failedCode).toBe("integrity_failed");
      expect(result.metaLocked).toBe(false);
      expect(result.hasSentinel).toBe(true);
    });

    test("ST-S02: Concurrent unlockOwner on fresh owner with same key material succeeds for both via retry", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });

      const testDbName = `test-sentinel-s02-${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-222222222222";
      const keyId = "key-sentinel-s02";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId }) => {
          const {
            openDatabase,
            closeDatabase,
            importRawKey,
            unlockOwner,
          } = window.__dayforge_security_storage;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false };
          const db = openRes.value;

          const keyRaw = new Uint8Array(32).fill(0x33);
          const key1 = await importRawKey(keyRaw);
          const key2 = await importRawKey(keyRaw);

          let barrierResolver: (() => void) | null = null;
          const barrierPromise = new Promise<void>((r) => {
            barrierResolver = r;
          });

          let p1ReadyCount = 0;
          const onPhase1 = async () => {
            p1ReadyCount++;
            if (p1ReadyCount >= 2 && barrierResolver) {
              barrierResolver();
            }
            await barrierPromise;
          };

          const [res1, res2] = await Promise.all([
            unlockOwner(db, ownerId, keyId, key1, { afterPhase1Barrier: onPhase1 }),
            unlockOwner(db, ownerId, keyId, key2, { afterPhase1Barrier: onPhase1 }),
          ]);

          closeDatabase(db);

          return {
            ok: true,
            res1Ok: res1.ok,
            res2Ok: res2.ok,
          };
        },
        { testDbName, ownerId, keyId }
      );

      expect(result.ok).toBe(true);
      expect(result.res1Ok).toBe(true);
      expect(result.res2Ok).toBe(true);
    });

    test("ST-S04: lockOwner called concurrently during unlockOwner fails closed with locked and leaves owner locked", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });

      const testDbName = `test-sentinel-s04-${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-444444444444";
      const keyId = "key-sentinel-s04";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId }) => {
          const {
            openDatabase,
            closeDatabase,
            importRawKey,
            unlockOwner,
            lockOwner,
            STORAGE_STORES,
          } = window.__dayforge_security_storage;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false };
          const db = openRes.value;

          const keyRaw = new Uint8Array(32).fill(0x44);
          const key = await importRawKey(keyRaw);

          let lockExecuted = false;
          const unlockRes = await unlockOwner(db, ownerId, keyId, key, {
            afterPhase1Barrier: async () => {
              await lockOwner(db, ownerId);
              lockExecuted = true;
            },
          });

          const metaRecord = await new Promise<any>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.owner_meta, "readonly");
            const req = tx.objectStore(STORAGE_STORES.owner_meta).get(ownerId);
            req.onsuccess = () => resolve(req.result);
          });

          closeDatabase(db);

          return {
            ok: true,
            lockExecuted,
            unlockOk: unlockRes.ok,
            unlockErrCode: !unlockRes.ok ? unlockRes.error.code : null,
            metaLocked: metaRecord ? metaRecord.locked : null,
          };
        },
        { testDbName, ownerId, keyId }
      );

      expect(result.ok).toBe(true);
      expect(result.lockExecuted).toBe(true);
      expect(result.unlockOk).toBe(false);
      expect(result.unlockErrCode).toBe("locked");
      expect(result.metaLocked).toBe(true);
    });

    test("ST-S05 & ST-S06: Legacy data in records store: right key migrates with sentinel, wrong key fails integrity_failed", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });

      const testDbName = `test-sentinel-s05-${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-555555555555";
      const keyId = "key-sentinel-s05";
      const planId = "22222222-2222-4222-8222-555555555555";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, planId }) => {
          const {
            openDatabase,
            closeDatabase,
            importRawKey,
            encryptPayload,
            unlockOwner,
            getRecord,
            STORAGE_STORES,
          } = window.__dayforge_security_storage;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false };
          const db = openRes.value;

          const rightKeyRaw = new Uint8Array(32).fill(0x55);
          const wrongKeyRaw = new Uint8Array(32).fill(0x56);
          const rightKey = await importRawKey(rightKeyRaw);
          const wrongKey = await importRawKey(wrongKeyRaw);

          const encRes = await encryptPayload(
            rightKey,
            ownerId,
            keyId,
            STORAGE_STORES.records,
            `plan:${planId}`,
            { title: "Legacy Plan Title", schema_version: 1 }
          );
          if (!encRes.ok) return { step: "encrypt", ok: false };

          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORAGE_STORES.records, "readwrite");
            tx.objectStore(STORAGE_STORES.records).put({
              owner_id: ownerId,
              kind: "plan",
              id: planId,
              key_id: keyId,
              iv: encRes.value.iv,
              ciphertext: encRes.value.ciphertext,
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });

          const wrongUnlock = await unlockOwner(db, ownerId, keyId, wrongKey);

          const sentinelAfterWrong = await new Promise<any>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.sync_meta, "readonly");
            const req = tx.objectStore(STORAGE_STORES.sync_meta).get([ownerId, "owner-key-sentinel"]);
            req.onsuccess = () => resolve(req.result);
          });

          const rightUnlock = await unlockOwner(db, ownerId, keyId, rightKey);

          let retrievedRecord: any = null;
          if (rightUnlock.ok) {
            const getRes = await getRecord(db, rightUnlock.value, "plan", planId);
            if (getRes.ok) retrievedRecord = getRes.value;
          }

          const sentinelAfterRight = await new Promise<any>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.sync_meta, "readonly");
            const req = tx.objectStore(STORAGE_STORES.sync_meta).get([ownerId, "owner-key-sentinel"]);
            req.onsuccess = () => resolve(req.result);
          });

          closeDatabase(db);

          return {
            ok: true,
            wrongOk: wrongUnlock.ok,
            wrongErrCode: !wrongUnlock.ok ? wrongUnlock.error.code : null,
            sentinelAfterWrong: Boolean(sentinelAfterWrong),
            rightOk: rightUnlock.ok,
            sentinelAfterRight: Boolean(sentinelAfterRight),
            retrievedTitle: retrievedRecord?.title,
          };
        },
        { testDbName, ownerId, keyId, planId }
      );

      expect(result.ok).toBe(true);
      expect(result.wrongOk).toBe(false);
      expect(result.wrongErrCode).toBe("integrity_failed");
      expect(result.sentinelAfterWrong).toBe(false);
      expect(result.rightOk).toBe(true);
      expect(result.sentinelAfterRight).toBe(true);
      expect(result.retrievedTitle).toBe("Legacy Plan Title");
    });

    test("ST-S07: Legacy data in operations store only: right key migrates, wrong key fails integrity_failed", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });

      const testDbName = `test-sentinel-s07-${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-777777777777";
      const keyId = "key-sentinel-s07";
      const opId = "33333333-3333-4333-8333-777777777777";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, opId }) => {
          const {
            openDatabase,
            closeDatabase,
            importRawKey,
            encryptPayload,
            unlockOwner,
            STORAGE_STORES,
          } = window.__dayforge_security_storage;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false };
          const db = openRes.value;

          const rightKey = await importRawKey(new Uint8Array(32).fill(0x77));
          const wrongKey = await importRawKey(new Uint8Array(32).fill(0x78));

          const envEnc = await encryptPayload(
            rightKey,
            ownerId,
            keyId,
            STORAGE_STORES.operations,
            opId,
            { client_time: "2026-11-01T00:00:00.000Z", commands: [] }
          );
          if (!envEnc.ok) return { step: "encrypt", ok: false };

          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORAGE_STORES.operations, "readwrite");
            tx.objectStore(STORAGE_STORES.operations).put({
              owner_id: ownerId,
              operation_id: opId,
              status: "queued",
              request_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              encrypted_envelope: envEnc.value,
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });

          const wrongUnlock = await unlockOwner(db, ownerId, keyId, wrongKey);
          const rightUnlock = await unlockOwner(db, ownerId, keyId, rightKey);

          const sentinelRecord = await new Promise<any>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.sync_meta, "readonly");
            const req = tx.objectStore(STORAGE_STORES.sync_meta).get([ownerId, "owner-key-sentinel"]);
            req.onsuccess = () => resolve(req.result);
          });

          closeDatabase(db);

          return {
            ok: true,
            wrongOk: wrongUnlock.ok,
            wrongErrCode: !wrongUnlock.ok ? wrongUnlock.error.code : null,
            rightOk: rightUnlock.ok,
            hasSentinel: Boolean(sentinelRecord),
          };
        },
        { testDbName, ownerId, keyId, opId }
      );

      expect(result.ok).toBe(true);
      expect(result.wrongOk).toBe(false);
      expect(result.wrongErrCode).toBe("integrity_failed");
      expect(result.rightOk).toBe(true);
      expect(result.hasSentinel).toBe(true);
    });

    test("M07: malformed owner-scoped operation keys block legacy unlock before sentinel installation", async ({ page }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });

      const testDbName = `test-sentinel-m07-${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-777777777778";
      const keyId = "key-sentinel-m07";
      const validOpId = "33333333-3333-4333-8333-777777777778";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, validOpId }) => {
          const {
            openDatabase,
            closeDatabase,
            importRawKey,
            encryptPayload,
            unlockOwner,
            STORAGE_STORES,
          } = window.__dayforge_security_storage;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { setup: false };
          const db = openRes.value;
          const rightKey = await importRawKey(new Uint8Array(32).fill(0x79));
          const wrongKey = await importRawKey(new Uint8Array(32).fill(0x7a));
          const encrypted = await encryptPayload(
            rightKey,
            ownerId,
            keyId,
            STORAGE_STORES.operations,
            validOpId,
            { client_time: "2026-11-01T00:00:00.000Z", commands: [] }
          );
          if (!encrypted.ok) return { setup: false };

          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORAGE_STORES.operations, "readwrite");
            tx.objectStore(STORAGE_STORES.operations).put({
              owner_id: ownerId,
              operation_id: 123,
              status: "queued",
              request_hash: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              encrypted_envelope: encrypted.value,
            });
            tx.oncomplete = () => resolve();
            tx.onabort = () => reject(tx.error);
          });

          const unlock = await unlockOwner(db, ownerId, keyId, wrongKey);
          const state = await new Promise<{ sentinel: unknown; row: unknown }>((resolve, reject) => {
            const tx = db.transaction([STORAGE_STORES.sync_meta, STORAGE_STORES.operations], "readonly");
            const sentinel = tx.objectStore(STORAGE_STORES.sync_meta).get([ownerId, "owner-key-sentinel"]);
            const row = tx.objectStore(STORAGE_STORES.operations).get([ownerId, 123]);
            tx.oncomplete = () => resolve({ sentinel: sentinel.result, row: row.result });
            tx.onerror = () => reject(tx.error);
          });
          closeDatabase(db);
          return {
            setup: true,
            unlockOk: unlock.ok,
            errorCode: unlock.ok ? null : unlock.error.code,
            sentinelInstalled: Boolean(state.sentinel),
            rowRetained: Boolean(state.row),
          };
        },
        { testDbName, ownerId, keyId, validOpId }
      );

      expect(result.setup).toBe(true);
      expect(result.unlockOk).toBe(false);
      expect(result.errorCode).toBe("integrity_failed");
      expect(result.sentinelInstalled).toBe(false);
      expect(result.rowRetained).toBe(true);
    });

    test("ST-S08: Legacy data in view_preferences store only: right key migrates, wrong key fails integrity_failed", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });

      const testDbName = `test-sentinel-s08-${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-888888888888";
      const keyId = "key-sentinel-s08";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId }) => {
          const {
            openDatabase,
            closeDatabase,
            importRawKey,
            encryptPayload,
            unlockOwner,
            STORAGE_STORES,
          } = window.__dayforge_security_storage;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false };
          const db = openRes.value;

          const rightKey = await importRawKey(new Uint8Array(32).fill(0x88));
          const wrongKey = await importRawKey(new Uint8Array(32).fill(0x89));

          const encPref = await encryptPayload(
            rightKey,
            ownerId,
            keyId,
            STORAGE_STORES.view_preferences,
            "work",
            { date: "2026-11-01", scale: "week", scrollY: 150, updatedAt: "2026-11-01T00:00:00.000Z" }
          );
          if (!encPref.ok) return { step: "encrypt", ok: false };

          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORAGE_STORES.view_preferences, "readwrite");
            tx.objectStore(STORAGE_STORES.view_preferences).put({
              owner_id: ownerId,
              calendar: "work",
              key_id: keyId,
              iv: encPref.value.iv,
              ciphertext: encPref.value.ciphertext,
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });

          const wrongUnlock = await unlockOwner(db, ownerId, keyId, wrongKey);
          const rightUnlock = await unlockOwner(db, ownerId, keyId, rightKey);

          const sentinelRecord = await new Promise<any>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.sync_meta, "readonly");
            const req = tx.objectStore(STORAGE_STORES.sync_meta).get([ownerId, "owner-key-sentinel"]);
            req.onsuccess = () => resolve(req.result);
          });

          closeDatabase(db);

          return {
            ok: true,
            wrongOk: wrongUnlock.ok,
            wrongErrCode: !wrongUnlock.ok ? wrongUnlock.error.code : null,
            rightOk: rightUnlock.ok,
            hasSentinel: Boolean(sentinelRecord),
          };
        },
        { testDbName, ownerId, keyId }
      );

      expect(result.ok).toBe(true);
      expect(result.wrongOk).toBe(false);
      expect(result.wrongErrCode).toBe("integrity_failed");
      expect(result.rightOk).toBe(true);
      expect(result.hasSentinel).toBe(true);
    });

    test("ST-S09: Legacy data with missing owner_meta: does not treat as fresh owner, requires authentic key", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });

      const testDbName = `test-sentinel-s09-${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-999999999999";
      const keyId = "key-sentinel-s09";
      const planId = "22222222-2222-4222-8222-999999999999";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, planId }) => {
          const {
            openDatabase,
            closeDatabase,
            importRawKey,
            encryptPayload,
            unlockOwner,
            STORAGE_STORES,
          } = window.__dayforge_security_storage;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false };
          const db = openRes.value;

          const rightKey = await importRawKey(new Uint8Array(32).fill(0x99));
          const wrongKey = await importRawKey(new Uint8Array(32).fill(0x9a));

          const encRes = await encryptPayload(
            rightKey,
            ownerId,
            keyId,
            STORAGE_STORES.records,
            `plan:${planId}`,
            { title: "No Meta Record" }
          );
          if (!encRes.ok) return { step: "encrypt", ok: false };

          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORAGE_STORES.records, "readwrite");
            tx.objectStore(STORAGE_STORES.records).put({
              owner_id: ownerId,
              kind: "plan",
              id: planId,
              key_id: keyId,
              iv: encRes.value.iv,
              ciphertext: encRes.value.ciphertext,
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });

          const wrongUnlock = await unlockOwner(db, ownerId, keyId, wrongKey);
          const rightUnlock = await unlockOwner(db, ownerId, keyId, rightKey);

          closeDatabase(db);

          return {
            ok: true,
            wrongOk: wrongUnlock.ok,
            wrongErrCode: !wrongUnlock.ok ? wrongUnlock.error.code : null,
            rightOk: rightUnlock.ok,
          };
        },
        { testDbName, ownerId, keyId, planId }
      );

      expect(result.ok).toBe(true);
      expect(result.wrongOk).toBe(false);
      expect(result.wrongErrCode).toBe("integrity_failed");
      expect(result.rightOk).toBe(true);
    });

    test("ST-S12: Sentinel payload format_version !== 1 fails closed with integrity_failed without overwriting", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });

      const testDbName = `test-sentinel-s12-${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-121212121212";
      const keyId = "key-sentinel-s12";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId }) => {
          const {
            openDatabase,
            closeDatabase,
            importRawKey,
            encryptPayload,
            unlockOwner,
            STORAGE_STORES,
          } = window.__dayforge_security_storage;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false };
          const db = openRes.value;

          const key = await importRawKey(new Uint8Array(32).fill(0x12));

          const encRes = await encryptPayload(
            key,
            ownerId,
            keyId,
            STORAGE_STORES.sync_meta,
            "owner-key-sentinel",
            {
              kind: "dayforge-owner-key-check",
              format_version: 2,
              owner_id: ownerId,
              key_id: keyId,
            }
          );
          if (!encRes.ok) return { step: "encrypt", ok: false };

          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORAGE_STORES.sync_meta, "readwrite");
            tx.objectStore(STORAGE_STORES.sync_meta).put({
              owner_id: ownerId,
              key: "owner-key-sentinel",
              key_id: keyId,
              iv: encRes.value.iv,
              ciphertext: encRes.value.ciphertext,
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });

          const unlockRes = await unlockOwner(db, ownerId, keyId, key);

          closeDatabase(db);

          return {
            ok: true,
            unlockOk: unlockRes.ok,
            unlockErrCode: !unlockRes.ok ? unlockRes.error.code : null,
          };
        },
        { testDbName, ownerId, keyId }
      );

      expect(result.ok).toBe(true);
      expect(result.unlockOk).toBe(false);
      expect(result.unlockErrCode).toBe("integrity_failed");
    });

    test("M01: legacy backfill rejects a mixed-key dataset and preserves every ciphertext", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });

      const testDbName = `test-sentinel-m01a-${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-210121012101";
      const keyId = "key-sentinel-m01a";
      const planAId = "22222222-2222-4222-8222-210121012101";
      const planBId = "22222222-2222-4222-8222-210121012102";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, planAId, planBId }) => {
          const {
            openDatabase,
            closeDatabase,
            importRawKey,
            encryptPayload,
            unlockOwner,
            STORAGE_STORES,
          } = window.__dayforge_security_storage;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false };
          const db = openRes.value;

          const keyA = await importRawKey(new Uint8Array(32).fill(0xa1));
          const keyB = await importRawKey(new Uint8Array(32).fill(0xb2));

          const encA = await encryptPayload(
            keyA,
            ownerId,
            keyId,
            STORAGE_STORES.records,
            `plan:${planAId}`,
            { title: "Plan A" }
          );
          const encB = await encryptPayload(
            keyB,
            ownerId,
            keyId,
            STORAGE_STORES.records,
            `plan:${planBId}`,
            { title: "Plan B" }
          );
          if (!encA.ok || !encB.ok) return { step: "encrypt", ok: false };

          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORAGE_STORES.records, "readwrite");
            const store = tx.objectStore(STORAGE_STORES.records);
            store.put({
              owner_id: ownerId,
              kind: "plan",
              id: planAId,
              key_id: keyId,
              iv: encA.value.iv,
              ciphertext: encA.value.ciphertext,
            });
            store.put({
              owner_id: ownerId,
              kind: "plan",
              id: planBId,
              key_id: keyId,
              iv: encB.value.iv,
              ciphertext: encB.value.ciphertext,
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });

          const unlockA = await unlockOwner(db, ownerId, keyId, keyA);
          const unlockB = await unlockOwner(db, ownerId, keyId, keyB);

          const sentinel = await new Promise<any>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.sync_meta, "readonly");
            const req = tx
              .objectStore(STORAGE_STORES.sync_meta)
              .get([ownerId, "owner-key-sentinel"]);
            req.onsuccess = () => resolve(req.result);
          });

          const rows = await new Promise<any[]>((resolve, reject) => {
            const tx = db.transaction(STORAGE_STORES.records, "readonly");
            const req = tx
              .objectStore(STORAGE_STORES.records)
              .getAll(IDBKeyRange.bound([ownerId, ""], [ownerId, "\uffff"]));
            req.onsuccess = () => resolve(req.result as any[]);
            tx.onerror = () => reject(tx.error);
          });

          closeDatabase(db);

          return {
            ok: true,
            unlockAOk: unlockA.ok,
            unlockACode: !unlockA.ok ? unlockA.error.code : null,
            unlockBOk: unlockB.ok,
            unlockBCode: !unlockB.ok ? unlockB.error.code : null,
            hasSentinel: Boolean(sentinel),
            rowCount: rows.length,
          };
        },
        { testDbName, ownerId, keyId, planAId, planBId }
      );

      expect(result.ok).toBe(true);
      expect(result.unlockAOk).toBe(false);
      expect(result.unlockACode).toBe("integrity_failed");
      expect(result.unlockBOk).toBe(false);
      expect(result.unlockBCode).toBe("integrity_failed");
      expect(result.hasSentinel).toBe(false);
      expect(result.rowCount).toBe(2);
    });

    test("M01: legacy backfill validates records, operations, view preferences, drafts and sync metadata", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });

      const testDbName = `test-sentinel-m01b-${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-210121012201";
      const keyId = "key-sentinel-m01b";
      const planId = "22222222-2222-4222-8222-210121012201";
      const opId = "33333333-3333-4333-8333-210121012201";
      const draftId = "draft-m01b";
      const syncKey = "cursor:m01b";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, planId, opId, draftId, syncKey }) => {
          const {
            openDatabase,
            closeDatabase,
            importRawKey,
            encryptPayload,
            unlockOwner,
            STORAGE_STORES,
          } = window.__dayforge_security_storage;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false };
          const db = openRes.value;

          const key = await importRawKey(new Uint8Array(32).fill(0xc3));
          const encrypt = async (store: string, recordId: string, payload: unknown) => {
            const res = await encryptPayload(
              key,
              ownerId,
              keyId,
              store,
              recordId,
              payload
            );
            if (!res.ok) throw new Error(`encrypt ${store}/${recordId} failed`);
            return res.value;
          };

          const record = await encrypt(
            STORAGE_STORES.records,
            `plan:${planId}`,
            { title: "Legacy Plan" }
          );
          const operation = await encrypt(
            STORAGE_STORES.operations,
            opId,
            { client_time: "2026-11-01T00:00:00.000Z", commands: [] }
          );
          const preference = await encrypt(
            STORAGE_STORES.view_preferences,
            "work",
            { date: "2026-11-01", scale: "week", updatedAt: "2026-11-01T00:00:00.000Z" }
          );
          const draft = await encrypt(
            STORAGE_STORES.drafts,
            draftId,
            { text: "legacy draft" }
          );
          const syncMeta = await encrypt(
            STORAGE_STORES.sync_meta,
            syncKey,
            { cursor: "legacy" }
          );

          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(
              [
                STORAGE_STORES.records,
                STORAGE_STORES.operations,
                STORAGE_STORES.view_preferences,
                STORAGE_STORES.drafts,
                STORAGE_STORES.sync_meta,
              ],
              "readwrite"
            );
            tx.objectStore(STORAGE_STORES.records).put({
              owner_id: ownerId,
              kind: "plan",
              id: planId,
              key_id: keyId,
              iv: record.iv,
              ciphertext: record.ciphertext,
            });
            tx.objectStore(STORAGE_STORES.operations).put({
              owner_id: ownerId,
              operation_id: opId,
              status: "queued",
              request_hash:
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
              encrypted_envelope: operation,
              created_at: "2026-11-01T00:00:00.000Z",
            });
            tx.objectStore(STORAGE_STORES.view_preferences).put({
              owner_id: ownerId,
              calendar: "work",
              key_id: keyId,
              iv: preference.iv,
              ciphertext: preference.ciphertext,
            });
            tx.objectStore(STORAGE_STORES.drafts).put({
              owner_id: ownerId,
              draft_id: draftId,
              key_id: keyId,
              iv: draft.iv,
              ciphertext: draft.ciphertext,
            });
            tx.objectStore(STORAGE_STORES.sync_meta).put({
              owner_id: ownerId,
              key: syncKey,
              key_id: keyId,
              iv: syncMeta.iv,
              ciphertext: syncMeta.ciphertext,
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });

          const corruptSyncMeta = async () => {
            await new Promise<void>((resolve, reject) => {
              const tx = db.transaction(STORAGE_STORES.sync_meta, "readwrite");
              const store = tx.objectStore(STORAGE_STORES.sync_meta);
              const getReq = store.get([ownerId, syncKey]);
              getReq.onsuccess = () => {
                const row = getReq.result;
                const corrupted = new Uint8Array(row.ciphertext);
                corrupted[0] ^= 0xff;
                store.put({ ...row, ciphertext: corrupted });
              };
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            });
          };

          const restoreSyncMeta = async () => {
            await new Promise<void>((resolve, reject) => {
              const tx = db.transaction(STORAGE_STORES.sync_meta, "readwrite");
              tx.objectStore(STORAGE_STORES.sync_meta).put({
                owner_id: ownerId,
                key: syncKey,
                key_id: keyId,
                iv: syncMeta.iv,
                ciphertext: syncMeta.ciphertext,
              });
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            });
          };

          const readSentinel = async () =>
            new Promise<any>((resolve) => {
              const tx = db.transaction(STORAGE_STORES.sync_meta, "readonly");
              const req = tx
                .objectStore(STORAGE_STORES.sync_meta)
                .get([ownerId, "owner-key-sentinel"]);
              req.onsuccess = () => resolve(req.result);
            });

          const countRows = async () =>
            new Promise<Record<string, number>>((resolve, reject) => {
              const names = [
                STORAGE_STORES.records,
                STORAGE_STORES.operations,
                STORAGE_STORES.view_preferences,
                STORAGE_STORES.drafts,
                STORAGE_STORES.sync_meta,
              ];
              const counts: Record<string, number> = {};
              const tx = db.transaction(names, "readonly");
              for (const name of names) {
                const req = tx.objectStore(name).getAll();
                req.onsuccess = () => {
                  counts[name] = (req.result as unknown[]).length;
                };
              }
              tx.oncomplete = () => resolve(counts);
              tx.onerror = () => reject(tx.error);
            });

          await corruptSyncMeta();
          const failedUnlock = await unlockOwner(db, ownerId, keyId, key);
          const sentinelAfterFailure = await readSentinel();
          const countsAfterFailure = await countRows();

          await restoreSyncMeta();
          const restoredUnlock = await unlockOwner(db, ownerId, keyId, key);
          const sentinelAfterSuccess = await readSentinel();

          closeDatabase(db);

          return {
            ok: true,
            failedUnlockOk: failedUnlock.ok,
            failedUnlockCode: !failedUnlock.ok ? failedUnlock.error.code : null,
            hasSentinelAfterFailure: Boolean(sentinelAfterFailure),
            countsAfterFailure,
            restoredUnlockOk: restoredUnlock.ok,
            hasSentinelAfterSuccess: Boolean(sentinelAfterSuccess),
          };
        },
        { testDbName, ownerId, keyId, planId, opId, draftId, syncKey }
      );

      expect(result.ok).toBe(true);
      expect(result.failedUnlockOk).toBe(false);
      expect(result.failedUnlockCode).toBe("integrity_failed");
      expect(result.hasSentinelAfterFailure).toBe(false);
      expect(result.countsAfterFailure).toEqual({
        records: 1,
        operations: 1,
        view_preferences: 1,
        drafts: 1,
        sync_meta: 1,
      });
      expect(result.restoredUnlockOk).toBe(true);
      expect(result.hasSentinelAfterSuccess).toBe(true);
    });

    test("M02: legacy backfill advances lock_epoch and invalidates pre-migration contexts", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });

      const testDbName = `test-sentinel-m02-${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-210221022102";
      const keyId = "key-sentinel-m02";
      const planId = "22222222-2222-4222-8222-210221022102";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId, planId }) => {
          const {
            openDatabase,
            closeDatabase,
            importRawKey,
            encryptPayload,
            unlockOwner,
            getOwnerMeta,
            readOwnerViewPreference,
            writeOwnerViewPreference,
            STORAGE_STORES,
          } = window.__dayforge_security_storage;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false };
          const db = openRes.value;

          const key = await importRawKey(new Uint8Array(32).fill(0xd4));
          const encRecord = await encryptPayload(
            key,
            ownerId,
            keyId,
            STORAGE_STORES.records,
            `plan:${planId}`,
            { title: "Legacy unlocked plan" }
          );
          if (!encRecord.ok) return { step: "encrypt", ok: false };

          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(
              [STORAGE_STORES.owner_meta, STORAGE_STORES.records],
              "readwrite"
            );
            tx.objectStore(STORAGE_STORES.owner_meta).put({
              owner_id: ownerId,
              lock_epoch: 7,
              locked: false,
              active_key_id: keyId,
            });
            tx.objectStore(STORAGE_STORES.records).put({
              owner_id: ownerId,
              kind: "plan",
              id: planId,
              key_id: keyId,
              iv: encRecord.value.iv,
              ciphertext: encRecord.value.ciphertext,
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });

          const oldCtx = { ownerId, keyId, lockEpoch: 7, key };
          const pref = {
            date: "2026-11-01",
            scale: "week",
            updatedAt: "2026-11-01T00:00:00.000Z",
          };

          // The pre-migration context is usable before backfill.
          const oldWriteBefore = await writeOwnerViewPreference(
            db,
            oldCtx,
            "work",
            pref
          );

          const backfill = await unlockOwner(db, ownerId, keyId, key);
          const metaAfter = await getOwnerMeta(db, ownerId);

          // Once the sentinel is installed, the old epoch must be rejected.
          const oldWriteAfter = await writeOwnerViewPreference(
            db,
            oldCtx,
            "work",
            { ...pref, scrollY: 10 }
          );
          const oldReadAfter = await readOwnerViewPreference(db, oldCtx, "work");

          let newWriteOk = false;
          if (backfill.ok) {
            const newWrite = await writeOwnerViewPreference(
              db,
              backfill.value,
              "work",
              { ...pref, scrollY: 20 }
            );
            newWriteOk = newWrite.ok;
          }

          const sentinel = await new Promise<any>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.sync_meta, "readonly");
            const req = tx
              .objectStore(STORAGE_STORES.sync_meta)
              .get([ownerId, "owner-key-sentinel"]);
            req.onsuccess = () => resolve(req.result);
          });

          closeDatabase(db);

          return {
            ok: true,
            oldWriteBeforeOk: oldWriteBefore.ok,
            backfillOk: backfill.ok,
            backfillCode: !backfill.ok ? backfill.error.code : null,
            backfillEpoch: backfill.ok ? backfill.value.lockEpoch : null,
            metaEpoch: metaAfter.ok ? metaAfter.value?.lock_epoch : null,
            oldWriteAfterOk: oldWriteAfter.ok,
            oldWriteAfterCode: !oldWriteAfter.ok ? oldWriteAfter.error.code : null,
            oldReadAfterOk: oldReadAfter.ok,
            oldReadAfterCode: !oldReadAfter.ok ? oldReadAfter.error.code : null,
            newWriteOk,
            hasSentinel: Boolean(sentinel),
          };
        },
        { testDbName, ownerId, keyId, planId }
      );

      expect(result.ok).toBe(true);
      expect(result.oldWriteBeforeOk).toBe(true);
      expect(result.backfillOk).toBe(true);
      expect(result.backfillEpoch).toBe(8);
      expect(result.metaEpoch).toBe(8);
      expect(result.oldWriteAfterOk).toBe(false);
      expect(result.oldWriteAfterCode).toBe("locked");
      expect(result.oldReadAfterOk).toBe(false);
      expect(result.oldReadAfterCode).toBe("locked");
      expect(result.newWriteOk).toBe(true);
      expect(result.hasSentinel).toBe(true);
    });

    test("M05: sentinel missing key_id fails closed instead of falling back to the caller key ID", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });

      const testDbName = `test-sentinel-m05-${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-210521052105";
      const keyId = "key-sentinel-m05";

      const result = await page.evaluate(
        async ({ testDbName, ownerId, keyId }) => {
          const {
            openDatabase,
            closeDatabase,
            importRawKey,
            encryptPayload,
            unlockOwner,
            STORAGE_STORES,
          } = window.__dayforge_security_storage;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false };
          const db = openRes.value;

          const key = await importRawKey(new Uint8Array(32).fill(0xe5));
          const encRes = await encryptPayload(
            key,
            ownerId,
            keyId,
            STORAGE_STORES.sync_meta,
            "owner-key-sentinel",
            {
              kind: "dayforge-owner-key-check",
              format_version: 1,
              owner_id: ownerId,
              key_id: keyId,
            }
          );
          if (!encRes.ok) return { step: "encrypt", ok: false };

          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(STORAGE_STORES.sync_meta, "readwrite");
            tx.objectStore(STORAGE_STORES.sync_meta).put({
              owner_id: ownerId,
              key: "owner-key-sentinel",
              iv: encRes.value.iv,
              ciphertext: encRes.value.ciphertext,
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });

          const unlock = await unlockOwner(db, ownerId, keyId, key);

          const sentinel = await new Promise<any>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.sync_meta, "readonly");
            const req = tx
              .objectStore(STORAGE_STORES.sync_meta)
              .get([ownerId, "owner-key-sentinel"]);
            req.onsuccess = () => resolve(req.result);
          });

          closeDatabase(db);

          return {
            ok: true,
            unlockOk: unlock.ok,
            unlockCode: !unlock.ok ? unlock.error.code : null,
            sentinelStillPresent: Boolean(sentinel),
            sentinelHasKeyId: Boolean(
              sentinel &&
                Object.prototype.hasOwnProperty.call(sentinel, "key_id")
            ),
          };
        },
        { testDbName, ownerId, keyId }
      );

      expect(result.ok).toBe(true);
      expect(result.unlockOk).toBe(false);
      expect(result.unlockCode).toBe("integrity_failed");
      expect(result.sentinelStillPresent).toBe(true);
      expect(result.sentinelHasKeyId).toBe(false);
    });

    test("ST-S13 & M03: confirmPulledOperationInTx enforces owner gate inside the caller transaction", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });

      const testDbName = `test-sentinel-s13-${Date.now()}`;
      const ownerId = "11111111-1111-4111-8111-131313131313";
      const otherOwnerId = "11111111-1111-4111-8111-131313131314";
      const keyId = "key-sentinel-s13";
      const opId = "44444444-4444-4444-8444-131313131313";
      const opId2 = "44444444-4444-4444-8444-131313131414";
      const validHash = "abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";
      const wrongHash = "0000000000000000000000000000000000000000000000000000000000000000";

      const result = await page.evaluate(
        async ({
          testDbName,
          ownerId,
          otherOwnerId,
          keyId,
          opId,
          opId2,
          validHash,
          wrongHash,
        }) => {
          const {
            openDatabase,
            closeDatabase,
            importRawKey,
            unlockOwner,
            lockOwner,
            confirmPulledOperationInTx,
            STORAGE_STORES,
          } = window.__dayforge_security_storage;

          const openRes = await openDatabase({ name: testDbName });
          if (!openRes.ok) return { step: "open", ok: false };
          const db = openRes.value;

          const key = await importRawKey(new Uint8Array(32).fill(0x13));
          const unlockRes = await unlockOwner(db, ownerId, keyId, key);
          if (!unlockRes.ok) return { step: "unlock", ok: false };
          const ctx = unlockRes.value;

          const putRow = async (operationId: string) => {
            await new Promise<void>((resolve, reject) => {
              const tx = db.transaction(STORAGE_STORES.operations, "readwrite");
              tx.objectStore(STORAGE_STORES.operations).put({
                owner_id: ownerId,
                operation_id: operationId,
                status: "ack_waiting_pull",
                request_hash: validHash,
                encrypted_envelope: {
                  owner_id: ownerId,
                  store: "operations",
                  record_id: operationId,
                  key_id: keyId,
                  iv: new Uint8Array(12),
                  ciphertext: new Uint8Array(16),
                },
              });
              tx.oncomplete = () => resolve();
              tx.onerror = () => reject(tx.error);
            });
          };

          const readRow = async (operationId: string) =>
            new Promise<any>((resolve) => {
              const tx = db.transaction(STORAGE_STORES.operations, "readonly");
              const req = tx
                .objectStore(STORAGE_STORES.operations)
                .get([ownerId, operationId]);
              req.onsuccess = () => resolve(req.result);
            });

          await putRow(opId);

          // Mismatched hash triggers transaction abort.
          let mismatchError: string | null = null;
          const tx1Aborted = await new Promise<boolean>((resolve) => {
            const tx = db.transaction(
              [STORAGE_STORES.owner_meta, STORAGE_STORES.operations],
              "readwrite"
            );
            confirmPulledOperationInTx(tx, ctx, opId, wrongHash, {
              onError: (err: any) => {
                mismatchError = err.code;
              },
            });
            tx.oncomplete = () => resolve(false);
            tx.onabort = () => resolve(true);
            tx.onerror = () => resolve(true);
          });

          // A transaction that omits owner_meta must be rejected.
          let missingMetaError: string | null = null;
          const missingMetaAborted = await new Promise<boolean>((resolve) => {
            const tx = db.transaction(STORAGE_STORES.operations, "readwrite");
            confirmPulledOperationInTx(tx, ctx, opId, validHash, {
              onError: (err: any) => {
                missingMetaError = err.code;
              },
            });
            tx.oncomplete = () => resolve(false);
            tx.onabort = () => resolve(true);
            tx.onerror = () => resolve(true);
          });

          // Stale epoch, wrong owner and locked owner must all fail closed.
          let staleEpochError: string | null = null;
          const staleEpochAborted = await new Promise<boolean>((resolve) => {
            const tx = db.transaction(
              [STORAGE_STORES.owner_meta, STORAGE_STORES.operations],
              "readwrite"
            );
            confirmPulledOperationInTx(
              tx,
              { ...ctx, lockEpoch: ctx.lockEpoch + 1 },
              opId,
              validHash,
              {
                onError: (err: any) => {
                  staleEpochError = err.code;
                },
              }
            );
            tx.oncomplete = () => resolve(false);
            tx.onabort = () => resolve(true);
            tx.onerror = () => resolve(true);
          });

          let wrongOwnerError: string | null = null;
          const wrongOwnerAborted = await new Promise<boolean>((resolve) => {
            const tx = db.transaction(
              [STORAGE_STORES.owner_meta, STORAGE_STORES.operations],
              "readwrite"
            );
            confirmPulledOperationInTx(
              tx,
              { ...ctx, ownerId: otherOwnerId },
              opId,
              validHash,
              {
                onError: (err: any) => {
                  wrongOwnerError = err.code;
                },
              }
            );
            tx.oncomplete = () => resolve(false);
            tx.onabort = () => resolve(true);
            tx.onerror = () => resolve(true);
          });

          const rowAfterRejectedMutations = await readRow(opId);

          // Matching hash plus a valid context deletes the row.
          const tx2Completed = await new Promise<boolean>((resolve) => {
            const tx = db.transaction(
              [STORAGE_STORES.owner_meta, STORAGE_STORES.operations],
              "readwrite"
            );
            confirmPulledOperationInTx(tx, ctx, opId, validHash);
            tx.oncomplete = () => resolve(true);
            tx.onabort = () => resolve(false);
            tx.onerror = () => resolve(false);
          });

          const rowAfterCommit = await readRow(opId);

          // Locked owner cannot delete a second outbox row with the old context.
          await putRow(opId2);
          await lockOwner(db, ownerId);
          let lockedError: string | null = null;
          const lockedAborted = await new Promise<boolean>((resolve) => {
            const tx = db.transaction(
              [STORAGE_STORES.owner_meta, STORAGE_STORES.operations],
              "readwrite"
            );
            confirmPulledOperationInTx(tx, ctx, opId2, validHash, {
              onError: (err: any) => {
                lockedError = err.code;
              },
            });
            tx.oncomplete = () => resolve(false);
            tx.onabort = () => resolve(true);
            tx.onerror = () => resolve(true);
          });
          const rowAfterLock = await readRow(opId2);

          closeDatabase(db);

          return {
            ok: true,
            tx1Aborted,
            mismatchError,
            missingMetaAborted,
            missingMetaError,
            staleEpochAborted,
            staleEpochError,
            wrongOwnerAborted,
            wrongOwnerError,
            rowExistedAfterRejectedMutations: Boolean(rowAfterRejectedMutations),
            tx2Completed,
            rowDeletedAfterCommit: rowAfterCommit === undefined,
            lockedAborted,
            lockedError,
            rowExistedAfterLock: Boolean(rowAfterLock),
          };
        },
        {
          testDbName,
          ownerId,
          otherOwnerId,
          keyId,
          opId,
          opId2,
          validHash,
          wrongHash,
        }
      );

      expect(result.ok).toBe(true);
      expect(result.tx1Aborted).toBe(true);
      expect(result.mismatchError).toBe("integrity_failed");
      expect(result.missingMetaAborted).toBe(true);
      expect(result.missingMetaError).toBe("invalid_data");
      expect(result.staleEpochAborted).toBe(true);
      expect(result.staleEpochError).toBe("locked");
      expect(result.wrongOwnerAborted).toBe(true);
      expect(result.wrongOwnerError).toBe("locked");
      expect(result.rowExistedAfterRejectedMutations).toBe(true);
      expect(result.tx2Completed).toBe(true);
      expect(result.rowDeletedAfterCommit).toBe(true);
      expect(result.lockedAborted).toBe(true);
      expect(result.lockedError).toBe("locked");
      expect(result.rowExistedAfterLock).toBe(true);
    });

    test("M04: real two-page legacy unlock race lets only the key that authenticates all data win", async ({
      browser,
    }) => {
      const context = await browser.newContext();
      try {
        await context.addInitScript({ content: buildStorageScript() });

        const testDbName = `test-sentinel-m04-${Date.now()}`;
        const ownerId = "11111111-1111-4111-8111-210421042104";
        const keyId = "key-sentinel-m04";
        const planId = "22222222-2222-4222-8222-210421042104";
        const rightKeyBytes = Array.from(
          { length: 32 },
          (_, i) => (i * 11 + 7) % 256
        );
        const wrongKeyBytes = Array.from(
          { length: 32 },
          (_, i) => (i * 13 + 9) % 256
        );

        const page1 = await context.newPage();
        const page2 = await context.newPage();
        await Promise.all([page1.goto("/work"), page2.goto("/work")]);

        // Seed a pre-sentinel, already-unlocked legacy owner.
        const seeded = await page1.evaluate(
          async ({ testDbName, ownerId, keyId, planId, rightKeyBytes }) => {
            const {
              openDatabase,
              closeDatabase,
              importRawKey,
              encryptPayload,
              STORAGE_STORES,
            } = window.__dayforge_security_storage;
            const openRes = await openDatabase({ name: testDbName });
            if (!openRes.ok) return false;
            const db = openRes.value;
            const key = await importRawKey(new Uint8Array(rightKeyBytes));
            const enc = await encryptPayload(
              key,
              ownerId,
              keyId,
              STORAGE_STORES.records,
              `plan:${planId}`,
              { title: "Legacy cross-tab plan" }
            );
            if (!enc.ok) {
              closeDatabase(db);
              return false;
            }
            await new Promise<void>((resolve, reject) => {
              const tx = db.transaction(
                [STORAGE_STORES.owner_meta, STORAGE_STORES.records],
                "readwrite"
              );
              tx.objectStore(STORAGE_STORES.owner_meta).put({
                owner_id: ownerId,
                lock_epoch: 1,
                locked: false,
                active_key_id: keyId,
              });
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
            closeDatabase(db);
            return true;
          },
          { testDbName, ownerId, keyId, planId, rightKeyBytes }
        );
        expect(seeded).toBe(true);

        // The barrier is hosted in Node so the two pages have independent IDB
        // connections and both finish their Phase 1 snapshot before either commits.
        let arrivals = 0;
        let release: (() => void) | null = null;
        const barrier = async () => {
          arrivals += 1;
          if (arrivals >= 2) {
            const releaseNow = release;
            release = null;
            releaseNow?.();
            return;
          }
          await Promise.race([
            new Promise<void>((resolve) => {
              release = resolve;
            }),
            new Promise<void>((_, reject) =>
              setTimeout(
                () => reject(new Error("phase-1 barrier timeout")),
                10_000
              )
            ),
          ]);
        };
        await page1.exposeFunction("__dayforge_phase1_barrier", barrier);
        await page2.exposeFunction("__dayforge_phase1_barrier", barrier);

        const runUnlock = (
          targetPage: typeof page1,
          rawKeyBytes: number[],
          useBarrier = true
        ) =>
          targetPage.evaluate(
            async ({ testDbName, ownerId, keyId, rawKeyBytes, useBarrier }) => {
              const { openDatabase, closeDatabase, importRawKey, unlockOwner } =
                window.__dayforge_security_storage;
              const openRes = await openDatabase({ name: testDbName });
              if (!openRes.ok) return { ok: false, code: "open_failed", epoch: null };
              const db = openRes.value;
              const key = await importRawKey(new Uint8Array(rawKeyBytes));
              const unlock = await unlockOwner(
                db,
                ownerId,
                keyId,
                key,
                useBarrier
                  ? {
                      afterPhase1Barrier: async () => {
                        await (
                          window as unknown as {
                            __dayforge_phase1_barrier: () => Promise<void>;
                          }
                        ).__dayforge_phase1_barrier();
                      },
                    }
                  : undefined
              );
              closeDatabase(db);
              return {
                ok: unlock.ok,
                code: !unlock.ok ? unlock.error.code : null,
                epoch: unlock.ok ? unlock.value.lockEpoch : null,
              };
            },
            { testDbName, ownerId, keyId, rawKeyBytes, useBarrier }
          );

        const [rightResult, wrongResult] = await Promise.all([
          runUnlock(page1, rightKeyBytes),
          runUnlock(page2, wrongKeyBytes),
        ]);

        expect(rightResult.ok).toBe(true);
        expect(rightResult.epoch).toBe(2);
        expect(wrongResult.ok).toBe(false);
        expect(wrongResult.code).toBe("integrity_failed");

        // A stale pre-backfill context must be rejected on both connections.
        const runOldContextWrite = (
          targetPage: typeof page1,
          rawKeyBytes: number[]
        ) =>
          targetPage.evaluate(
            async ({ testDbName, ownerId, keyId, rawKeyBytes }) => {
              const { openDatabase, closeDatabase, importRawKey, writeOwnerViewPreference } =
                window.__dayforge_security_storage;
              const openRes = await openDatabase({ name: testDbName });
              if (!openRes.ok) return { ok: false, code: "open_failed" };
              const db = openRes.value;
              const key = await importRawKey(new Uint8Array(rawKeyBytes));
              const write = await writeOwnerViewPreference(
                db,
                { ownerId, keyId, lockEpoch: 1, key },
                "work",
                {
                  date: "2026-11-01",
                  scale: "week",
                  updatedAt: "2026-11-01T00:00:00.000Z",
                }
              );
              closeDatabase(db);
              return { ok: write.ok, code: !write.ok ? write.error.code : null };
            },
            { testDbName, ownerId, keyId, rawKeyBytes }
          );

        const [rightOldWrite, wrongOldWrite] = await Promise.all([
          runOldContextWrite(page1, rightKeyBytes),
          runOldContextWrite(page2, wrongKeyBytes),
        ]);
        expect(rightOldWrite.ok).toBe(false);
        expect(rightOldWrite.code).toBe("locked");
        expect(wrongOldWrite.ok).toBe(false);
        expect(wrongOldWrite.code).toBe("locked");

        // The losing page cannot acquire a fresh context after the winner commits.
        const loserRetry = await runUnlock(page2, wrongKeyBytes, false);
        expect(loserRetry.ok).toBe(false);
        expect(loserRetry.code).toBe("integrity_failed");

        // The winner can still write and read its own encrypted data.
        const winnerCheck = await page1.evaluate(
          async ({ testDbName, ownerId, keyId, rawKeyBytes, epoch }) => {
            const {
              openDatabase,
              closeDatabase,
              importRawKey,
              readOwnerViewPreference,
              writeOwnerViewPreference,
            } = window.__dayforge_security_storage;
            const openRes = await openDatabase({ name: testDbName });
            if (!openRes.ok) return { writeOk: false, readOk: false, scrollY: null };
            const db = openRes.value;
            const key = await importRawKey(new Uint8Array(rawKeyBytes));
            const ctx = { ownerId, keyId, lockEpoch: epoch, key };
            const write = await writeOwnerViewPreference(db, ctx, "work", {
              date: "2026-11-01",
              scale: "week",
              scrollY: 42,
              updatedAt: "2026-11-01T00:00:00.000Z",
            });
            const read = await readOwnerViewPreference(db, ctx, "work");
            closeDatabase(db);
            return {
              writeOk: write.ok,
              readOk: read.ok,
              scrollY: read.ok ? read.value?.scrollY ?? null : null,
            };
          },
          {
            testDbName,
            ownerId,
            keyId,
            rawKeyBytes: rightKeyBytes,
            epoch: rightResult.epoch ?? 1,
          }
        );
        expect(winnerCheck.writeOk).toBe(true);
        expect(winnerCheck.readOk).toBe(true);
        expect(winnerCheck.scrollY).toBe(42);

        const finalState = await page1.evaluate(
          async ({ testDbName, ownerId }) => {
            const { openDatabase, closeDatabase, getOwnerMeta, STORAGE_STORES } =
              window.__dayforge_security_storage;
            const openRes = await openDatabase({ name: testDbName });
            if (!openRes.ok) return { metaEpoch: null, hasSentinel: false };
            const db = openRes.value;
            const meta = await getOwnerMeta(db, ownerId);
            const sentinel = await new Promise<any>((resolve) => {
              const tx = db.transaction(STORAGE_STORES.sync_meta, "readonly");
              const req = tx
                .objectStore(STORAGE_STORES.sync_meta)
                .get([ownerId, "owner-key-sentinel"]);
              req.onsuccess = () => resolve(req.result);
            });
            closeDatabase(db);
            return {
              metaEpoch: meta.ok ? meta.value?.lock_epoch ?? null : null,
              hasSentinel: Boolean(sentinel),
            };
          },
          { testDbName, ownerId }
        );
        expect(finalState.metaEpoch).toBe(2);
        expect(finalState.hasSentinel).toBe(true);
      } finally {
        await context.close();
      }
    });

    test("M06: legacy write after snapshot but before CAS forces retry and rejects mixed-key backfill", async ({
      page,
    }) => {
      await page.goto("/work");
      await page.addScriptTag({ content: buildStorageScript() });

      const dbName = "test-sentinel-m06-" + Date.now();
      const result = await page.evaluate(async (dbName) => {
        const {
          openDatabase,
          closeDatabase,
          importRawKey,
          encryptPayload,
          unlockOwner,
          writeOwnerViewPreference,
          getOwnerMeta,
          STORAGE_STORES,
        } = window.__dayforge_security_storage;

        const ownerId = "11111111-1111-4111-8111-210621062106";
        const keyId = "key-sentinel-m06";
        const planId = "22222222-2222-4222-8222-210621062106";
        const opened = await openDatabase({ name: dbName });
        if (!opened.ok) return { setupOk: false };
        const db = opened.value;
        const keyA = await importRawKey(new Uint8Array(32).fill(0xa6));
        const keyB = await importRawKey(new Uint8Array(32).fill(0xb6));
        const encrypted = await encryptPayload(
          keyA, ownerId, keyId, STORAGE_STORES.records,
          "plan:" + planId, { title: "Original legacy ciphertext" }
        );
        if (!encrypted.ok) return { setupOk: false };

        await new Promise<void>((resolve, reject) => {
          const tx = db.transaction(
            [STORAGE_STORES.owner_meta, STORAGE_STORES.records], "readwrite"
          );
          tx.objectStore(STORAGE_STORES.owner_meta).put({
            owner_id: ownerId,
            lock_epoch: 7,
            locked: false,
            active_key_id: keyId,
          });
          tx.objectStore(STORAGE_STORES.records).put({
            owner_id: ownerId,
            kind: "plan",
            id: planId,
            key_id: keyId,
            iv: encrypted.value.iv,
            ciphertext: encrypted.value.ciphertext,
          });
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(tx.error);
        });

        let injected = false;
        let injectedWriteOk = false;
        const unlock = await unlockOwner(db, ownerId, keyId, keyA, {
          afterPhase1Barrier: async () => {
            // After the verified snapshot but before Phase 3, a stale tab
            // still using epoch 7 writes a new row with different key material.
            if (injected) return;
            injected = true;
            const write = await writeOwnerViewPreference(
              db, { ownerId, keyId, lockEpoch: 7, key: keyB },
              "work",
              {
                date: "2026-11-01",
                scale: "week",
                updatedAt: "2026-11-01T00:00:00.000Z",
              }
            );
            injectedWriteOk = write.ok;
          },
        });

        const meta = await getOwnerMeta(db, ownerId);
        const state = await new Promise<{
          sentinel: unknown;
          view: unknown;
          plan: unknown;
        }>((resolve, reject) => {
          const tx = db.transaction(
            [STORAGE_STORES.sync_meta, STORAGE_STORES.view_preferences, STORAGE_STORES.records],
            "readonly"
          );
          const sentinelReq = tx.objectStore(STORAGE_STORES.sync_meta)
            .get([ownerId, "owner-key-sentinel"]);
          const viewReq = tx.objectStore(STORAGE_STORES.view_preferences)
            .get([ownerId, "work"]);
          const planReq = tx.objectStore(STORAGE_STORES.records)
            .get([ownerId, "plan", planId]);
          tx.oncomplete = () => resolve({
            sentinel: sentinelReq.result,
            view: viewReq.result,
            plan: planReq.result,
          });
          tx.onabort = () => reject(tx.error);
        });
        closeDatabase(db);
        return {
          setupOk: true,
          injected,
          injectedWriteOk,
          unlockOk: unlock.ok,
          unlockError: !unlock.ok ? unlock.error.code : null,
          epoch: meta.ok ? meta.value?.lock_epoch : null,
          sentinelAbsent: state.sentinel === undefined,
          viewPresent: state.view !== undefined,
          planPresent: state.plan !== undefined,
        };
      }, dbName);

      expect(result.setupOk).toBe(true);
      expect(result.injected).toBe(true);
      expect(result.injectedWriteOk).toBe(true);
      expect(result.unlockOk).toBe(false);
      expect(result.unlockError).toBe("integrity_failed");
      expect(result.epoch).toBe(7);
      expect(result.sentinelAbsent).toBe(true);
      expect(result.viewPresent).toBe(true);
      expect(result.planPresent).toBe(true);
    });

  });
});

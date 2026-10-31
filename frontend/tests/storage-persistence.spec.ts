import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import ts from "typescript";
import {
  StorageError,
  storageErr,
  storageOk,
  openDatabase,
  closeDatabase,
  DB_NAME,
  CURRENT_SCHEMA_VERSION,
  STORAGE_STORES,
  STORE_DEFINITIONS,
  upgradeDatabase,
  checkVersionCompatibility,
  isVersionSupported,
} from "../lib/storage";

declare global {
  interface Window {
    __dayforge_storage: {
      StorageError: typeof StorageError;
      storageOk: typeof storageOk;
      storageErr: typeof storageErr;
      DB_NAME: typeof DB_NAME;
      CURRENT_SCHEMA_VERSION: typeof CURRENT_SCHEMA_VERSION;
      STORAGE_STORES: typeof STORAGE_STORES;
      STORE_DEFINITIONS: typeof STORE_DEFINITIONS;
      upgradeDatabase: typeof upgradeDatabase;
      isVersionSupported: typeof isVersionSupported;
      checkVersionCompatibility: typeof checkVersionCompatibility;
      openDatabase: typeof openDatabase;
      closeDatabase: typeof closeDatabase;
    };
  }
}

function buildStorageScript(): string {
  const libDir = path.resolve(__dirname, "../lib/storage");
  const errorsCode = fs.readFileSync(path.join(libDir, "errors.ts"), "utf-8");
  const schemaCode = fs.readFileSync(path.join(libDir, "schema.ts"), "utf-8");
  const migrationCode = fs.readFileSync(path.join(libDir, "migration.ts"), "utf-8");
  const dbCode = fs.readFileSync(path.join(libDir, "db.ts"), "utf-8");

  const combined = [errorsCode, schemaCode, migrationCode, dbCode]
    .join("\n")
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
    window.__dayforge_storage = exports;
  })();`;
}

test.describe("Storage Foundation Specifications", () => {
  test.describe("ST-02: Server-side and SSR Safety", () => {
    test("calling openDatabase in Node environment returns unavailable error without throwing", async () => {
      const result = await openDatabase();
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBeInstanceOf(StorageError);
        expect(result.error.code).toBe("unavailable");
        expect(result.error.message).toContain("server context");
      }
    });

    test("StorageError and result helper constructors behave according to contract", () => {
      const err = new StorageError("blocked", "database blocked", new Error("root"));
      expect(err.name).toBe("StorageError");
      expect(err.code).toBe("blocked");
      expect(err.message).toBe("database blocked");
      expect(err.cause).toBeDefined();

      const okResult = storageOk({ foo: "bar" });
      expect(okResult).toEqual({ ok: true, value: { foo: "bar" } });

      const errResult = storageErr("locked", "owner locked");
      expect(errResult.ok).toBe(false);
      if (!errResult.ok) {
        expect(errResult.error.code).toBe("locked");
        expect(errResult.error.message).toBe("owner locked");
      }
    });

    test("version compatibility check rejects unsupported higher versions", () => {
      expect(isVersionSupported(1)).toBe(true);
      expect(isVersionSupported(2)).toBe(false);

      const okRes = checkVersionCompatibility(1);
      expect(okRes.ok).toBe(true);

      const errRes = checkVersionCompatibility(2);
      expect(errRes.ok).toBe(false);
      if (!errRes.ok) {
        expect(errRes.error.code).toBe("unsupported_version");
      }
    });
  });

  test.describe("Browser IndexedDB Runtime and Schema", () => {
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

    test("creates all 8 object stores and required indexes on version 1", async ({ page }) => {
      const details = await page.evaluate(async () => {
        const { openDatabase, closeDatabase, STORAGE_STORES } = window.__dayforge_storage;
        const res = await openDatabase();
        if (!res.ok) {
          return { ok: false as const, error: res.error.code };
        }
        const db = res.value;
        const storeNames = Array.from(db.objectStoreNames);

        const tx = db.transaction(storeNames, "readonly");
        const stores = storeNames.map((name) => {
          const store = tx.objectStore(name);
          const indexes = Array.from(store.indexNames).map((idxName) => {
            const index = store.index(idxName);
            return {
              name: idxName,
              keyPath: index.keyPath,
              unique: index.unique,
            };
          });
          return {
            name,
            keyPath: store.keyPath,
            indexes,
          };
        });

        closeDatabase(db);
        return { ok: true as const, stores, storeNames };
      });

      expect(details.ok).toBe(true);
      if (!details.ok) return;

      expect(details.storeNames).toContain(STORAGE_STORES.owner_meta);
      expect(details.storeNames).toContain(STORAGE_STORES.crypto_keys);
      expect(details.storeNames).toContain(STORAGE_STORES.device_meta);
      expect(details.storeNames).toContain(STORAGE_STORES.records);
      expect(details.storeNames).toContain(STORAGE_STORES.operations);
      expect(details.storeNames).toContain(STORAGE_STORES.sync_meta);
      expect(details.storeNames).toContain(STORAGE_STORES.view_preferences);
      expect(details.storeNames).toContain(STORAGE_STORES.drafts);

      const recordsStore = details.stores.find((s) => s.name === STORAGE_STORES.records);
      expect(recordsStore?.keyPath).toEqual(["owner_id", "kind", "id"]);
      const recordsByKind = recordsStore?.indexes.find((i) => i.name === "by_kind");
      expect(recordsByKind?.keyPath).toEqual(["owner_id", "kind"]);

      const operationsStore = details.stores.find((s) => s.name === STORAGE_STORES.operations);
      expect(operationsStore?.keyPath).toEqual(["owner_id", "operation_id"]);
      const opsBySeq = operationsStore?.indexes.find((i) => i.name === "by_device_sequence");
      expect(opsBySeq?.keyPath).toEqual(["owner_id", "device_sequence"]);
    });

    test("ST-01: writes record, closes, reopens, and persists across page reload", async ({ page }) => {
      const writeResult = await page.evaluate(async () => {
        const { openDatabase, closeDatabase, STORAGE_STORES } = window.__dayforge_storage;
        const res = await openDatabase();
        if (!res.ok) return { ok: false as const, error: res.error.code };
        const db = res.value;

        return new Promise<{ ok: true } | { ok: false; error?: string }>((resolve) => {
          const tx = db.transaction([STORAGE_STORES.records, STORAGE_STORES.owner_meta], "readwrite");
          const recordsStore = tx.objectStore(STORAGE_STORES.records);
          const ownerStore = tx.objectStore(STORAGE_STORES.owner_meta);

          recordsStore.put({
            owner_id: "owner_alpha",
            kind: "event",
            id: "evt_123",
            ciphertext: "sample_cipher_payload",
          });

          ownerStore.put({
            owner_id: "owner_alpha",
            lock_epoch: 1,
            locked: false,
          });

          tx.oncomplete = () => {
            closeDatabase(db);
            resolve({ ok: true });
          };
          tx.onerror = () => {
            closeDatabase(db);
            resolve({ ok: false, error: tx.error?.name });
          };
        });
      });

      expect(writeResult.ok).toBe(true);

      // Verify read on reopen without reload
      const readBeforeReload = await page.evaluate(async () => {
        const { openDatabase, closeDatabase, STORAGE_STORES } = window.__dayforge_storage;
        const res = await openDatabase();
        if (!res.ok) return { ok: false as const, error: res.error.code };
        const db = res.value;

        return new Promise<{ ok: true; record: unknown } | { ok: false; error?: string }>((resolve) => {
          const tx = db.transaction(STORAGE_STORES.records, "readonly");
          const req = tx.objectStore(STORAGE_STORES.records).get(["owner_alpha", "event", "evt_123"]);
          req.onsuccess = () => {
            closeDatabase(db);
            resolve({ ok: true, record: req.result });
          };
          req.onerror = () => {
            closeDatabase(db);
            resolve({ ok: false, error: req.error?.name });
          };
        });
      });

      expect(readBeforeReload.ok).toBe(true);
      if (!readBeforeReload.ok) return;
      expect(readBeforeReload.record).toEqual({
        owner_id: "owner_alpha",
        kind: "event",
        id: "evt_123",
        ciphertext: "sample_cipher_payload",
      });

      // Reload page to test full browser persistence
      await page.reload();

      const readAfterReload = await page.evaluate(async () => {
        const { openDatabase, closeDatabase, STORAGE_STORES } = window.__dayforge_storage;
        const res = await openDatabase();
        if (!res.ok) return { ok: false as const, error: res.error.code };
        const db = res.value;

        return new Promise<
          { ok: true; record: unknown; owner: unknown } | { ok: false; error?: string }
        >((resolve) => {
          const tx = db.transaction([STORAGE_STORES.records, STORAGE_STORES.owner_meta], "readonly");
          const recReq = tx.objectStore(STORAGE_STORES.records).get(["owner_alpha", "event", "evt_123"]);
          const ownerReq = tx.objectStore(STORAGE_STORES.owner_meta).get("owner_alpha");

          tx.oncomplete = () => {
            closeDatabase(db);
            resolve({ ok: true, record: recReq.result, owner: ownerReq.result });
          };
          tx.onerror = () => {
            closeDatabase(db);
            resolve({ ok: false, error: tx.error?.name });
          };
        });
      });

      expect(readAfterReload.ok).toBe(true);
      if (!readAfterReload.ok) return;
      expect(readAfterReload.record).toEqual({
        owner_id: "owner_alpha",
        kind: "event",
        id: "evt_123",
        ciphertext: "sample_cipher_payload",
      });
      expect(readAfterReload.owner).toEqual({
        owner_id: "owner_alpha",
        lock_epoch: 1,
        locked: false,
      });
    });

    test("closes connection automatically on versionchange so new upgrades are not blocked", async ({ page }) => {
      const result = await page.evaluate(async () => {
        const { openDatabase, closeDatabase, DB_NAME } = window.__dayforge_storage;

        let versionChangeCalled = false;
        const conn1Res = await openDatabase({
          onVersionChange: () => {
            versionChangeCalled = true;
          },
        });
        if (!conn1Res.ok) return { ok: false as const, error: "conn1 failed" };

        // Open connection 2 with version 2 to trigger upgrade and versionchange
        return new Promise<{ ok: true; versionChangeCalled: boolean } | { ok: false; error: string }>((resolve) => {
          const upgradeReq = indexedDB.open(DB_NAME, 2);
          upgradeReq.onupgradeneeded = () => {
            // upgrade succeeded because conn1 closed
          };
          upgradeReq.onsuccess = () => {
            const db2 = upgradeReq.result;
            closeDatabase(db2);
            resolve({ ok: true, versionChangeCalled });
          };
          upgradeReq.onerror = () => {
            resolve({ ok: false, error: upgradeReq.error?.message ?? "upgrade error" });
          };
          upgradeReq.onblocked = () => {
            resolve({ ok: false, error: "upgrade blocked" });
          };
        });
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.versionChangeCalled).toBe(true);
    });

    test("invokes onBlocked and fails with blocked error when connection refuses to close", async ({ page }) => {
      const result = await page.evaluate(async () => {
        const { openDatabase, DB_NAME } = window.__dayforge_storage;

        // Open a raw uncooperative connection that doesn't close on versionchange
        const uncooperativeReq = indexedDB.open(DB_NAME, 1);
        await new Promise<void>((resolve) => {
          uncooperativeReq.onsuccess = () => resolve();
        });

        let blockedFired = false;
        const upgradeRes = await openDatabase({
          version: 2,
          blockedTimeoutMs: 250,
          onBlocked: () => {
            blockedFired = true;
          },
        });

        // Clean up uncooperative connection
        uncooperativeReq.result.close();

        return {
          upgradeOk: upgradeRes.ok,
          errorCode: !upgradeRes.ok ? upgradeRes.error.code : null,
          blockedFired,
        };
      });

      expect(result.blockedFired).toBe(true);
      expect(result.upgradeOk).toBe(false);
      expect(result.errorCode).toBe("blocked");
    });

    test("returns unsupported_version when database on disk has higher version than requested", async ({ page }) => {
      const result = await page.evaluate(async () => {
        const { openDatabase, DB_NAME } = window.__dayforge_storage;

        // Upgrade DB to version 5
        const v5Req = indexedDB.open(DB_NAME, 5);
        await new Promise<void>((resolve, reject) => {
          v5Req.onsuccess = () => {
            v5Req.result.close();
            resolve();
          };
          v5Req.onerror = () => reject(v5Req.error);
        });

        // Now attempt to open with version 1
        const res = await openDatabase({ version: 1 });
        return {
          ok: res.ok,
          errorCode: !res.ok ? res.error.code : null,
        };
      });

      expect(result.ok).toBe(false);
      expect(result.errorCode).toBe("unsupported_version");
    });
  });
});

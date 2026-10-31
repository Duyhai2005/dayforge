import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import ts from "typescript";
import {
  StorageError,
  openDatabase,
  closeDatabase,
  DB_NAME,
  CURRENT_SCHEMA_VERSION,
  STORAGE_STORES,
  STORE_DEFINITIONS,
  upgradeDatabase,
  isVersionSupported,
  checkVersionCompatibility,
  type MigrationStep,
  registerMigrationStep,
  clearMigrationSteps,
  getRegisteredMigrationSteps,
  executeMigrations,
  getMaxSupportedVersion,
} from "../lib/storage";

declare global {
  interface Window {
    __dayforge_storage_migrations: {
      StorageError: typeof StorageError;
      DB_NAME: typeof DB_NAME;
      CURRENT_SCHEMA_VERSION: typeof CURRENT_SCHEMA_VERSION;
      STORAGE_STORES: typeof STORAGE_STORES;
      STORE_DEFINITIONS: typeof STORE_DEFINITIONS;
      upgradeDatabase: typeof upgradeDatabase;
      openDatabase: typeof openDatabase;
      closeDatabase: typeof closeDatabase;
      isVersionSupported: typeof isVersionSupported;
      checkVersionCompatibility: typeof checkVersionCompatibility;
      registerMigrationStep: typeof registerMigrationStep;
      clearMigrationSteps: typeof clearMigrationSteps;
      getRegisteredMigrationSteps: typeof getRegisteredMigrationSteps;
      executeMigrations: typeof executeMigrations;
      getMaxSupportedVersion: typeof getMaxSupportedVersion;
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
    window.__dayforge_storage_migrations = exports;
  })();`;
}

test.describe("Storage Schema Migration Specifications", () => {
  test.describe("Node & Unit Execution: MigrationStep and Registry Validation", () => {
    test.beforeEach(() => {
      clearMigrationSteps();
    });

    test("executeMigrations throws unsupported_version when targetVersion < oldVersion (downgrade prevention)", () => {
      const dummyDb = {} as IDBDatabase;
      const dummyTx = {} as IDBTransaction;
      expect(() => {
        executeMigrations(dummyDb, dummyTx, 2, 1);
      }).toThrowError(/downgrade/i);

      let caught: unknown = null;
      try {
        executeMigrations(dummyDb, dummyTx, 2, 1);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(StorageError);
      expect((caught as StorageError).code).toBe("unsupported_version");
    });

    test("registerMigrationStep validates that fromVersion < toVersion", () => {
      expect(() => {
        registerMigrationStep({
          fromVersion: 2,
          toVersion: 2,
          description: "no-op invalid",
          upgrade: () => {},
        });
      }).toThrowError();

      expect(() => {
        registerMigrationStep({
          fromVersion: 3,
          toVersion: 1,
          description: "backward invalid",
          upgrade: () => {},
        });
      }).toThrowError();
    });

    test("registerMigrationStep stores steps in order and overwrites matching from/to pairs", () => {
      registerMigrationStep({
        fromVersion: 2,
        toVersion: 3,
        description: "v2 to v3 step",
        upgrade: () => {},
      });
      registerMigrationStep({
        fromVersion: 1,
        toVersion: 2,
        description: "v1 to v2 step",
        upgrade: () => {},
      });

      const steps = getRegisteredMigrationSteps();
      expect(steps.length).toBe(2);
      expect(steps[0].fromVersion).toBe(1);
      expect(steps[1].fromVersion).toBe(2);

      registerMigrationStep({
        fromVersion: 1,
        toVersion: 2,
        description: "v1 to v2 step updated",
        upgrade: () => {},
      });

      const updatedSteps = getRegisteredMigrationSteps();
      expect(updatedSteps.length).toBe(2);
      expect(updatedSteps[0].description).toBe("v1 to v2 step updated");
    });

    test("executeMigrations throws migration_failed when a gap exists in the migration path", () => {
      registerMigrationStep({
        fromVersion: 2,
        toVersion: 3,
        description: "v2 to v3",
        upgrade: () => {},
      });

      const dummyDb = {} as IDBDatabase;
      const dummyTx = {} as IDBTransaction;

      let caught: unknown = null;
      try {
        executeMigrations(dummyDb, dummyTx, 1, 3);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(StorageError);
      expect((caught as StorageError).code).toBe("migration_failed");
      expect((caught as StorageError).message).toContain("No migration step found");
    });

    test("executeMigrations wraps unexpected migration exceptions with migration_failed StorageError", () => {
      registerMigrationStep({
        fromVersion: 1,
        toVersion: 2,
        description: "failing step",
        upgrade: () => {
          throw new Error("Custom index creation failed disk full");
        },
      });

      const dummyDb = {} as IDBDatabase;
      const dummyTx = {} as IDBTransaction;

      let caught: unknown = null;
      try {
        executeMigrations(dummyDb, dummyTx, 1, 2);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(StorageError);
      expect((caught as StorageError).code).toBe("migration_failed");
      expect((caught as StorageError).message).toContain("Custom index creation failed disk full");
    });

    test("getMaxSupportedVersion reflects CURRENT_SCHEMA_VERSION or highest registered step", () => {
      expect(getMaxSupportedVersion()).toBe(CURRENT_SCHEMA_VERSION);
      registerMigrationStep({
        fromVersion: 1,
        toVersion: 4,
        description: "step to v4",
        upgrade: () => {},
      });
      expect(getMaxSupportedVersion()).toBe(4);
    });
  });

  test.describe("Browser Runtime Migration, Rollback & Data Preservation", () => {
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

    test("ST-13: Upgrade from v1 to v2 preserves all pending outbox, keys, records and device metadata", async ({
      page,
    }) => {
      const testOwnerId = "11111111-1111-4111-8111-111111111111";

      const seedResult = await page.evaluate(async (ownerId) => {
        const { openDatabase, closeDatabase, clearMigrationSteps } =
          window.__dayforge_storage_migrations;
        clearMigrationSteps();

        const openRes = await openDatabase({ version: 1 });
        if (!openRes.ok) throw new Error(openRes.error.message);
        const db = openRes.value;

        try {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(
              [
                "owner_meta",
                "crypto_keys",
                "device_meta",
                "records",
                "operations",
                "sync_meta",
              ],
              "readwrite"
            );

            tx.objectStore("owner_meta").put({
              owner_id: ownerId,
              created_at: "2026-10-31T10:00:00.000Z",
              key_derivation_params: {
                kdf: "pbkdf2",
                salt: "somesalt12345678",
                iterations: 100000,
                hash: "SHA-256",
              },
            });

            tx.objectStore("crypto_keys").put({
              owner_id: ownerId,
              key_id: "root-key-01",
              encrypted_key: "ciphertext-key-payload-base64",
              nonce: "nonce12345678",
              created_at: "2026-10-31T10:00:00.000Z",
            });

            tx.objectStore("device_meta").put({
              owner_id: ownerId,
              device_id: "dev-001",
              label: "Primary Browser Tab",
              registered_at: "2026-10-31T10:00:00.000Z",
            });

            tx.objectStore("records").put({
              owner_id: ownerId,
              kind: "task",
              id: "task-001",
              ciphertext: "encrypted-task-content-v1",
              nonce: "record-nonce-001",
              auth_tag: "auth-tag-001",
              key_id: "root-key-01",
              record_version: 1,
              updated_at: "2026-10-31T10:05:00.000Z",
            });

            tx.objectStore("records").put({
              owner_id: ownerId,
              kind: "plan",
              id: "plan-001",
              ciphertext: "encrypted-plan-content-v1",
              nonce: "record-nonce-002",
              auth_tag: "auth-tag-002",
              key_id: "root-key-01",
              record_version: 1,
              updated_at: "2026-10-31T10:06:00.000Z",
            });

            tx.objectStore("operations").put({
              owner_id: ownerId,
              operation_id: "op-00000001",
              device_sequence: "0000000000000001",
              status: "pending",
              envelope: {
                operation_id: "op-00000001",
                device_id: "dev-001",
                device_sequence: "0000000000000001",
                action: "upsert",
                record_kind: "task",
                record_id: "task-001",
                payload_ciphertext: "encrypted-task-content-v1",
                payload_nonce: "record-nonce-001",
                payload_auth_tag: "auth-tag-001",
                payload_key_id: "root-key-01",
                record_version: 1,
                hlc_timestamp: {
                  physical_ms: 1793444700000,
                  logical: 0,
                  calibration_id: "11111111-1111-4111-8111-111111111111",
                  quality: "monotonic",
                },
              },
              payload_hash: "3a7b9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b",
              created_at: "2026-10-31T10:05:00.000Z",
              retry_count: 0,
            });

            tx.objectStore("sync_meta").put({
              owner_id: ownerId,
              key: "clock_state",
              value: {
                physical_ms: 1793444700000,
                logical: 0,
                calibration_id: "11111111-1111-4111-8111-111111111111",
                quality: "monotonic",
              },
            });

            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
          return { success: true };
        } finally {
          closeDatabase(db);
        }
      }, testOwnerId);

      expect(seedResult.success).toBe(true);

      const upgradeResult = await page.evaluate(async (ownerId) => {
        const {
          openDatabase,
          closeDatabase,
          registerMigrationStep,
        } = window.__dayforge_storage_migrations;

        registerMigrationStep({
          fromVersion: 1,
          toVersion: 2,
          description: "Add by_record_version index to records and paired_devices store",
          upgrade: (db: IDBDatabase, transaction: IDBTransaction) => {
            const recordsStore = transaction.objectStore("records");
            recordsStore.createIndex("by_record_version", "record_version", {
              unique: false,
            });
            db.createObjectStore("paired_devices", {
              keyPath: ["owner_id", "paired_device_id"],
            });
          },
        });

        const openRes = await openDatabase({ version: 2 });
        if (!openRes.ok) {
          return {
            ok: false as const,
            error: openRes.error.code,
            message: openRes.error.message,
          };
        }
        const db = openRes.value;

        try {
          const version = db.version;
          const storeNames = Array.from(db.objectStoreNames);

          const readData = await new Promise<{
            ownerMeta: any;
            cryptoKey: any;
            deviceMeta: any;
            records: any[];
            outboxOps: any[];
            syncMeta: any;
            recordsIndexNames: string[];
          }>((resolve, reject) => {
            const tx = db.transaction(
              [
                "owner_meta",
                "crypto_keys",
                "device_meta",
                "records",
                "operations",
                "sync_meta",
              ],
              "readonly"
            );

            let ownerMeta: any = null;
            let cryptoKey: any = null;
            let deviceMeta: any = null;
            const records: any[] = [];
            const outboxOps: any[] = [];
            let syncMeta: any = null;

            const recStore = tx.objectStore("records");
            const recordsIndexNames = Array.from(recStore.indexNames);

            tx.objectStore("owner_meta").get(ownerId).onsuccess = (e: any) => {
              ownerMeta = e.target.result;
            };
            tx.objectStore("crypto_keys").get([ownerId, "root-key-01"]).onsuccess = (e: any) => {
              cryptoKey = e.target.result;
            };
            tx.objectStore("device_meta").get([ownerId, "dev-001"]).onsuccess = (e: any) => {
              deviceMeta = e.target.result;
            };
            recStore.openCursor().onsuccess = (e: any) => {
              const cursor = e.target.result;
              if (cursor) {
                records.push(cursor.value);
                cursor.continue();
              }
            };
            tx.objectStore("operations").openCursor().onsuccess = (e: any) => {
              const cursor = e.target.result;
              if (cursor) {
                outboxOps.push(cursor.value);
                cursor.continue();
              }
            };
            tx.objectStore("sync_meta").get([ownerId, "clock_state"]).onsuccess = (e: any) => {
              syncMeta = e.target.result;
            };

            tx.oncomplete = () =>
              resolve({
                ownerMeta,
                cryptoKey,
                deviceMeta,
                records,
                outboxOps,
                syncMeta,
                recordsIndexNames,
              });
            tx.onerror = () => reject(tx.error);
          });

          return {
            ok: true as const,
            version,
            storeNames,
            ...readData,
          };
        } finally {
          closeDatabase(db);
        }
      }, testOwnerId);

      expect(upgradeResult.ok).toBe(true);
      if (!upgradeResult.ok) return;

      expect(upgradeResult.version).toBe(2);
      expect(upgradeResult.storeNames).toContain("paired_devices");
      expect(upgradeResult.recordsIndexNames).toContain("by_record_version");

      expect(upgradeResult.ownerMeta).toBeDefined();
      expect(upgradeResult.ownerMeta.owner_id).toBe(testOwnerId);
      expect(upgradeResult.ownerMeta.key_derivation_params.kdf).toBe("pbkdf2");

      expect(upgradeResult.cryptoKey).toBeDefined();
      expect(upgradeResult.cryptoKey.encrypted_key).toBe("ciphertext-key-payload-base64");

      expect(upgradeResult.deviceMeta).toBeDefined();
      expect(upgradeResult.deviceMeta.device_id).toBe("dev-001");

      expect(upgradeResult.records.length).toBe(2);
      const taskRecord = upgradeResult.records.find((r: any) => r.id === "task-001");
      expect(taskRecord).toBeDefined();
      expect(taskRecord.ciphertext).toBe("encrypted-task-content-v1");
      expect(taskRecord.auth_tag).toBe("auth-tag-001");

      expect(upgradeResult.outboxOps.length).toBe(1);
      const op = upgradeResult.outboxOps[0];
      expect(op.operation_id).toBe("op-00000001");
      expect(op.status).toBe("pending");
      expect(op.device_sequence).toBe("0000000000000001");
      expect(op.payload_hash).toBe("3a7b9c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b");

      expect(upgradeResult.syncMeta).toBeDefined();
      expect(upgradeResult.syncMeta.value.quality).toBe("monotonic");
    });

    test("ST-14: Higher DB version opened by old tab fails with unsupported_version without deleting database", async ({
      page,
    }) => {
      const testOwnerId = "22222222-2222-4222-8222-222222222222";

      const setupResult = await page.evaluate(async (ownerId) => {
        const {
          openDatabase,
          closeDatabase,
          clearMigrationSteps,
          registerMigrationStep,
        } = window.__dayforge_storage_migrations;

        clearMigrationSteps();
        registerMigrationStep({
          fromVersion: 1,
          toVersion: 2,
          description: "Advance to version 2",
          upgrade: (db: IDBDatabase) => {
            db.createObjectStore("v2_markers", { keyPath: "id" });
          },
        });

        const openRes = await openDatabase({ version: 2 });
        if (!openRes.ok) throw new Error(openRes.error.message);
        const db = openRes.value;

        try {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(["records", "v2_markers"], "readwrite");
            tx.objectStore("records").put({
              owner_id: ownerId,
              kind: "task",
              id: "task-v2-001",
              ciphertext: "precious-ciphertext-data",
              nonce: "nonce-xyz",
              auth_tag: "tag-xyz",
              key_id: "key-xyz",
              record_version: 1,
              updated_at: "2026-10-31T12:00:00.000Z",
            });
            tx.objectStore("v2_markers").put({ id: "marker-1", value: "active-v2" });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
          return { ok: true, version: db.version };
        } finally {
          closeDatabase(db);
        }
      }, testOwnerId);

      expect(setupResult.ok).toBe(true);
      expect(setupResult.version).toBe(2);

      const oldTabResult = await page.evaluate(async () => {
        const { openDatabase } = window.__dayforge_storage_migrations;
        const res = await openDatabase({ version: 1 });
        return {
          ok: res.ok,
          errorCode: !res.ok ? res.error.code : null,
          errorMessage: !res.ok ? res.error.message : null,
        };
      });

      expect(oldTabResult.ok).toBe(false);
      expect(oldTabResult.errorCode).toBe("unsupported_version");

      const verifyResult = await page.evaluate(async (ownerId) => {
        const { openDatabase, closeDatabase } = window.__dayforge_storage_migrations;
        const openRes = await openDatabase({ version: 2 });
        if (!openRes.ok) {
          return { ok: false, error: openRes.error.code };
        }
        const db = openRes.value;

        try {
          const version = db.version;
          const stores = Array.from(db.objectStoreNames);

          const record = await new Promise<any>((resolve, reject) => {
            const tx = db.transaction(["records"], "readonly");
            const req = tx.objectStore("records").get([ownerId, "task", "task-v2-001"]);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });

          return {
            ok: true,
            version,
            stores,
            recordCiphertext: record?.ciphertext,
          };
        } finally {
          closeDatabase(db);
        }
      }, testOwnerId);

      expect(verifyResult.ok).toBe(true);
      expect(verifyResult.version).toBe(2);
      expect(verifyResult.stores).toContain("v2_markers");
      expect(verifyResult.recordCiphertext).toBe("precious-ciphertext-data");
    });

    test("Migration failure cleanly aborts transaction and preserves v1 schema & data", async ({
      page,
    }) => {
      const testOwnerId = "33333333-3333-4333-8333-333333333333";

      const seedResult = await page.evaluate(async (ownerId) => {
        const { openDatabase, closeDatabase, clearMigrationSteps } =
          window.__dayforge_storage_migrations;
        clearMigrationSteps();

        const openRes = await openDatabase({ version: 1 });
        if (!openRes.ok) throw new Error(openRes.error.message);
        const db = openRes.value;

        try {
          await new Promise<void>((resolve, reject) => {
            const tx = db.transaction(["records", "operations"], "readwrite");
            tx.objectStore("records").put({
              owner_id: ownerId,
              kind: "task",
              id: "task-before-fail",
              ciphertext: "safe-unaltered-ciphertext",
              nonce: "nonce-safe",
              auth_tag: "tag-safe",
              key_id: "key-safe",
              record_version: 1,
              updated_at: "2026-10-31T14:00:00.000Z",
            });
            tx.objectStore("operations").put({
              owner_id: ownerId,
              operation_id: "op-safe-1",
              device_sequence: "0000000000000001",
              status: "pending",
              envelope: {
                operation_id: "op-safe-1",
                device_id: "dev-safe",
                device_sequence: "0000000000000001",
                action: "upsert",
                record_kind: "task",
                record_id: "task-before-fail",
                payload_ciphertext: "safe-unaltered-ciphertext",
                payload_nonce: "nonce-safe",
                payload_auth_tag: "tag-safe",
                payload_key_id: "key-safe",
                record_version: 1,
                hlc_timestamp: {
                  physical_ms: 1793444700000,
                  logical: 0,
                  calibration_id: "33333333-3333-4333-8333-333333333333",
                  quality: "monotonic",
                },
              },
              payload_hash: "safehash123",
              created_at: "2026-10-31T14:00:00.000Z",
              retry_count: 0,
            });
            tx.oncomplete = () => resolve();
            tx.onerror = () => reject(tx.error);
          });
          return { ok: true };
        } finally {
          closeDatabase(db);
        }
      }, testOwnerId);

      expect(seedResult.ok).toBe(true);

      const failedUpgradeResult = await page.evaluate(async () => {
        const {
          openDatabase,
          registerMigrationStep,
        } = window.__dayforge_storage_migrations;

        registerMigrationStep({
          fromVersion: 1,
          toVersion: 2,
          description: "Failing step that encounters disk or logic error",
          upgrade: (db: IDBDatabase) => {
            db.createObjectStore("temporary_partial_store", { keyPath: "id" });
            throw new Error("Deliberate error in migration step: constraint violation");
          },
        });

        const openRes = await openDatabase({ version: 2 });
        return {
          ok: openRes.ok,
          errorCode: !openRes.ok ? openRes.error.code : null,
          errorMessage: !openRes.ok ? openRes.error.message : null,
        };
      });

      expect(failedUpgradeResult.ok).toBe(false);
      expect(failedUpgradeResult.errorCode).toBe("migration_failed");
      expect(failedUpgradeResult.errorMessage).toContain("Deliberate error in migration step");

      const reopenResult = await page.evaluate(async (ownerId) => {
        const { openDatabase, closeDatabase } = window.__dayforge_storage_migrations;

        const openRes = await openDatabase({ version: 1 });
        if (!openRes.ok) {
          return { ok: false, error: openRes.error.code, message: openRes.error.message };
        }
        const db = openRes.value;

        try {
          const version = db.version;
          const stores = Array.from(db.objectStoreNames);

          const data = await new Promise<{ record: any; op: any }>((resolve, reject) => {
            const tx = db.transaction(["records", "operations"], "readonly");
            let record: any = null;
            let op: any = null;

            tx.objectStore("records").get([ownerId, "task", "task-before-fail"]).onsuccess = (e: any) => {
              record = e.target.result;
            };
            tx.objectStore("operations").get([ownerId, "op-safe-1"]).onsuccess = (e: any) => {
              op = e.target.result;
            };

            tx.oncomplete = () => resolve({ record, op });
            tx.onerror = () => reject(tx.error);
          });

          return {
            ok: true,
            version,
            stores,
            recordCiphertext: data.record?.ciphertext,
            opStatus: data.op?.status,
          };
        } finally {
          closeDatabase(db);
        }
      }, testOwnerId);

      expect(reopenResult.ok).toBe(true);
      expect(reopenResult.version).toBe(1);
      expect(reopenResult.stores).not.toContain("temporary_partial_store");
      expect(reopenResult.recordCiphertext).toBe("safe-unaltered-ciphertext");
      expect(reopenResult.opStatus).toBe("pending");
    });

    test("Two-tab versionchange during upgrade closes old connection cleanly and allows upgrade", async ({
      page,
      context,
    }) => {
      await page.evaluate(async () => {
        const { openDatabase, closeDatabase, clearMigrationSteps } =
          window.__dayforge_storage_migrations;
        clearMigrationSteps();
        const res = await openDatabase({ version: 1 });
        if (!res.ok) throw new Error(res.error.message);
        closeDatabase(res.value);
      });

      const tab1 = page;
      const tab1Connected = await tab1.evaluate(async () => {
        const { openDatabase } = window.__dayforge_storage_migrations;
        const res = await openDatabase({
          version: 1,
          onVersionChange: () => {
            (window as any).__tab1_versionchange_fired = true;
          },
        });
        if (!res.ok) throw new Error(res.error.message);
        (window as any).__tab1_db = res.value;
        return { connected: true, version: res.value.version };
      });
      expect(tab1Connected.connected).toBe(true);
      expect(tab1Connected.version).toBe(1);

      const tab2 = await context.newPage();
      const script = buildStorageScript();
      await tab2.addInitScript({ content: script });
      await tab2.goto("/work");

      const tab2UpgradeResult = await tab2.evaluate(async () => {
        const {
          openDatabase,
          closeDatabase,
          clearMigrationSteps,
          registerMigrationStep,
        } = window.__dayforge_storage_migrations;

        clearMigrationSteps();
        registerMigrationStep({
          fromVersion: 1,
          toVersion: 2,
          description: "Two-tab upgrade step",
          upgrade: (db: IDBDatabase) => {
            db.createObjectStore("tab2_upgrade_store", { keyPath: "id" });
          },
        });

        const openRes = await openDatabase({ version: 2 });
        if (!openRes.ok) {
          return { ok: false, error: openRes.error.code, message: openRes.error.message };
        }
        const db = openRes.value;

        try {
          return {
            ok: true,
            version: db.version,
            stores: Array.from(db.objectStoreNames),
          };
        } finally {
          closeDatabase(db);
        }
      });

      expect(tab2UpgradeResult.ok).toBe(true);
      expect(tab2UpgradeResult.version).toBe(2);
      expect(tab2UpgradeResult.stores).toContain("tab2_upgrade_store");

      const tab1State = await tab1.evaluate(() => {
        return {
          versionchangeFired: !!(window as any).__tab1_versionchange_fired,
        };
      });
      expect(tab1State.versionchangeFired).toBe(true);

      await tab2.close();
    });

    test("Invariant: indexedDB.deleteDatabase is never called on migration errors or version mismatches", async ({
      page,
    }) => {
      await page.evaluate(() => {
        (window as any).__delete_database_calls = 0;
        const originalDelete = indexedDB.deleteDatabase.bind(indexedDB);
        indexedDB.deleteDatabase = function (name: string) {
          (window as any).__delete_database_calls++;
          return originalDelete(name);
        };
      });

      const operationsResult = await page.evaluate(async () => {
        const {
          openDatabase,
          closeDatabase,
          clearMigrationSteps,
          registerMigrationStep,
        } = window.__dayforge_storage_migrations;

        clearMigrationSteps();
        const v1Res = await openDatabase({ version: 1 });
        if (!v1Res.ok) throw new Error(v1Res.error.message);
        closeDatabase(v1Res.value);

        registerMigrationStep({
          fromVersion: 1,
          toVersion: 2,
          description: "Exploding migration step",
          upgrade: () => {
            throw new Error("Crash in upgrade");
          },
        });
        const failRes = await openDatabase({ version: 2 });

        const downgradeRes = await openDatabase({ version: 1 });

        return {
          failErrorCode: !failRes.ok ? failRes.error.code : null,
          downgradeOk: downgradeRes.ok,
          deleteCalls: (window as any).__delete_database_calls,
        };
      });

      expect(operationsResult.failErrorCode).toBe("migration_failed");
      expect(operationsResult.downgradeOk).toBe(true);
      expect(operationsResult.deleteCalls).toBe(0);
    });

    test("Sequential migration path v1 -> v2 -> v3 executes each step in order", async ({
      page,
    }) => {
      const testOwnerId = "44444444-4444-4444-8444-444444444444";

      const result = await page.evaluate(async (ownerId) => {
        const {
          openDatabase,
          closeDatabase,
          clearMigrationSteps,
          registerMigrationStep,
        } = window.__dayforge_storage_migrations;

        clearMigrationSteps();

        const v1Res = await openDatabase({ version: 1 });
        if (!v1Res.ok) throw new Error(v1Res.error.message);
        const v1Db = v1Res.value;

        await new Promise<void>((resolve, reject) => {
          const tx = v1Db.transaction(["records"], "readwrite");
          tx.objectStore("records").put({
            owner_id: ownerId,
            kind: "task",
            id: "task-multi-v",
            ciphertext: "multi-version-cipher",
            nonce: "nonce-multi",
            auth_tag: "tag-multi",
            key_id: "key-multi",
            record_version: 1,
            updated_at: "2026-10-31T15:00:00.000Z",
          });
          tx.oncomplete = () => resolve();
          tx.onerror = () => reject(tx.error);
        });
        closeDatabase(v1Db);

        const executionLog: string[] = [];

        registerMigrationStep({
          fromVersion: 1,
          toVersion: 2,
          description: "Step 1: add audit log store",
          upgrade: (db: IDBDatabase) => {
            executionLog.push("v1->v2");
            db.createObjectStore("audit_logs", { keyPath: "id" });
          },
        });

        registerMigrationStep({
          fromVersion: 2,
          toVersion: 3,
          description: "Step 2: add telemetry preferences store",
          upgrade: (db: IDBDatabase) => {
            executionLog.push("v2->v3");
            db.createObjectStore("telemetry_prefs", { keyPath: "key" });
          },
        });

        const v3Res = await openDatabase({ version: 3 });
        if (!v3Res.ok) throw new Error(v3Res.error.message);
        const v3Db = v3Res.value;

        try {
          const stores = Array.from(v3Db.objectStoreNames);
          const record = await new Promise<any>((resolve, reject) => {
            const tx = v3Db.transaction(["records"], "readonly");
            const req = tx.objectStore("records").get([ownerId, "task", "task-multi-v"]);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
          });

          return {
            ok: true,
            version: v3Db.version,
            stores,
            executionLog,
            recordCiphertext: record?.ciphertext,
          };
        } finally {
          closeDatabase(v3Db);
        }
      }, testOwnerId);

      expect(result.ok).toBe(true);
      expect(result.version).toBe(3);
      expect(result.executionLog).toEqual(["v1->v2", "v2->v3"]);
      expect(result.stores).toContain("audit_logs");
      expect(result.stores).toContain("telemetry_prefs");
      expect(result.recordCiphertext).toBe("multi-version-cipher");
    });
  });
});

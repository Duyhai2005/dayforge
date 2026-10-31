import { StorageError } from "./errors";
import { executeMigrations } from "./migration";

export const DB_NAME = "dayforge";
export const CURRENT_SCHEMA_VERSION = 1;

export const STORAGE_STORES = {
  owner_meta: "owner_meta",
  crypto_keys: "crypto_keys",
  device_meta: "device_meta",
  records: "records",
  operations: "operations",
  sync_meta: "sync_meta",
  view_preferences: "view_preferences",
  drafts: "drafts",
} as const;

export type StorageStoreName = (typeof STORAGE_STORES)[keyof typeof STORAGE_STORES];

export interface StoreIndexDefinition {
  name: string;
  keyPath: string | string[];
  unique?: boolean;
}

export interface StoreDefinition {
  name: StorageStoreName;
  keyPath: string | string[];
  indexes?: readonly StoreIndexDefinition[];
}

export const STORE_DEFINITIONS: readonly StoreDefinition[] = [
  {
    name: STORAGE_STORES.owner_meta,
    keyPath: "owner_id",
  },
  {
    name: STORAGE_STORES.crypto_keys,
    keyPath: ["owner_id", "key_id"],
  },
  {
    name: STORAGE_STORES.device_meta,
    keyPath: ["owner_id", "device_id"],
  },
  {
    name: STORAGE_STORES.records,
    keyPath: ["owner_id", "kind", "id"],
    indexes: [
      {
        name: "by_kind",
        keyPath: ["owner_id", "kind"],
        unique: false,
      },
    ],
  },
  {
    name: STORAGE_STORES.operations,
    keyPath: ["owner_id", "operation_id"],
    indexes: [
      {
        name: "by_device_sequence",
        keyPath: ["owner_id", "device_sequence"],
        unique: false,
      },
    ],
  },
  {
    name: STORAGE_STORES.sync_meta,
    keyPath: ["owner_id", "key"],
  },
  {
    name: STORAGE_STORES.view_preferences,
    keyPath: ["owner_id", "calendar"],
  },
  {
    name: STORAGE_STORES.drafts,
    keyPath: ["owner_id", "draft_id"],
  },
] as const;

export function upgradeDatabase(
  db: IDBDatabase,
  oldVersion: number,
  newVersion: number,
  transaction?: IDBTransaction | null
): void {
  if (newVersion < oldVersion) {
    throw new StorageError(
      "unsupported_version",
      `Cannot downgrade database from version ${oldVersion} to ${newVersion}`
    );
  }

  if (oldVersion < 1) {
    for (const def of STORE_DEFINITIONS) {
      const store = !db.objectStoreNames.contains(def.name)
        ? db.createObjectStore(def.name, { keyPath: def.keyPath })
        : null;

      if (store && def.indexes) {
        for (const idx of def.indexes) {
          if (!store.indexNames.contains(idx.name)) {
            store.createIndex(idx.name, idx.keyPath, {
              unique: idx.unique ?? false,
            });
          }
        }
      }
    }
  }

  if (newVersion > Math.max(1, oldVersion)) {
    if (!transaction) {
      throw new StorageError(
        "migration_failed",
        "IDBTransaction is required for schema migrations"
      );
    }
    executeMigrations(
      db,
      transaction,
      oldVersion,
      newVersion
    );
  }
}

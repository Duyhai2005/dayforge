import { registerMigrationStep } from "../migration";
import { STORAGE_STORES } from "../schema";

export function registerAuthStateMigration(): void {
  registerMigrationStep({
    fromVersion: 1,
    toVersion: 2,
    description: "Add pending authentication logout state",
    upgrade: (db) => {
      if (!db.objectStoreNames.contains(STORAGE_STORES.auth_state)) {
        db.createObjectStore(STORAGE_STORES.auth_state, { keyPath: "key" });
      }
    },
  });
}

registerAuthStateMigration();
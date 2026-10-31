import { StorageError, type StorageResult, storageErr, storageOk } from "./errors";
import { CURRENT_SCHEMA_VERSION } from "./schema";

export interface MigrationStep {
  fromVersion: number;
  toVersion: number;
  description: string;
  upgrade: (db: IDBDatabase, transaction: IDBTransaction) => void;
}

const migrationRegistry: MigrationStep[] = [];

export function registerMigrationStep(step: MigrationStep): void {
  if (step.fromVersion >= step.toVersion) {
    throw new StorageError(
      "invalid_data",
      `Invalid migration step: fromVersion (${step.fromVersion}) must be less than toVersion (${step.toVersion})`
    );
  }

  const existingIdx = migrationRegistry.findIndex(
    (s) => s.fromVersion === step.fromVersion && s.toVersion === step.toVersion
  );

  if (existingIdx >= 0) {
    migrationRegistry[existingIdx] = step;
  } else {
    migrationRegistry.push(step);
    migrationRegistry.sort((a, b) => a.fromVersion - b.fromVersion);
  }
}

export function clearMigrationSteps(): void {
  migrationRegistry.length = 0;
}

export function getRegisteredMigrationSteps(): readonly MigrationStep[] {
  return [...migrationRegistry];
}

export function getMaxSupportedVersion(): number {
  if (migrationRegistry.length === 0) {
    return CURRENT_SCHEMA_VERSION;
  }
  const maxRegistered = Math.max(...migrationRegistry.map((s) => s.toVersion));
  return Math.max(CURRENT_SCHEMA_VERSION, maxRegistered);
}

export function isVersionSupported(
  version: number,
  maxSupportedVersion?: number
): boolean {
  const max = maxSupportedVersion ?? getMaxSupportedVersion();
  return version <= max;
}

export function checkVersionCompatibility(
  version: number,
  maxSupportedVersion?: number
): StorageResult<void> {
  const max = maxSupportedVersion ?? getMaxSupportedVersion();
  if (version > max) {
    return storageErr(
      "unsupported_version",
      `Database version ${version} is higher than supported version ${max}`
    );
  }
  return storageOk(undefined);
}

export function executeMigrations(
  db: IDBDatabase,
  transaction: IDBTransaction,
  oldVersion: number,
  newVersion: number
): void {
  if (newVersion < oldVersion) {
    throw new StorageError(
      "unsupported_version",
      `Cannot downgrade database from version ${oldVersion} to ${newVersion}`
    );
  }

  if (oldVersion === newVersion) {
    return;
  }

  let current = Math.max(1, oldVersion);
  while (current < newVersion) {
    const nextStep = migrationRegistry.find(
      (s) => s.fromVersion === current && s.toVersion <= newVersion
    );

    if (!nextStep) {
      throw new StorageError(
        "migration_failed",
        `No migration step found to advance database from version ${current} to ${newVersion}`
      );
    }

    try {
      nextStep.upgrade(db, transaction);
    } catch (err) {
      if (err instanceof StorageError) {
        throw err;
      }
      throw new StorageError(
        "migration_failed",
        `Migration step from version ${nextStep.fromVersion} to ${nextStep.toVersion} failed (${nextStep.description}): ${
          err instanceof Error ? err.message : String(err)
        }`,
        err
      );
    }

    current = nextStep.toVersion;
  }
}

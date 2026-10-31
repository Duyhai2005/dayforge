import { type StorageResult, storageErr, storageOk } from "./errors";
import { CURRENT_SCHEMA_VERSION } from "./schema";

export function isVersionSupported(
  version: number,
  maxSupportedVersion: number = CURRENT_SCHEMA_VERSION
): boolean {
  return version <= maxSupportedVersion;
}

export function checkVersionCompatibility(
  version: number,
  maxSupportedVersion: number = CURRENT_SCHEMA_VERSION
): StorageResult<void> {
  if (version > maxSupportedVersion) {
    return storageErr(
      "unsupported_version",
      `Database version ${version} is higher than supported version ${maxSupportedVersion}`
    );
  }
  return storageOk(undefined);
}

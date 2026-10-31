import { StorageError, type StorageResult, storageErr, storageOk } from "./errors";
import { STORAGE_STORES } from "./schema";

export interface EncryptedRecord {
  owner_id: string;
  store: string;
  record_id: string;
  key_id: string;
  iv: Uint8Array;
  ciphertext: Uint8Array;
}

export interface StoredCryptoKeyRecord {
  owner_id: string;
  key_id: string;
  key: CryptoKey;
  created_at?: string;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

function getSubtleCrypto(): SubtleCrypto {
  const c =
    typeof crypto !== "undefined"
      ? crypto
      : (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (!c || !c.subtle) {
    throw new StorageError(
      "unavailable",
      "Web Crypto API (subtle) is not available in current environment"
    );
  }
  return c.subtle;
}

function getRandomValues(array: Uint8Array): Uint8Array {
  const c =
    typeof crypto !== "undefined"
      ? crypto
      : (globalThis as unknown as { crypto?: Crypto }).crypto;
  if (!c || !c.getRandomValues) {
    throw new StorageError(
      "unavailable",
      "CSPRNG (crypto.getRandomValues) is not available in current environment"
    );
  }
  return c.getRandomValues(array);
}

function escapeAadPart(part: string): string {
  return part.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

export function createAad(
  ownerId: string,
  keyId: string,
  store: string,
  recordId: string
): Uint8Array {
  const canonical = `${escapeAadPart(ownerId)}:${escapeAadPart(keyId)}:${escapeAadPart(store)}:${escapeAadPart(recordId)}`;
  return textEncoder.encode(canonical);
}

export async function generateTestKey(): Promise<CryptoKey> {
  const subtle = getSubtleCrypto();
  return await subtle.generateKey(
    {
      name: "AES-GCM",
      length: 256,
    },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function importRawKey(rawBytes: Uint8Array): Promise<CryptoKey> {
  if (rawBytes.byteLength !== 32) {
    throw new StorageError(
      "invalid_data",
      `Invalid key length: expected 32 bytes (256 bits), got ${rawBytes.byteLength} bytes`
    );
  }
  const subtle = getSubtleCrypto();
  return await subtle.importKey(
    "raw",
    rawBytes as unknown as BufferSource,
    {
      name: "AES-GCM",
    },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptPayload<T>(
  key: CryptoKey,
  ownerId: string,
  keyId: string,
  store: string,
  recordId: string,
  payload: T
): Promise<StorageResult<EncryptedRecord>> {
  let jsonString: string;
  try {
    const serialized = JSON.stringify(payload);
    jsonString = serialized === undefined ? "null" : serialized;
  } catch (err) {
    return storageErr("invalid_data", "Failed to serialize payload to JSON", err);
  }

  const plaintextBytes = textEncoder.encode(jsonString);
  const iv = getRandomValues(new Uint8Array(12));
  const aad = createAad(ownerId, keyId, store, recordId);

  try {
    const subtle = getSubtleCrypto();
    const encryptedBuffer = await subtle.encrypt(
      {
        name: "AES-GCM",
        iv: iv as unknown as BufferSource,
        additionalData: aad as unknown as BufferSource,
        tagLength: 128,
      },
      key,
      plaintextBytes as unknown as BufferSource
    );

    const record: EncryptedRecord = {
      owner_id: ownerId,
      store,
      record_id: recordId,
      key_id: keyId,
      iv,
      ciphertext: new Uint8Array(encryptedBuffer),
    };
    return storageOk(record);
  } catch (err) {
    return storageErr("unavailable", "Encryption operation failed", err);
  }
}

export async function decryptPayload<T>(
  key: CryptoKey,
  record: EncryptedRecord,
  expectedOwnerId: string,
  expectedStore: string,
  expectedRecordId: string
): Promise<StorageResult<T>> {
  // Fail closed if record metadata doesn't match expected context
  if (
    record.owner_id !== expectedOwnerId ||
    record.store !== expectedStore ||
    record.record_id !== expectedRecordId
  ) {
    return storageErr(
      "integrity_failed",
      "Failed to decrypt or authenticate record: context mismatch"
    );
  }

  const aad = createAad(
    expectedOwnerId,
    record.key_id,
    expectedStore,
    expectedRecordId
  );

  let decryptedBuffer: ArrayBuffer;
  try {
    const subtle = getSubtleCrypto();
    decryptedBuffer = await subtle.decrypt(
      {
        name: "AES-GCM",
        iv: record.iv as unknown as BufferSource,
        additionalData: aad as unknown as BufferSource,
        tagLength: 128,
      },
      key,
      record.ciphertext as unknown as BufferSource
    );
  } catch (err) {
    return storageErr(
      "integrity_failed",
      "Failed to decrypt or authenticate record",
      err
    );
  }

  try {
    const jsonString = textDecoder.decode(decryptedBuffer);
    const parsed = JSON.parse(jsonString) as T;
    return storageOk(parsed);
  } catch (err) {
    return storageErr(
      "integrity_failed",
      "Failed to decrypt or authenticate record: payload corrupted",
      err
    );
  }
}

export async function storeCryptoKey(
  db: IDBDatabase,
  ownerId: string,
  keyId: string,
  key: CryptoKey
): Promise<StorageResult<void>> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORAGE_STORES.crypto_keys, "readwrite");
      const store = tx.objectStore(STORAGE_STORES.crypto_keys);
      const req = store.put({
        owner_id: ownerId,
        key_id: keyId,
        key,
        created_at: new Date().toISOString(),
      });

      tx.oncomplete = () => resolve(storageOk(undefined));
      req.onerror = () => {
        resolve(
          storageErr(
            "transaction_aborted",
            req.error?.message ?? "Failed to store crypto key",
            req.error
          )
        );
      };
      tx.onabort = () => {
        resolve(
          storageErr(
            "transaction_aborted",
            tx.error?.message ?? "Transaction aborted while storing crypto key",
            tx.error
          )
        );
      };
    } catch (err) {
      resolve(
        storageErr(
          "unavailable",
          err instanceof Error ? err.message : "Error accessing crypto_keys store",
          err
        )
      );
    }
  });
}

export async function getCryptoKey(
  db: IDBDatabase,
  ownerId: string,
  keyId: string
): Promise<StorageResult<CryptoKey>> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORAGE_STORES.crypto_keys, "readonly");
      const store = tx.objectStore(STORAGE_STORES.crypto_keys);
      const req = store.get([ownerId, keyId]);

      req.onsuccess = () => {
        const record = req.result as StoredCryptoKeyRecord | undefined;
        if (!record || !record.key) {
          resolve(
            storageErr(
              "unavailable",
              `Crypto key not found for owner '${ownerId}' and keyId '${keyId}'`
            )
          );
          return;
        }
        resolve(storageOk(record.key));
      };
      req.onerror = () => {
        resolve(
          storageErr(
            "unavailable",
            req.error?.message ?? "Failed to retrieve crypto key",
            req.error
          )
        );
      };
      tx.onabort = () => {
        resolve(
          storageErr(
            "transaction_aborted",
            tx.error?.message ?? "Transaction aborted while reading crypto key",
            tx.error
          )
        );
      };
    } catch (err) {
      resolve(
        storageErr(
          "unavailable",
          err instanceof Error ? err.message : "Error accessing crypto_keys store",
          err
        )
      );
    }
  });
}

export async function removeCryptoKey(
  db: IDBDatabase,
  ownerId: string,
  keyId: string
): Promise<StorageResult<void>> {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORAGE_STORES.crypto_keys, "readwrite");
      const store = tx.objectStore(STORAGE_STORES.crypto_keys);
      const req = store.delete([ownerId, keyId]);

      tx.oncomplete = () => resolve(storageOk(undefined));
      req.onerror = () => {
        resolve(
          storageErr(
            "transaction_aborted",
            req.error?.message ?? "Failed to delete crypto key",
            req.error
          )
        );
      };
      tx.onabort = () => {
        resolve(
          storageErr(
            "transaction_aborted",
            tx.error?.message ?? "Transaction aborted while deleting crypto key",
            tx.error
          )
        );
      };
    } catch (err) {
      resolve(
        storageErr(
          "unavailable",
          err instanceof Error ? err.message : "Error accessing crypto_keys store",
          err
        )
      );
    }
  });
}

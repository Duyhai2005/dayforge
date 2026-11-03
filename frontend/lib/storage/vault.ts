import { canonicalizeJson, type EditTime, type UUID } from "../sync/protocol";

export const DATABASE_NAME = "dayforge-local";
export const DATABASE_VERSION = 2;
const VAULT_CRYPTO_VERSION = 1;

export const OWNER_STORES = ["owner_meta", "auth_state", "outbox", "shadow", "projection", "diagnostics", "drafts", "journal", "staging", "leases"] as const;
export type OwnerStore = typeof OWNER_STORES[number];
export type EncryptedStore = Exclude<OwnerStore, "owner_meta" | "auth_state" | "leases">;

export interface BuildGate {
  key: "build_gate";
  approved_build: string;
  target_build: string | null;
  update_epoch: UUID | null;
  phase: "running" | "preparing" | "switching";
  schema_version: number;
  target_schema_version: number | null;
  revision: number;
}

export interface OwnerMeta {
  owner_id: UUID;
  local_state_revision: number;
  lock_epoch: number;
  sync_generation: number;
  server_epoch: UUID | null;
  pull_cursor: string;
  device_id: UUID;
  device_sequence: string;
  local_hlc?: Pick<EditTime, "physical_ms" | "logical"> | null;
  observed_hlc: Pick<EditTime, "physical_ms" | "logical"> | null;
  clock_calibration?: {
    calibration_id: UUID;
    server_time_ms: number;
    raw_wall_at_receive_ms: number;
    monotonic_at_receive_ms: number;
    offset_ms: number;
    round_trip_ms: number;
    calibrated_at_wall_ms: number;
  } | null;
  key_id: UUID;
}

export interface OwnerAuthState {
  owner_id: UUID;
  locked: boolean;
  lock_epoch: number;
  crypto_key: CryptoKey | null;
  logout_ticket: string | null;
}

export interface LeaseRecord {
  owner_id: UUID;
  holder_id: string;
  fencing_token: number;
  expires_at_ms: number;
}

export interface EncryptedOwnerRow {
  id: string;
  owner_id: UUID;
  record_id: string;
  key_id: UUID;
  iv: ArrayBuffer;
  ciphertext: ArrayBuffer;
  [metadata: string]: unknown;
}

export interface EncryptedWrite {
  store: EncryptedStore;
  row: EncryptedOwnerRow;
}

export interface OwnerCommitGuard {
  owner_id: UUID;
  expected_revision: number;
  expected_lock_epoch: number;
  expected_generation: number;
  expected_server_epoch: UUID | null;
  expected_cursor: string;
  expected_build: string;
  expected_gate_revision: number;
  expected_fencing_token?: number;
  updater?: { target_build: string; update_epoch: UUID };
}

export type OwnerCommitResult =
  | { committed: true; revision: number }
  | { committed: false; reason: "stale_snapshot" | "locked" | "build_gate" | "fence" };

export interface OwnerSnapshot {
  metadata: OwnerMeta;
  auth: OwnerAuthState;
  outbox: EncryptedOwnerRow[];
  shadow: EncryptedOwnerRow[];
  projection: EncryptedOwnerRow[];
  diagnostics: EncryptedOwnerRow[];
  drafts: EncryptedOwnerRow[];
  journal: EncryptedOwnerRow[];
}

function requestValue<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB transaction failed"));
  });
}

function assertUuid(value: unknown, label: string): asserts value is UUID {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) {
    throw new Error(`${label} is not a supported lowercase UUID`);
  }
}

function assertOwnerMeta(value: unknown): asserts value is OwnerMeta {
  if (!value || typeof value !== "object") throw new Error("Owner metadata is missing or invalid");
  const meta = value as Partial<OwnerMeta>;
  const isCounter = (counter: unknown) => Number.isSafeInteger(counter) && (counter as number) >= 0;
  const isDecimal = (decimal: unknown) => typeof decimal === "string" && decimal.length <= 20 && /^(0|[1-9][0-9]*)$/.test(decimal) && BigInt(decimal) <= BigInt("18446744073709551615");
  assertUuid(meta.owner_id, "owner_id");
  assertUuid(meta.device_id, "device_id");
  assertUuid(meta.key_id, "key_id");
  if (!isCounter(meta.local_state_revision) || (meta.local_state_revision as number) < 1 ||
      !isCounter(meta.lock_epoch) || !isCounter(meta.sync_generation) || !isDecimal(meta.device_sequence) ||
      !isDecimal(meta.pull_cursor) ||
      !(meta.server_epoch === null || (typeof meta.server_epoch === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(meta.server_epoch))) ||
      !(meta.observed_hlc === null || (typeof meta.observed_hlc === "object" &&
        isCounter((meta.observed_hlc as OwnerMeta["observed_hlc"])?.physical_ms) &&
        isCounter((meta.observed_hlc as OwnerMeta["observed_hlc"])?.logical) &&
        ((meta.observed_hlc as OwnerMeta["observed_hlc"])?.logical ?? 0) <= 4_294_967_295)) ||
      !(meta.local_hlc === undefined || meta.local_hlc === null || (typeof meta.local_hlc === "object" &&
        isCounter((meta.local_hlc as OwnerMeta["local_hlc"])?.physical_ms) &&
        isCounter((meta.local_hlc as OwnerMeta["local_hlc"])?.logical) &&
        ((meta.local_hlc as OwnerMeta["local_hlc"])?.logical ?? 0) <= 4_294_967_295))) {
    throw new Error("Owner metadata fields are invalid");
  }
  if (meta.clock_calibration !== undefined && meta.clock_calibration !== null) {
    const calibration = meta.clock_calibration;
    assertUuid(calibration.calibration_id, "clock_calibration.calibration_id");
    if (!isCounter(calibration.server_time_ms) || !isCounter(calibration.raw_wall_at_receive_ms) ||
        !Number.isFinite(calibration.monotonic_at_receive_ms) || calibration.monotonic_at_receive_ms < 0 ||
        !Number.isFinite(calibration.offset_ms) || !Number.isFinite(calibration.round_trip_ms) || calibration.round_trip_ms < 0 ||
        !isCounter(calibration.calibrated_at_wall_ms)) {
      throw new Error("Owner clock calibration is invalid");
    }
  }
  if (meta.server_epoch === null && meta.pull_cursor !== "0") {
    throw new Error("Owner cursor cannot be nonzero before an epoch is established");
  }
}

function assertOwnerAuth(value: unknown, ownerId: UUID): asserts value is OwnerAuthState {
  if (!value || typeof value !== "object") throw new Error("Owner auth state is missing or invalid");
  const auth = value as Partial<OwnerAuthState>;
  if (auth.owner_id !== ownerId || typeof auth.locked !== "boolean" ||
      !Number.isSafeInteger(auth.lock_epoch) || (auth.lock_epoch as number) < 0 ||
      !(auth.logout_ticket === null || (typeof auth.logout_ticket === "string" && /^[A-Za-z0-9_-]{64}$/.test(auth.logout_ticket)))) {
    throw new Error("Owner auth state fields are invalid");
  }
  if (auth.locked) {
    if (auth.crypto_key !== null) throw new Error("Locked owner auth state must not retain a CryptoKey");
    return;
  }
  const key = auth.crypto_key as CryptoKey | null | undefined;
  if (!key || typeof key !== "object" || key.type !== "secret" || key.algorithm?.name !== "AES-GCM" ||
      key.extractable || !key.usages.includes("encrypt") || !key.usages.includes("decrypt")) {
    throw new Error("Unlocked owner auth state does not contain the required non-extractable vault key");
  }
}

export function assertBuildGate(value: unknown): asserts value is BuildGate {
  if (!value || typeof value !== "object") throw new Error("Build gate metadata is missing or invalid");
  const gate = value as Partial<BuildGate>;
  if (gate.key !== "build_gate" || typeof gate.approved_build !== "string" || !gate.approved_build ||
      !(gate.target_build === null || typeof gate.target_build === "string") ||
      !(gate.update_epoch === null || (typeof gate.update_epoch === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(gate.update_epoch))) ||
      !["running", "preparing", "switching"].includes(String(gate.phase)) ||
      !Number.isSafeInteger(gate.schema_version) || (gate.schema_version as number) < 1 ||
      !(gate.target_schema_version === undefined || gate.target_schema_version === null ||
        (Number.isSafeInteger(gate.target_schema_version) && (gate.target_schema_version as number) >= 1)) ||
      !Number.isSafeInteger(gate.revision) || (gate.revision as number) < 1) {
    throw new Error("Build gate metadata is invalid");
  }
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(gate.approved_build) ||
      (gate.target_build !== null && !/^[A-Za-z0-9._-]{1,128}$/.test(gate.target_build))) {
    throw new Error("Build gate contains an invalid build id");
  }
  const targetSchemaVersion = gate.target_schema_version ?? null;
  const currentSchemaVersion = gate.schema_version as number;
  if ((gate.phase === "running") !== (gate.target_build === null && gate.update_epoch === null && targetSchemaVersion === null)) {
    throw new Error("Build gate phase and target metadata disagree");
  }
  if (gate.phase !== "running" && (!gate.target_build || !gate.update_epoch || targetSchemaVersion === null || targetSchemaVersion < currentSchemaVersion)) {
    throw new Error("Active build update is missing a target or epoch");
  }
}

function createOwnerStore(database: IDBDatabase, name: OwnerStore, indexes: readonly string[] = []): void {
  const store = database.createObjectStore(name, { keyPath: name === "owner_meta" || name === "auth_state" || name === "leases" ? "owner_id" : "id" });
  if (name !== "owner_meta" && name !== "auth_state" && name !== "leases") {
    store.createIndex("by-owner", "owner_id", { unique: false });
  }
  if (name === "outbox") {
    store.createIndex("by-owner-state", ["owner_id", "state"], { unique: false });
  }
  for (const index of indexes) store.createIndex(index, index, { unique: false });
}

export function openVaultDatabase(expectedBuildId?: string): Promise<IDBDatabase> {
  if (typeof indexedDB === "undefined") return Promise.reject(new Error("IndexedDB is unavailable in this context"));
  return new Promise((resolve, reject) => {
    let migrationFailure: Error | null = null;
    let settled = false;
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const transaction = request.transaction;
      if (!transaction) {
        migrationFailure = new Error("Vault schema upgrade has no transaction");
        return;
      }
      const oldVersion = event.oldVersion;
      if (oldVersion === 0) {
        if (!database.objectStoreNames.contains("build_gate")) database.createObjectStore("build_gate", { keyPath: "key" });
        if (!database.objectStoreNames.contains("owner_meta")) createOwnerStore(database, "owner_meta");
        if (!database.objectStoreNames.contains("auth_state")) createOwnerStore(database, "auth_state");
        if (!database.objectStoreNames.contains("outbox")) createOwnerStore(database, "outbox");
        if (!database.objectStoreNames.contains("shadow")) createOwnerStore(database, "shadow");
        if (!database.objectStoreNames.contains("projection")) createOwnerStore(database, "projection");
        if (!database.objectStoreNames.contains("diagnostics")) createOwnerStore(database, "diagnostics");
        if (!database.objectStoreNames.contains("drafts")) createOwnerStore(database, "drafts");
        if (!database.objectStoreNames.contains("journal")) createOwnerStore(database, "journal");
        if (!database.objectStoreNames.contains("staging")) createOwnerStore(database, "staging");
        if (!database.objectStoreNames.contains("leases")) createOwnerStore(database, "leases");
        const diagnostics = transaction.objectStore("diagnostics");
        if (!diagnostics.indexNames.contains("by-owner-superseded")) {
          diagnostics.createIndex("by-owner-superseded", ["owner_id", "superseded_by"], { unique: false });
        }
        return;
      }
      if (oldVersion !== 1 || expectedBuildId === undefined || !database.objectStoreNames.contains("build_gate") ||
          !database.objectStoreNames.contains("diagnostics")) {
        migrationFailure = new Error("Vault schema migration requires the approved update coordinator");
        transaction.abort();
        return;
      }
      const gateStore = transaction.objectStore("build_gate");
      const gateRequest = gateStore.get("build_gate");
      gateRequest.onsuccess = () => {
        const gate = gateRequest.result as BuildGate | undefined;
        try {
          if (!gate) throw new Error("Build gate is missing during schema migration");
          assertBuildGate(gate);
          if (gate.revision >= Number.MAX_SAFE_INTEGER) throw new Error("Build gate revision is exhausted");
          if (gate.phase !== "switching" || gate.target_build !== expectedBuildId ||
              gate.target_schema_version !== DATABASE_VERSION || !gate.update_epoch) {
            throw new Error("Vault schema migration is not authorized for this build and update epoch");
          }
          const diagnostics = transaction.objectStore("diagnostics");
          if (!diagnostics.indexNames.contains("by-owner-superseded")) {
            diagnostics.createIndex("by-owner-superseded", ["owner_id", "superseded_by"], { unique: false });
          }
          gateStore.put({ ...gate, schema_version: DATABASE_VERSION, revision: gate.revision + 1 });
        } catch (error) {
          migrationFailure = error instanceof Error ? error : new Error("Vault schema migration authorization failed");
          transaction.abort();
        }
      };
      gateRequest.onerror = () => {
        migrationFailure = new Error("Unable to verify the build gate for vault migration");
        transaction.abort();
      };
    };
    request.onblocked = () => rejectOnce(new Error("Vault schema update is blocked by another open tab. Close or reload older tabs, then retry."));
    request.onerror = () => rejectOnce(migrationFailure ?? request.error ?? new Error("Unable to open the local vault"));
    request.onsuccess = () => {
      const database = request.result;
      if (settled) {
        database.close();
        return;
      }
      if (database.version !== DATABASE_VERSION) {
        database.close();
        rejectOnce(new Error("Local vault schema needs an approved updater"));
        return;
      }
      database.onversionchange = () => database.close();
      settled = true;
      resolve(database);
    };
  });
}

export async function initializeBuildGate(database: IDBDatabase, buildId: string, schemaVersion = DATABASE_VERSION): Promise<BuildGate> {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(buildId) || !Number.isSafeInteger(schemaVersion) || schemaVersion < 1) throw new Error("Invalid build gate initializer");
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["build_gate"], "readwrite", { durability: "strict" });
    const store = transaction.objectStore("build_gate");
    let result: BuildGate | undefined;
    const request = store.get("build_gate");
    request.onsuccess = () => {
      const existing = request.result as BuildGate | undefined;
      if (existing) {
        try {
          assertBuildGate(existing);
          result = existing;
        } catch (error) {
          transaction.abort();
          reject(error instanceof Error ? error : new Error("Stored build gate is invalid"));
        }
        return;
      }
      result = {
        key: "build_gate",
        approved_build: buildId,
        target_build: null,
        update_epoch: null,
        phase: "running",
        schema_version: schemaVersion,
        target_schema_version: null,
        revision: 1,
      };
      store.add(result);
    };
    transaction.oncomplete = () => result ? resolve(result) : reject(new Error("Build gate was not initialized"));
    transaction.onabort = () => reject(transaction.error ?? new Error("Build gate initialization aborted"));
    transaction.onerror = () => reject(transaction.error ?? new Error("Build gate initialization failed"));
  });
}

export async function readBuildGate(database: IDBDatabase): Promise<BuildGate | undefined> {
  const transaction = database.transaction(["build_gate"], "readonly");
  const done = transactionDone(transaction);
  const value = await requestValue(transaction.objectStore("build_gate").get("build_gate")) as BuildGate | undefined;
  await done;
  if (value) assertBuildGate(value);
  return value;
}

async function changeBuildGate(
  database: IDBDatabase,
  expectedRevision: number,
  transform: (gate: BuildGate) => BuildGate,
): Promise<BuildGate | null> {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["build_gate"], "readwrite", { durability: "strict" });
    const store = transaction.objectStore("build_gate");
    let result: BuildGate | null = null;
    let conflict = false;
    let failure: Error | null = null;
    const request = store.get("build_gate");
    request.onsuccess = () => {
      const current = request.result as BuildGate | undefined;
      try {
        if (current) assertBuildGate(current);
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Stored build gate is invalid");
        transaction.abort();
        return;
      }
      if (!current || current.revision !== expectedRevision) {
        conflict = true;
        transaction.abort();
        return;
      }
      try {
        const next = { ...transform(current), revision: current.revision + 1 };
        assertBuildGate(next);
        result = next;
        store.put(next);
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Build gate update failed");
        transaction.abort();
      }
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => conflict ? resolve(null) : reject(failure ?? transaction.error ?? new Error("Build gate update aborted"));
    transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("Build gate update failed"));
  });
}

export async function beginBuildUpdate(
  database: IDBDatabase,
  expectedRevision: number,
  fromBuild: string,
  targetBuild: string,
  targetSchemaVersion: number,
): Promise<BuildGate | null> {
  if (!targetBuild || targetBuild === fromBuild || !Number.isSafeInteger(targetSchemaVersion) || targetSchemaVersion < 1) {
    throw new Error("Target build and schema must be valid and differ from the approved build");
  }
  return changeBuildGate(database, expectedRevision, (gate) => {
    if (gate.phase !== "running" || gate.approved_build !== fromBuild) throw new Error("Build gate is not in the expected running state");
    if (targetSchemaVersion < gate.schema_version) throw new Error("Vault schema downgrade is not supported");
    return { ...gate, target_build: targetBuild, target_schema_version: targetSchemaVersion, update_epoch: crypto.randomUUID(), phase: "preparing" };
  });
}

export async function switchBuildUpdate(database: IDBDatabase, expectedRevision: number, updateEpoch: UUID): Promise<BuildGate | null> {
  return changeBuildGate(database, expectedRevision, (gate) => {
    if (gate.phase !== "preparing" || gate.update_epoch !== updateEpoch || !gate.target_build) throw new Error("Build update is not prepared for this epoch");
    return { ...gate, phase: "switching" };
  });
}

export async function approveBuildUpdate(database: IDBDatabase, expectedRevision: number, updateEpoch: UUID): Promise<BuildGate | null> {
  return changeBuildGate(database, expectedRevision, (gate) => {
    if (gate.phase !== "switching" || gate.update_epoch !== updateEpoch || !gate.target_build) throw new Error("Build update is not switching for this epoch");
    return {
      ...gate,
      approved_build: gate.target_build,
      schema_version: gate.target_schema_version!,
      target_build: null,
      target_schema_version: null,
      update_epoch: null,
      phase: "running",
    };
  });
}

export async function cancelPreparedBuildUpdate(database: IDBDatabase, expectedRevision: number, updateEpoch: UUID): Promise<BuildGate | null> {
  return changeBuildGate(database, expectedRevision, (gate) => {
    if (gate.phase !== "preparing" || gate.update_epoch !== updateEpoch) throw new Error("Only a matching preparation can be cancelled");
    return { ...gate, target_build: null, target_schema_version: null, update_epoch: null, phase: "running" };
  });
}

export async function initializeOwnerMetadata(database: IDBDatabase, input: {
  owner_id: UUID;
  device_id: UUID;
  key_id: UUID;
  build_id: string;
}): Promise<OwnerMeta> {
  assertUuid(input.owner_id, "owner_id");
  assertUuid(input.device_id, "device_id");
  assertUuid(input.key_id, "key_id");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.build_id)) throw new Error("Build id is invalid");
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["build_gate", "owner_meta", "auth_state"], "readwrite", { durability: "strict" });
    const gateRequest = transaction.objectStore("build_gate").get("build_gate");
    const metadataStore = transaction.objectStore("owner_meta");
    const authStore = transaction.objectStore("auth_state");
    const metadataRequest = metadataStore.get(input.owner_id);
    const authRequest = authStore.get(input.owner_id);
    let remaining = 3;
    let gate: BuildGate | undefined;
    let currentMetadata: OwnerMeta | undefined;
    let currentAuth: OwnerAuthState | undefined;
    let result: OwnerMeta | undefined;
    let failure: Error | null = null;
    const onRead = () => {
      if (--remaining !== 0) return;
      try {
        if (!gate) throw new Error("Build gate is unavailable");
        assertBuildGate(gate);
        if (gate.phase !== "running" || gate.approved_build !== input.build_id) {
          throw new Error("Current build is not approved to initialize owner metadata");
        }
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Build gate is invalid");
        transaction.abort();
        return;
      }
      if (currentMetadata && currentAuth) {
        try {
          assertOwnerMeta(currentMetadata);
          assertOwnerAuth(currentAuth, input.owner_id);
          if (currentAuth.lock_epoch !== currentMetadata.lock_epoch) throw new Error("Owner metadata and auth lock epochs disagree");
        } catch (error) {
          failure = error instanceof Error ? error : new Error("Owner metadata is invalid");
          transaction.abort();
          return;
        }
        result = currentMetadata;
        return;
      }
      if (currentMetadata || currentAuth) {
        failure = new Error("Owner metadata and auth state are inconsistent");
        transaction.abort();
        return;
      }
      result = {
        owner_id: input.owner_id,
        local_state_revision: 1,
        lock_epoch: 0,
        sync_generation: 0,
        server_epoch: null,
        pull_cursor: "0",
        device_id: input.device_id,
        device_sequence: "0",
        local_hlc: null,
        observed_hlc: null,
        clock_calibration: null,
        key_id: input.key_id,
      };
      metadataStore.add(result);
      authStore.add({ owner_id: input.owner_id, locked: true, lock_epoch: 0, crypto_key: null, logout_ticket: null } satisfies OwnerAuthState);
    };
    gateRequest.onsuccess = () => { gate = gateRequest.result as BuildGate | undefined; onRead(); };
    metadataRequest.onsuccess = () => { currentMetadata = metadataRequest.result as OwnerMeta | undefined; onRead(); };
    authRequest.onsuccess = () => { currentAuth = authRequest.result as OwnerAuthState | undefined; onRead(); };
    metadataRequest.onerror = () => { failure = metadataRequest.error ?? new Error("Unable to read owner metadata"); transaction.abort(); };
    authRequest.onerror = () => { failure = authRequest.error ?? new Error("Unable to read owner auth state"); transaction.abort(); };
    gateRequest.onerror = () => { failure = gateRequest.error ?? new Error("Unable to read build gate"); transaction.abort(); };
    transaction.oncomplete = () => result ? resolve(result) : reject(new Error("Owner metadata was not initialized"));
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Owner metadata initialization aborted"));
    transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("Owner metadata initialization failed"));
  });
}

export async function listOwnerMetadata(database: IDBDatabase): Promise<OwnerMeta[]> {
  const transaction = database.transaction(["owner_meta"], "readonly");
  const rows = await requestValue(transaction.objectStore("owner_meta").getAll()) as OwnerMeta[];
  await transactionDone(transaction);
  rows.forEach(assertOwnerMeta);
  return rows;
}

export async function readOwnerAuthState(database: IDBDatabase, ownerId: UUID): Promise<OwnerAuthState | undefined> {
  const transaction = database.transaction(["auth_state"], "readonly");
  const value = await requestValue(transaction.objectStore("auth_state").get(ownerId)) as OwnerAuthState | undefined;
  await transactionDone(transaction);
  if (value) assertOwnerAuth(value, ownerId);
  return value;
}

export async function clearLogoutTicket(database: IDBDatabase, ownerId: UUID, expectedTicket: string): Promise<boolean> {
  if (!/^[A-Za-z0-9_-]{64}$/.test(expectedTicket)) throw new Error("Logout ticket is invalid");
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["auth_state"], "readwrite", { durability: "strict" });
    const store = transaction.objectStore("auth_state");
    const request = store.get(ownerId);
    let result = false;
    let failure: Error | null = null;
    request.onsuccess = () => {
      const auth = request.result as OwnerAuthState | undefined;
      if (!auth) return;
      try { assertOwnerAuth(auth, ownerId); } catch (error) {
        failure = error instanceof Error ? error : new Error("Owner auth state is invalid");
        transaction.abort();
        return;
      }
      if (auth.locked && auth.logout_ticket === expectedTicket) {
        store.put({ ...auth, logout_ticket: null } satisfies OwnerAuthState);
        result = true;
      }
    };
    request.onerror = () => { failure = request.error ?? new Error("Unable to read logout ticket"); transaction.abort(); };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Unable to clear logout ticket"));
    transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("Unable to clear logout ticket"));
  });
}

export async function unlockOwner(database: IDBDatabase, input: {
  owner_id: UUID;
  key_id: UUID;
  rawKey: Uint8Array;
  buildId: string;
}): Promise<{ lockEpoch: number; key: CryptoKey }> {
  assertUuid(input.owner_id, "owner_id");
  assertUuid(input.key_id, "key_id");
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(input.buildId)) throw new Error("Build id is invalid");
  if (input.rawKey.byteLength !== 32) throw new Error("Owner vault key must be 256 bits");
  const rawKey = new Uint8Array(input.rawKey);
  let key: CryptoKey;
  try {
    key = await crypto.subtle.importKey("raw", rawKey.buffer as ArrayBuffer, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  } finally {
    rawKey.fill(0);
    input.rawKey.fill(0);
  }
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(["build_gate", "owner_meta", "auth_state"], "readwrite", { durability: "strict" });
    const gateRequest = transaction.objectStore("build_gate").get("build_gate");
    const metaRequest = transaction.objectStore("owner_meta").get(input.owner_id);
    const authRequest = transaction.objectStore("auth_state").get(input.owner_id);
    let gate: BuildGate | undefined;
    let metadata: OwnerMeta | undefined;
    let auth: OwnerAuthState | undefined;
    let remaining = 3;
    let failure: Error | null = null;
    const onRead = () => {
      if (--remaining !== 0) return;
      try {
        if (gate) assertBuildGate(gate);
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Build gate is invalid");
        transaction.abort();
        return;
      }
      if (!gate || gate.phase !== "running" || gate.approved_build !== input.buildId) {
        failure = new Error("Current build is not approved to unlock the owner vault");
        transaction.abort();
        return;
      }
      if (!metadata || metadata.key_id !== input.key_id) {
        failure = new Error("Local key id does not match the owner vault metadata");
        transaction.abort();
        return;
      }
      try {
        assertOwnerMeta(metadata);
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Owner metadata is invalid");
        transaction.abort();
        return;
      }
      if (!auth || auth.lock_epoch !== metadata.lock_epoch) {
        failure = new Error("Owner auth state is unavailable or has a stale lock epoch");
        transaction.abort();
        return;
      }
      try {
        assertOwnerAuth(auth, input.owner_id);
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Owner auth state is invalid");
        transaction.abort();
        return;
      }
      transaction.objectStore("auth_state").put({
        owner_id: input.owner_id,
        locked: false,
        lock_epoch: metadata.lock_epoch,
        crypto_key: key,
        logout_ticket: null,
      } satisfies OwnerAuthState);
    };
    gateRequest.onsuccess = () => { gate = gateRequest.result as BuildGate | undefined; onRead(); };
    metaRequest.onsuccess = () => { metadata = metaRequest.result as OwnerMeta | undefined; onRead(); };
    authRequest.onsuccess = () => { auth = authRequest.result as OwnerAuthState | undefined; onRead(); };
    gateRequest.onerror = () => { failure = gateRequest.error ?? new Error("Unable to read build gate"); transaction.abort(); };
    metaRequest.onerror = () => { failure = metaRequest.error ?? new Error("Unable to read owner metadata"); transaction.abort(); };
    authRequest.onerror = () => { failure = authRequest.error ?? new Error("Unable to read owner auth state"); transaction.abort(); };
    transaction.oncomplete = () => metadata ? resolve({ lockEpoch: metadata.lock_epoch, key }) : reject(new Error("Owner metadata is unavailable"));
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Owner unlock aborted"));
    transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("Owner unlock failed"));
  });
}

export async function lockOwner(database: IDBDatabase, ownerId: UUID, logoutTicket: string | null): Promise<number> {
  assertUuid(ownerId, "owner_id");
  if (logoutTicket !== null && !/^[A-Za-z0-9_-]{64}$/.test(logoutTicket)) throw new Error("Logout ticket is invalid");
  const lockEpoch = await new Promise<number>((resolve, reject) => {
    const transaction = database.transaction(["owner_meta", "auth_state"], "readwrite", { durability: "strict" });
    const metaStore = transaction.objectStore("owner_meta");
    const authStore = transaction.objectStore("auth_state");
    const metadataRequest = metaStore.get(ownerId);
    const authRequest = authStore.get(ownerId);
    let metadata: OwnerMeta | undefined;
    let auth: OwnerAuthState | undefined;
    let remaining = 2;
    let result: number | undefined;
    let failure: Error | null = null;
    const onRead = () => {
      if (--remaining !== 0) return;
      if (!metadata || !auth) {
        failure = new Error("Owner vault metadata is unavailable");
        transaction.abort();
        return;
      }
      try {
        assertOwnerMeta(metadata);
        assertOwnerAuth(auth, ownerId);
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Owner metadata or auth state is invalid");
        transaction.abort();
        return;
      }
      if (metadata.local_state_revision >= Number.MAX_SAFE_INTEGER ||
          Math.max(metadata.lock_epoch, auth.lock_epoch) >= Number.MAX_SAFE_INTEGER) {
        failure = new Error("Owner revision or lock epoch is exhausted");
        transaction.abort();
        return;
      }
      result = Math.max(metadata.lock_epoch, auth.lock_epoch) + 1;
      metaStore.put({ ...metadata, lock_epoch: result, local_state_revision: metadata.local_state_revision + 1 });
      authStore.put({ ...auth, locked: true, lock_epoch: result, crypto_key: null, logout_ticket: logoutTicket });
    };
    metadataRequest.onsuccess = () => { metadata = metadataRequest.result as OwnerMeta | undefined; onRead(); };
    authRequest.onsuccess = () => { auth = authRequest.result as OwnerAuthState | undefined; onRead(); };
    metadataRequest.onerror = () => { failure = metadataRequest.error ?? new Error("Unable to read owner metadata"); transaction.abort(); };
    authRequest.onerror = () => { failure = authRequest.error ?? new Error("Unable to read owner auth state"); transaction.abort(); };
    transaction.oncomplete = () => result !== undefined ? resolve(result) : reject(new Error("Owner lock did not commit"));
    transaction.onabort = () => reject(failure ?? transaction.error ?? new Error("Owner lock aborted"));
    transaction.onerror = () => reject(failure ?? transaction.error ?? new Error("Owner lock failed"));
  });
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("dayforge:owner-locked", { detail: { ownerId, lockEpoch } }));
  }
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(`dayforge-sync:${ownerId}`);
      channel.postMessage({ type: "DAYFORGE_OWNER_LOCKED", ownerId, lockEpoch });
      channel.close();
    } catch {
      // The durable auth-state lock is authoritative; messaging only reduces the delay for other tabs.
    }
  }
  return lockEpoch;
}

export async function encryptOwnerPayload<T>(input: {
  ownerId: UUID;
  store: EncryptedStore;
  recordId: string;
  keyId: UUID;
  key: CryptoKey;
  payload: T;
}): Promise<{ iv: ArrayBuffer; ciphertext: ArrayBuffer }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = new TextEncoder().encode(`${input.ownerId}|${input.store}|${input.recordId}|v${VAULT_CRYPTO_VERSION}`);
  const plaintext = new TextEncoder().encode(canonicalizeJson(input.payload));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData, tagLength: 128 }, input.key, plaintext);
  return { iv: iv.buffer.slice(0), ciphertext };
}

export async function decryptOwnerPayload<T>(input: {
  ownerId: UUID;
  store: EncryptedStore;
  recordId: string;
  row: EncryptedOwnerRow;
  key: CryptoKey;
}): Promise<T> {
  if (input.row.owner_id !== input.ownerId || input.row.record_id !== input.recordId) throw new Error("Encrypted row identity mismatch");
  const additionalData = new TextEncoder().encode(`${input.ownerId}|${input.store}|${input.recordId}|v${VAULT_CRYPTO_VERSION}`);
  const plaintext = await crypto.subtle.decrypt({
    name: "AES-GCM",
    iv: input.row.iv,
    additionalData,
    tagLength: 128,
  }, input.key, input.row.ciphertext);
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plaintext)) as T;
}

export async function readOwnerSnapshot(database: IDBDatabase, ownerId: UUID, expectedBuild: string): Promise<OwnerSnapshot> {
  assertUuid(ownerId, "owner_id");
  const transaction = database.transaction(["build_gate", "owner_meta", "auth_state", "outbox", "shadow", "projection", "diagnostics", "drafts", "journal"], "readonly");
  const done = transactionDone(transaction);
  const gatePromise = requestValue(transaction.objectStore("build_gate").get("build_gate")) as Promise<BuildGate | undefined>;
  const metadataPromise = requestValue(transaction.objectStore("owner_meta").get(ownerId)) as Promise<OwnerMeta | undefined>;
  const authPromise = requestValue(transaction.objectStore("auth_state").get(ownerId)) as Promise<OwnerAuthState | undefined>;
  const readAll = (name: EncryptedStore) => requestValue(transaction.objectStore(name).index("by-owner").getAll(IDBKeyRange.only(ownerId))) as Promise<EncryptedOwnerRow[]>;
  const [gate, metadata, auth, outbox, shadow, projection, diagnostics, drafts, journal] = await Promise.all([
    gatePromise,
    metadataPromise,
    authPromise,
    readAll("outbox"),
    readAll("shadow"),
    readAll("projection"),
    readAll("diagnostics"),
    readAll("drafts"),
    readAll("journal"),
  ]);
  await done;
  if (!gate) throw new Error("Build gate is unavailable");
  assertBuildGate(gate);
  if (gate.phase !== "running" || gate.approved_build !== expectedBuild) throw new Error("Current build is not approved to read the owner vault");
  assertOwnerMeta(metadata);
  if (!auth) throw new Error("Owner auth state is missing");
  assertOwnerAuth(auth, ownerId);
  if (auth.locked || !auth.crypto_key || auth.lock_epoch !== metadata.lock_epoch) {
    throw new Error("Owner vault is locked or unavailable");
  }
  return { metadata, auth, outbox, shadow, projection, diagnostics, drafts, journal };
}

export async function commitOwnerChanges(input: {
  database: IDBDatabase;
  guard: OwnerCommitGuard;
  writes: readonly EncryptedWrite[];
  metadataPatch?: Partial<Omit<OwnerMeta, "owner_id" | "local_state_revision" | "lock_epoch">>;
  deletes?: ReadonlyArray<{ store: EncryptedStore; id: string }>;
}): Promise<OwnerCommitResult> {
  assertUuid(input.guard.owner_id, "owner_id");
  for (const write of input.writes) {
    if (write.row.owner_id !== input.guard.owner_id || typeof write.row.record_id !== "string" || !write.row.record_id ||
        write.row.id !== `${input.guard.owner_id}:${write.row.record_id}` ||
        write.row.iv.byteLength !== 12 || write.row.ciphertext.byteLength < 16) {
      throw new Error("Encrypted write identity or ciphertext is invalid");
    }
    assertUuid(write.row.key_id, "encrypted_row.key_id");
  }
  for (const deletion of input.deletes ?? []) {
    if (!deletion.id.startsWith(`${input.guard.owner_id}:`)) throw new Error("Owner transaction cannot delete another owner's row");
  }
  const storeNames = new Set<string>(["build_gate", "owner_meta", "auth_state", "leases"]);
  for (const write of input.writes) storeNames.add(write.store);
  for (const deletion of input.deletes ?? []) storeNames.add(deletion.store);
  const transaction = input.database.transaction([...storeNames], "readwrite", { durability: "strict" });
  const done = transactionDone(transaction);
  type ConflictReason = Extract<OwnerCommitResult, { committed: false }>["reason"];
  let conflict: ConflictReason | null = null;
  let settled = false;
  const finishConflict = (reason: ConflictReason) => {
    if (settled) return;
    settled = true;
    conflict = reason;
    transaction.abort();
  };

  const gateRequest = transaction.objectStore("build_gate").get("build_gate");
  const metadataRequest = transaction.objectStore("owner_meta").get(input.guard.owner_id);
  const authRequest = transaction.objectStore("auth_state").get(input.guard.owner_id);
  const leaseRequest = input.guard.expected_fencing_token === undefined
    ? null
    : transaction.objectStore("leases").get(input.guard.owner_id);
  const reads = [gateRequest, metadataRequest, authRequest, ...(leaseRequest ? [leaseRequest] : [])];
  let remaining = reads.length;
  let gate: BuildGate | undefined;
  let metadata: OwnerMeta | undefined;
  let auth: OwnerAuthState | undefined;
  let lease: LeaseRecord | undefined;
  const onRead = () => {
    if (settled || --remaining !== 0) return;
    if (!metadata || metadata.local_state_revision !== input.guard.expected_revision ||
        metadata.lock_epoch !== input.guard.expected_lock_epoch || metadata.sync_generation !== input.guard.expected_generation ||
        metadata.server_epoch !== input.guard.expected_server_epoch || metadata.pull_cursor !== input.guard.expected_cursor) {
      finishConflict("stale_snapshot");
      return;
    }
    try {
      assertOwnerMeta(metadata);
    } catch {
      finishConflict("stale_snapshot");
      return;
    }
    try {
      assertOwnerAuth(auth, input.guard.owner_id);
    } catch {
      finishConflict("locked");
      return;
    }
    if (!auth || auth.locked || !auth.crypto_key || auth.lock_epoch !== input.guard.expected_lock_epoch) {
      finishConflict("locked");
      return;
    }
    try {
      if (gate) assertBuildGate(gate);
    } catch {
      finishConflict("build_gate");
      return;
    }
    const ordinaryWriteAllowed = gate?.phase === "running" && gate.approved_build === input.guard.expected_build;
    const updaterAllowed = input.guard.updater !== undefined && gate?.phase === "switching" &&
      gate.target_build === input.guard.updater.target_build && gate.update_epoch === input.guard.updater.update_epoch &&
      gate.target_build === input.guard.expected_build;
    if (!gate || gate.revision !== input.guard.expected_gate_revision || (!ordinaryWriteAllowed && !updaterAllowed)) {
      finishConflict("build_gate");
      return;
    }
    if (leaseRequest && (!lease || lease.fencing_token !== input.guard.expected_fencing_token || lease.expires_at_ms <= Date.now())) {
      finishConflict("fence");
      return;
    }
    if (metadata.local_state_revision >= Number.MAX_SAFE_INTEGER) {
      finishConflict("stale_snapshot");
      return;
    }
    const nextMetadata: OwnerMeta = {
      ...metadata,
      ...input.metadataPatch,
      local_state_revision: metadata.local_state_revision + 1,
      lock_epoch: metadata.lock_epoch,
    };
    try {
      assertOwnerMeta(nextMetadata);
    } catch {
      finishConflict("stale_snapshot");
      return;
    }
    if (nextMetadata.owner_id !== input.guard.owner_id) {
      finishConflict("stale_snapshot");
      return;
    }
    const existingKeyId = metadata.key_id;
    if (!updaterAllowed && input.writes.some((write) => write.row.key_id !== existingKeyId)) {
      finishConflict("locked");
      return;
    }
    for (const write of input.writes) {
      if (write.row.owner_id !== input.guard.owner_id) {
        finishConflict("locked");
        return;
      }
      transaction.objectStore(write.store).put(write.row);
    }
    for (const deletion of input.deletes ?? []) transaction.objectStore(deletion.store).delete(deletion.id);
    transaction.objectStore("owner_meta").put(nextMetadata);
    settled = true;
  };
  gateRequest.onsuccess = () => { gate = gateRequest.result as BuildGate | undefined; onRead(); };
  metadataRequest.onsuccess = () => { metadata = metadataRequest.result as OwnerMeta | undefined; onRead(); };
  authRequest.onsuccess = () => { auth = authRequest.result as OwnerAuthState | undefined; onRead(); };
  if (leaseRequest) leaseRequest.onsuccess = () => { lease = leaseRequest.result as LeaseRecord | undefined; onRead(); };
  for (const request of reads) request.onerror = () => finishConflict("stale_snapshot");

  try {
    await done;
  } catch (error) {
    if (!conflict) throw new Error("Owner transaction failed; no changes were committed", { cause: error });
  }
  if (conflict) return { committed: false, reason: conflict };
  if (!metadata) throw new Error("Owner metadata was not read");
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent("dayforge:owner-state-changed", { detail: { ownerId: input.guard.owner_id } }));
  }
  if (typeof BroadcastChannel !== "undefined") {
    try {
      const channel = new BroadcastChannel(`dayforge-sync:${input.guard.owner_id}`);
      channel.postMessage({ type: "state_changed" });
      channel.close();
    } catch {
      // The committed state is durable; notifications are only a latency hint.
    }
  }
  return { committed: true, revision: metadata.local_state_revision + 1 };
}

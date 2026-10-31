import { type StorageResult, storageErr, storageOk } from "./errors";
import { STORAGE_STORES } from "./schema";
import { type EncryptedRecord, encryptPayload, decryptPayload } from "./crypto";
import { type OwnerAccessContext, type OwnerMetadata, validateOwnerAccess } from "./owner-gate";

export interface StoredViewPreference {
  date?: string;
  scale?: string;
  scrollY?: number;
  updatedAt: string;
}

export const MIN_CALENDAR_DATE = "0001-01-01";
export const MAX_CALENDAR_DATE = "9999-12-31";

export function isValidCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return false;
  }
  if (value < MIN_CALENDAR_DATE || value > MAX_CALENDAR_DATE) {
    return false;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function isValidScale(scale: unknown, calendar: "work" | "milestones"): boolean {
  if (calendar === "work") {
    return scale === "week";
  }
  return scale === "week" || scale === "month" || scale === "year";
}

function isValidScrollY(scrollY: unknown): scrollY is number {
  return typeof scrollY === "number" && Number.isFinite(scrollY) && scrollY >= 0;
}

export async function readOwnerViewPreference(
  db: IDBDatabase,
  ctx: OwnerAccessContext,
  calendar: "work" | "milestones"
): Promise<StorageResult<StoredViewPreference | null>> {
  const valRes = await validateOwnerAccess(db, ctx);
  if (!valRes.ok) {
    return valRes;
  }

  const rowResult = await new Promise<
    StorageResult<{
      owner_id: string;
      calendar: string;
      key_id: string;
      store?: string;
      record_id?: string;
      iv: Uint8Array;
      ciphertext: Uint8Array;
      updated_at?: string;
    } | null>
  >((resolve) => {
    try {
      const tx = db.transaction(STORAGE_STORES.view_preferences, "readonly");
      const store = tx.objectStore(STORAGE_STORES.view_preferences);
      const req = store.get([ctx.ownerId, calendar]);

      req.onsuccess = () => {
        resolve(storageOk(req.result ?? null));
      };
      req.onerror = () => {
        resolve(
          storageErr(
            "unavailable",
            req.error?.message ?? "Failed to read view preference",
            req.error
          )
        );
      };
      tx.onabort = () => {
        resolve(
          storageErr(
            "transaction_aborted",
            tx.error?.message ?? "Transaction aborted while reading view preference",
            tx.error
          )
        );
      };
    } catch (err) {
      resolve(
        storageErr(
          "unavailable",
          err instanceof Error ? err.message : "Error reading view preference",
          err
        )
      );
    }
  });

  if (!rowResult.ok) {
    return rowResult;
  }

  const row = rowResult.value;
  if (!row) {
    return storageOk(null);
  }

  const encRecord: EncryptedRecord = {
    owner_id: row.owner_id,
    store: row.store ?? STORAGE_STORES.view_preferences,
    record_id: row.record_id ?? calendar,
    key_id: row.key_id,
    iv: row.iv,
    ciphertext: row.ciphertext,
  };

  const decRes = await decryptPayload<StoredViewPreference>(
    ctx.key,
    encRecord,
    ctx.ownerId,
    STORAGE_STORES.view_preferences,
    calendar
  );

  return decRes;
}

export async function writeOwnerViewPreference(
  db: IDBDatabase,
  ctx: OwnerAccessContext,
  calendar: "work" | "milestones",
  pref: StoredViewPreference
): Promise<StorageResult<void>> {
  // Validate fields
  if (pref.date !== undefined && !isValidCalendarDate(pref.date)) {
    return storageErr(
      "invalid_data",
      `Invalid date '${pref.date}': must be YYYY-MM-DD between 0001-01-01 and 9999-12-31`
    );
  }

  if (pref.scale !== undefined && !isValidScale(pref.scale, calendar)) {
    return storageErr(
      "invalid_data",
      `Invalid scale '${pref.scale}' for calendar '${calendar}'`
    );
  }

  if (pref.scrollY !== undefined && !isValidScrollY(pref.scrollY)) {
    return storageErr(
      "invalid_data",
      `Invalid scrollY '${pref.scrollY}': must be finite non-negative number`
    );
  }

  if (typeof pref.updatedAt !== "string" || pref.updatedAt.trim().length === 0) {
    return storageErr("invalid_data", "updatedAt must be a non-empty ISO string");
  }

  const encRes = await encryptPayload(
    ctx.key,
    ctx.ownerId,
    ctx.keyId,
    STORAGE_STORES.view_preferences,
    calendar,
    pref
  );

  if (!encRes.ok) {
    return encRes;
  }

  return new Promise((resolve) => {
    let resolved = false;
    const safeResolve = (res: StorageResult<void>) => {
      if (!resolved) {
        resolved = true;
        resolve(res);
      }
    };

    try {
      const tx = db.transaction(
        [STORAGE_STORES.owner_meta, STORAGE_STORES.view_preferences],
        "readwrite"
      );
      const metaStore = tx.objectStore(STORAGE_STORES.owner_meta);
      const prefStore = tx.objectStore(STORAGE_STORES.view_preferences);

      const metaReq = metaStore.get(ctx.ownerId);
      metaReq.onsuccess = () => {
        const meta = metaReq.result as OwnerMetadata | undefined;
        if (!meta) {
          tx.abort();
          safeResolve(
            storageErr(
              "locked",
              `Owner '${ctx.ownerId}' has not been initialized or unlocked`
            )
          );
          return;
        }

        if (meta.locked) {
          tx.abort();
          safeResolve(storageErr("locked", `Owner '${ctx.ownerId}' is currently locked`));
          return;
        }

        if (meta.lock_epoch !== ctx.lockEpoch) {
          tx.abort();
          safeResolve(
            storageErr(
              "locked",
              `Stale access context: current epoch is ${meta.lock_epoch}, context epoch is ${ctx.lockEpoch}`
            )
          );
          return;
        }

        const record = {
          owner_id: ctx.ownerId,
          calendar,
          key_id: ctx.keyId,
          store: STORAGE_STORES.view_preferences,
          record_id: calendar,
          iv: encRes.value.iv,
          ciphertext: encRes.value.ciphertext,
          updated_at: pref.updatedAt,
        };

        prefStore.put(record);
      };

      metaReq.onerror = () => {
        safeResolve(
          storageErr(
            "transaction_aborted",
            metaReq.error?.message ?? "Failed to read owner metadata for write",
            metaReq.error
          )
        );
      };

      tx.oncomplete = () => {
        safeResolve(storageOk(undefined));
      };

      tx.onerror = () => {
        safeResolve(
          storageErr(
            "transaction_aborted",
            tx.error?.message ?? "Transaction aborted while writing view preference",
            tx.error
          )
        );
      };

      tx.onabort = () => {
        safeResolve(
          storageErr(
            "transaction_aborted",
            tx.error?.message ?? "Transaction aborted while writing view preference",
            tx.error
          )
        );
      };
    } catch (err) {
      safeResolve(
        storageErr(
          "unavailable",
          err instanceof Error ? err.message : "Error accessing view_preferences store",
          err
        )
      );
    }
  });
}

function parseAndValidateLegacyPreference(
  rawJson: string | null,
  calendar: "work" | "milestones"
): StoredViewPreference | null {
  if (!rawJson) return null;
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    const obj = parsed as Record<string, unknown>;
    const anchor = obj.anchor ?? obj.date;

    // Anchor/date is required in legacy view preferences
    if (!isValidCalendarDate(anchor)) {
      return null;
    }

    // Scale validation
    if (obj.scale !== undefined && !isValidScale(obj.scale, calendar)) {
      return null;
    }

    // ScrollY validation
    if (obj.scrollY !== undefined && !isValidScrollY(obj.scrollY)) {
      return null;
    }

    const scrollY =
      typeof obj.scrollY === "number" ? Math.max(0, Math.round(obj.scrollY)) : undefined;

    const scale = typeof obj.scale === "string" ? obj.scale : calendar === "work" ? "week" : "month";

    const updatedAt =
      typeof obj.updatedAt === "string" && obj.updatedAt.trim().length > 0
        ? obj.updatedAt
        : new Date().toISOString();

    return {
      date: anchor,
      scale,
      ...(scrollY !== undefined ? { scrollY } : {}),
      updatedAt,
    };
  } catch {
    return null;
  }
}

export async function migrateLegacyViewPreferences(
  db: IDBDatabase,
  ctx: OwnerAccessContext,
  storage?: Storage
): Promise<StorageResult<{ workMigrated: boolean; milestonesMigrated: boolean }>> {
  const valRes = await validateOwnerAccess(db, ctx);
  if (!valRes.ok) {
    return valRes;
  }

  const storageObj =
    storage ?? (typeof window !== "undefined" ? window.sessionStorage : null);

  if (!storageObj) {
    return storageOk({ workMigrated: false, milestonesMigrated: false });
  }

  let workCandidate: StoredViewPreference | null = null;
  let milestonesCandidate: StoredViewPreference | null = null;

  try {
    const rawWork = storageObj.getItem("dayforge:view:v1:work");
    if (rawWork !== null) {
      workCandidate = parseAndValidateLegacyPreference(rawWork, "work");
      if (!workCandidate) {
        try {
          storageObj.removeItem("dayforge:view:v1:work");
        } catch {
          // ignore
        }
      }
    }
  } catch {
    // Storage access might throw in restricted environments; fail safely
    workCandidate = null;
  }

  try {
    const rawMilestones = storageObj.getItem("dayforge:view:v1:milestones");
    if (rawMilestones !== null) {
      milestonesCandidate = parseAndValidateLegacyPreference(rawMilestones, "milestones");
      if (!milestonesCandidate) {
        try {
          storageObj.removeItem("dayforge:view:v1:milestones");
        } catch {
          // ignore
        }
      }
    }
  } catch {
    milestonesCandidate = null;
  }

  let workMigrated = false;
  let milestonesMigrated = false;

  if (workCandidate) {
    const writeRes = await writeOwnerViewPreference(db, ctx, "work", workCandidate);
    if (!writeRes.ok) {
      return writeRes;
    }
    try {
      storageObj.removeItem("dayforge:view:v1:work");
      workMigrated = true;
    } catch {
      // If removeItem fails, workMigrated remains true because write succeeded
      workMigrated = true;
    }
  }

  if (milestonesCandidate) {
    const writeRes = await writeOwnerViewPreference(db, ctx, "milestones", milestonesCandidate);
    if (!writeRes.ok) {
      return writeRes;
    }
    try {
      storageObj.removeItem("dayforge:view:v1:milestones");
      milestonesMigrated = true;
    } catch {
      milestonesMigrated = true;
    }
  }

  return storageOk({ workMigrated, milestonesMigrated });
}

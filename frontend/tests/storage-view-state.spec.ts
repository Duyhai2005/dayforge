import * as fs from "node:fs";
import * as path from "node:path";
import { expect, test } from "@playwright/test";
import ts from "typescript";
import {
  StorageError,
  openDatabase,
  closeDatabase,
  DB_NAME,
  STORAGE_STORES,
  generateTestKey,
  importRawKey,
  unlockOwner,
  lockOwner,
  type OwnerAccessContext,
  type StoredViewPreference,
  readOwnerViewPreference,
  writeOwnerViewPreference,
  migrateLegacyViewPreferences,
} from "../lib/storage";

declare global {
  interface Window {
    __dayforge_storage_view_state: {
      StorageError: typeof StorageError;
      DB_NAME: typeof DB_NAME;
      STORAGE_STORES: typeof STORAGE_STORES;
      openDatabase: typeof openDatabase;
      closeDatabase: typeof closeDatabase;
      generateTestKey: typeof generateTestKey;
      importRawKey: typeof importRawKey;
      unlockOwner: typeof unlockOwner;
      lockOwner: typeof lockOwner;
      readOwnerViewPreference: typeof readOwnerViewPreference;
      writeOwnerViewPreference: typeof writeOwnerViewPreference;
      migrateLegacyViewPreferences: typeof migrateLegacyViewPreferences;
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
    "view-preferences.ts",
  ];

  const combined = files
    .filter((file) => fs.existsSync(path.join(libDir, file)))
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
    window.__dayforge_storage_view_state = exports;
  })();`;
}

test.describe("Storage View Preferences Specifications", () => {
  const scriptContent = buildStorageScript();

  test.describe("Browser Runtime: ST-15 Migration and Owner Scoped View Preferences", () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript({ content: scriptContent });
      await page.goto("/work");
      await page.evaluate(async (dbName) => {
        sessionStorage.clear();
        return new Promise<void>((resolve, reject) => {
          const req = indexedDB.deleteDatabase(dbName);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
          req.onblocked = () => resolve();
        });
      }, DB_NAME);
    });

    test("ST-15: migrates valid work and milestones from sessionStorage into encrypted IndexedDB view_preferences and removes legacy items", async ({
      page,
    }) => {
      const result = await page.evaluate(async () => {
        const {
          openDatabase,
          closeDatabase,
          generateTestKey,
          unlockOwner,
          migrateLegacyViewPreferences,
          readOwnerViewPreference,
          STORAGE_STORES,
        } = window.__dayforge_storage_view_state;

        // Populate valid legacy sessionStorage items
        sessionStorage.setItem(
          "dayforge:view:v1:work",
          JSON.stringify({ anchor: "2026-01-31", scale: "week", scrollY: 120 })
        );
        sessionStorage.setItem(
          "dayforge:view:v1:milestones",
          JSON.stringify({ anchor: "2026-02-28", scale: "year", scrollY: 640 })
        );

        const openRes = await openDatabase();
        if (!openRes.ok) throw new Error("openDatabase failed");
        const db = openRes.value;

        const ownerId = "owner-alice";
        const keyId = "key-alice-1";
        const key = await generateTestKey();
        const unlockRes = await unlockOwner(db, ownerId, keyId, key);
        if (!unlockRes.ok) throw new Error("unlockOwner failed");
        const ctx = unlockRes.value;

        // Perform migration
        const migRes = await migrateLegacyViewPreferences(db, ctx);

        // Verify legacy sessionStorage items are removed
        const workSessionAfter = sessionStorage.getItem("dayforge:view:v1:work");
        const milestonesSessionAfter = sessionStorage.getItem("dayforge:view:v1:milestones");

        // Read migrated preferences from IndexedDB
        const workPrefRes = await readOwnerViewPreference(db, ctx, "work");
        const milestonesPrefRes = await readOwnerViewPreference(db, ctx, "milestones");

        // Inspect raw record in object store to verify encryption
        const rawInspection = await new Promise<{
          hasWorkRecord: boolean;
          isCiphertextBytes: boolean;
          workCiphertextLen: number;
        }>((resolve) => {
          const tx = db.transaction(STORAGE_STORES.view_preferences, "readonly");
          const store = tx.objectStore(STORAGE_STORES.view_preferences);
          const req = store.get([ownerId, "work"]);
          req.onsuccess = () => {
            const row = req.result;
            resolve({
              hasWorkRecord: !!row,
              isCiphertextBytes: row?.ciphertext instanceof Uint8Array,
              workCiphertextLen: row?.ciphertext ? row.ciphertext.length : 0,
            });
          };
          req.onerror = () => {
            resolve({
              hasWorkRecord: false,
              isCiphertextBytes: false,
              workCiphertextLen: 0,
            });
          };
        });

        closeDatabase(db);

        return {
          migRes,
          workSessionAfter,
          milestonesSessionAfter,
          workPrefRes,
          milestonesPrefRes,
          rawInspection,
        };
      });

      expect(result.migRes.ok).toBe(true);
      if (result.migRes.ok) {
        expect(result.migRes.value.workMigrated).toBe(true);
        expect(result.migRes.value.milestonesMigrated).toBe(true);
      }

      // Legacy sessionStorage cleared
      expect(result.workSessionAfter).toBeNull();
      expect(result.milestonesSessionAfter).toBeNull();

      // Read back correctly
      expect(result.workPrefRes.ok).toBe(true);
      if (result.workPrefRes.ok) {
        expect(result.workPrefRes.value?.date).toBe("2026-01-31");
        expect(result.workPrefRes.value?.scale).toBe("week");
        expect(result.workPrefRes.value?.scrollY).toBe(120);
        expect(typeof result.workPrefRes.value?.updatedAt).toBe("string");
      }

      expect(result.milestonesPrefRes.ok).toBe(true);
      if (result.milestonesPrefRes.ok) {
        expect(result.milestonesPrefRes.value?.date).toBe("2026-02-28");
        expect(result.milestonesPrefRes.value?.scale).toBe("year");
        expect(result.milestonesPrefRes.value?.scrollY).toBe(640);
        expect(typeof result.milestonesPrefRes.value?.updatedAt).toBe("string");
      }

      // Raw record in IndexedDB is ciphertext bytes, not plaintext JSON
      expect(result.rawInspection.hasWorkRecord).toBe(true);
      expect(result.rawInspection.isCiphertextBytes).toBe(true);
      expect(result.rawInspection.workCiphertextLen).toBeGreaterThan(0);
    });

    test("preserves sessionStorage when owner is locked or migration write fails", async ({
      page,
    }) => {
      const result = await page.evaluate(async () => {
        const {
          openDatabase,
          closeDatabase,
          generateTestKey,
          unlockOwner,
          lockOwner,
          migrateLegacyViewPreferences,
        } = window.__dayforge_storage_view_state;

        const initialWork = JSON.stringify({ anchor: "2026-05-10", scale: "week", scrollY: 300 });
        sessionStorage.setItem("dayforge:view:v1:work", initialWork);

        const openRes = await openDatabase();
        if (!openRes.ok) throw new Error("openDatabase failed");
        const db = openRes.value;

        const ownerId = "owner-locked-test";
        const keyId = "key-locked-1";
        const key = await generateTestKey();
        const unlockRes = await unlockOwner(db, ownerId, keyId, key);
        if (!unlockRes.ok) throw new Error("unlockOwner failed");
        const ctx = unlockRes.value;

        // Lock the owner before migration
        await lockOwner(db, ownerId);

        // Attempt migration with locked owner
        const migRes = await migrateLegacyViewPreferences(db, ctx);

        // Check sessionStorage
        const workSessionAfter = sessionStorage.getItem("dayforge:view:v1:work");

        closeDatabase(db);

        return {
          migRes,
          workSessionAfter,
          initialWork,
        };
      });

      expect(result.migRes.ok).toBe(false);
      if (!result.migRes.ok) {
        expect(result.migRes.error.code).toBe("locked");
      }
      // sessionStorage item MUST remain preserved and unchanged
      expect(result.workSessionAfter).toBe(result.initialWork);
    });

    test("rejects malformed and out-of-bounds legacy data without crashing or corrupting storage", async ({
      page,
    }) => {
      const result = await page.evaluate(async () => {
        const {
          openDatabase,
          closeDatabase,
          generateTestKey,
          unlockOwner,
          migrateLegacyViewPreferences,
          readOwnerViewPreference,
        } = window.__dayforge_storage_view_state;

        // Work: malformed JSON; Milestones: date out of bounds (10000-01-01)
        sessionStorage.setItem("dayforge:view:v1:work", "{ corrupted json syntax !!!");
        sessionStorage.setItem(
          "dayforge:view:v1:milestones",
          JSON.stringify({ anchor: "10000-01-01", scale: "year", scrollY: 100 })
        );

        const openRes = await openDatabase();
        if (!openRes.ok) throw new Error("openDatabase failed");
        const db = openRes.value;

        const ownerId = "owner-malformed-test";
        const keyId = "key-malformed-1";
        const key = await generateTestKey();
        const unlockRes = await unlockOwner(db, ownerId, keyId, key);
        if (!unlockRes.ok) throw new Error("unlockOwner failed");
        const ctx = unlockRes.value;

        const migRes = await migrateLegacyViewPreferences(db, ctx);

        const workSessionAfter = sessionStorage.getItem("dayforge:view:v1:work");
        const milestonesSessionAfter = sessionStorage.getItem("dayforge:view:v1:milestones");

        const workPrefRes = await readOwnerViewPreference(db, ctx, "work");
        const milestonesPrefRes = await readOwnerViewPreference(db, ctx, "milestones");

        closeDatabase(db);

        return {
          migRes,
          workSessionAfter,
          milestonesSessionAfter,
          workPrefRes,
          milestonesPrefRes,
        };
      });

      // Falls back cleanly without throwing or crashing
      expect(result.migRes.ok).toBe(true);
      if (result.migRes.ok) {
        expect(result.migRes.value.workMigrated).toBe(false);
        expect(result.migRes.value.milestonesMigrated).toBe(false);
      }

      // No corrupt records stored in IndexedDB
      expect(result.workPrefRes.ok).toBe(true);
      if (result.workPrefRes.ok) {
        expect(result.workPrefRes.value).toBeNull();
      }
      expect(result.milestonesPrefRes.ok).toBe(true);
      if (result.milestonesPrefRes.ok) {
        expect(result.milestonesPrefRes.value).toBeNull();
      }
    });

    test("handles partial validity: migrates valid milestone while skipping invalid work", async ({
      page,
    }) => {
      const result = await page.evaluate(async () => {
        const {
          openDatabase,
          closeDatabase,
          generateTestKey,
          unlockOwner,
          migrateLegacyViewPreferences,
          readOwnerViewPreference,
        } = window.__dayforge_storage_view_state;

        // Work has negative scrollY (invalid)
        sessionStorage.setItem(
          "dayforge:view:v1:work",
          JSON.stringify({ anchor: "2026-03-01", scale: "week", scrollY: -40 })
        );
        // Milestones is completely valid
        sessionStorage.setItem(
          "dayforge:view:v1:milestones",
          JSON.stringify({ anchor: "2026-06-15", scale: "month", scrollY: 250 })
        );

        const openRes = await openDatabase();
        if (!openRes.ok) throw new Error("openDatabase failed");
        const db = openRes.value;

        const ownerId = "owner-partial-test";
        const keyId = "key-partial-1";
        const key = await generateTestKey();
        const unlockRes = await unlockOwner(db, ownerId, keyId, key);
        if (!unlockRes.ok) throw new Error("unlockOwner failed");
        const ctx = unlockRes.value;

        const migRes = await migrateLegacyViewPreferences(db, ctx);

        const workSessionAfter = sessionStorage.getItem("dayforge:view:v1:work");
        const milestonesSessionAfter = sessionStorage.getItem("dayforge:view:v1:milestones");

        const workPrefRes = await readOwnerViewPreference(db, ctx, "work");
        const milestonesPrefRes = await readOwnerViewPreference(db, ctx, "milestones");

        closeDatabase(db);

        return {
          migRes,
          workSessionAfter,
          milestonesSessionAfter,
          workPrefRes,
          milestonesPrefRes,
        };
      });

      expect(result.migRes.ok).toBe(true);
      if (result.migRes.ok) {
        expect(result.migRes.value.workMigrated).toBe(false);
        expect(result.migRes.value.milestonesMigrated).toBe(true);
      }

      // Valid milestones cleared from sessionStorage, invalid work retained
      expect(result.workSessionAfter).not.toBeNull();
      expect(result.milestonesSessionAfter).toBeNull();

      // Milestones readable from IndexedDB, work is null
      expect(result.workPrefRes.ok).toBe(true);
      if (result.workPrefRes.ok) {
        expect(result.workPrefRes.value).toBeNull();
      }
      expect(result.milestonesPrefRes.ok).toBe(true);
      if (result.milestonesPrefRes.ok) {
        expect(result.milestonesPrefRes.value?.date).toBe("2026-06-15");
        expect(result.milestonesPrefRes.value?.scale).toBe("month");
        expect(result.milestonesPrefRes.value?.scrollY).toBe(250);
      }
    });

    test("enforces owner isolation: distinct owners have separate encrypted view preferences without leakage", async ({
      page,
    }) => {
      const result = await page.evaluate(async () => {
        const {
          openDatabase,
          closeDatabase,
          generateTestKey,
          unlockOwner,
          writeOwnerViewPreference,
          readOwnerViewPreference,
        } = window.__dayforge_storage_view_state;

        const openRes = await openDatabase();
        if (!openRes.ok) throw new Error("openDatabase failed");
        const db = openRes.value;

        // Setup Owner Alpha
        const ownerAlpha = "owner-alpha";
        const keyAlpha = await generateTestKey();
        const unlockAlphaRes = await unlockOwner(db, ownerAlpha, "key-a", keyAlpha);
        if (!unlockAlphaRes.ok) throw new Error("unlockAlpha failed");
        const ctxAlpha = unlockAlphaRes.value;

        // Setup Owner Beta
        const ownerBeta = "owner-beta";
        const keyBeta = await generateTestKey();
        const unlockBetaRes = await unlockOwner(db, ownerBeta, "key-b", keyBeta);
        if (!unlockBetaRes.ok) throw new Error("unlockBeta failed");
        const ctxBeta = unlockBetaRes.value;

        // Write distinct preferences
        await writeOwnerViewPreference(db, ctxAlpha, "work", {
          date: "2026-03-15",
          scale: "week",
          scrollY: 100,
          updatedAt: "2026-03-15T10:00:00.000Z",
        });

        await writeOwnerViewPreference(db, ctxBeta, "work", {
          date: "2026-04-20",
          scale: "week",
          scrollY: 500,
          updatedAt: "2026-04-20T10:00:00.000Z",
        });

        // Read each owner's preference
        const readAlpha = await readOwnerViewPreference(db, ctxAlpha, "work");
        const readBeta = await readOwnerViewPreference(db, ctxBeta, "work");

        // Attempt cross-reading: spoof context with ownerAlpha but keyBeta
        const spoofedCtx: OwnerAccessContext = {
          ownerId: ownerAlpha,
          keyId: "key-b",
          lockEpoch: ctxAlpha.lockEpoch,
          key: keyBeta,
        };
        const crossReadRes = await readOwnerViewPreference(db, spoofedCtx, "work");

        closeDatabase(db);

        return {
          readAlpha,
          readBeta,
          crossReadRes,
        };
      });

      expect(result.readAlpha.ok).toBe(true);
      if (result.readAlpha.ok) {
        expect(result.readAlpha.value?.date).toBe("2026-03-15");
        expect(result.readAlpha.value?.scrollY).toBe(100);
      }

      expect(result.readBeta.ok).toBe(true);
      if (result.readBeta.ok) {
        expect(result.readBeta.value?.date).toBe("2026-04-20");
        expect(result.readBeta.value?.scrollY).toBe(500);
      }

      // Cross-read with mismatched key must fail with integrity_failed
      expect(result.crossReadRes.ok).toBe(false);
      if (!result.crossReadRes.ok) {
        expect(result.crossReadRes.error.code).toBe("integrity_failed");
      }
    });

    test("direct writeOwnerViewPreference validates bounds and rejects out-of-range dates", async ({
      page,
    }) => {
      const result = await page.evaluate(async () => {
        const {
          openDatabase,
          closeDatabase,
          generateTestKey,
          unlockOwner,
          writeOwnerViewPreference,
        } = window.__dayforge_storage_view_state;

        const openRes = await openDatabase();
        if (!openRes.ok) throw new Error("openDatabase failed");
        const db = openRes.value;

        const ownerId = "owner-bounds-test";
        const key = await generateTestKey();
        const unlockRes = await unlockOwner(db, ownerId, "key-bounds", key);
        if (!unlockRes.ok) throw new Error("unlockOwner failed");
        const ctx = unlockRes.value;

        // Negative year / underflow
        const resUnder = await writeOwnerViewPreference(db, ctx, "work", {
          date: "0000-12-31",
          scale: "week",
          scrollY: 0,
          updatedAt: new Date().toISOString(),
        });

        // Overflow year 10000
        const resOver = await writeOwnerViewPreference(db, ctx, "work", {
          date: "10000-01-01",
          scale: "week",
          scrollY: 0,
          updatedAt: new Date().toISOString(),
        });

        // Invalid scale for work
        const resScale = await writeOwnerViewPreference(db, ctx, "work", {
          date: "2026-06-01",
          scale: "month",
          scrollY: 0,
          updatedAt: new Date().toISOString(),
        });

        // Negative scrollY
        const resScroll = await writeOwnerViewPreference(db, ctx, "work", {
          date: "2026-06-01",
          scale: "week",
          scrollY: -10,
          updatedAt: new Date().toISOString(),
        });

        // Valid boundary dates (0001-01-01 and 9999-12-31)
        const resMin = await writeOwnerViewPreference(db, ctx, "work", {
          date: "0001-01-01",
          scale: "week",
          scrollY: 0,
          updatedAt: new Date().toISOString(),
        });

        const resMax = await writeOwnerViewPreference(db, ctx, "work", {
          date: "9999-12-31",
          scale: "week",
          scrollY: 0,
          updatedAt: new Date().toISOString(),
        });

        closeDatabase(db);

        return {
          resUnder,
          resOver,
          resScale,
          resScroll,
          resMin,
          resMax,
        };
      });

      expect(result.resUnder.ok).toBe(false);
      expect(result.resOver.ok).toBe(false);
      expect(result.resScale.ok).toBe(false);
      expect(result.resScroll.ok).toBe(false);
      expect(result.resMin.ok).toBe(true);
      expect(result.resMax.ok).toBe(true);
    });
  });
});

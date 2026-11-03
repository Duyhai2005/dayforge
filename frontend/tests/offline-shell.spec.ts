import { expect, test, chromium, type BrowserContext, type Page } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:3011";
const databaseName = "dayforge-local";
const ownerId = "11111111-1111-4111-8111-111111111111";
const updateEpoch = "22222222-2222-4222-8222-222222222222";

async function openProfile(): Promise<{ context: BrowserContext; page: Page; directory: string }> {
  const directory = await mkdtemp(path.join(tmpdir(), "dayforge-offline-"));
  const context = await chromium.launchPersistentContext(directory, {
    baseURL,
    headless: true,
    ignoreHTTPSErrors: true,
    serviceWorkers: "allow",
  });
  const page = context.pages()[0] ?? await context.newPage();
  return { context, page, directory };
}

async function closeProfile(context: BrowserContext, directory: string): Promise<void> {
  await context.close();
  await rm(directory, { recursive: true, force: true });
}

async function createVersionOneVault(page: Page, gate: Record<string, unknown>): Promise<void> {
  await page.goto(`${baseURL}/dayforge-build.json`);
  await page.evaluate(async ({ databaseName, gate, ownerId }) => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        database.createObjectStore("build_gate", { keyPath: "key" }).put(gate);
        database.createObjectStore("owner_meta", { keyPath: "owner_id" }).put({
          owner_id: ownerId,
          local_state_revision: 1,
          lock_epoch: 0,
          sync_generation: 0,
          server_epoch: null,
          pull_cursor: "0",
          device_id: "33333333-3333-4333-8333-333333333333",
          device_sequence: "0",
          local_hlc: null,
          observed_hlc: null,
          clock_calibration: null,
          key_id: "44444444-4444-4444-8444-444444444444",
          email: "local@example.test",
          preserved_sentinel: "local-vault-row",
        });
        database.createObjectStore("auth_state", { keyPath: "owner_id" }).put({
          owner_id: ownerId,
          locked: true,
          lock_epoch: 0,
          crypto_key: null,
          logout_ticket: null,
        });
        const stores = ["outbox", "shadow", "projection", "diagnostics", "drafts", "journal", "staging"];
        for (const name of stores) {
          const store = database.createObjectStore(name, { keyPath: "id" });
          store.createIndex("by-owner", "owner_id", { unique: false });
          if (name === "outbox") store.createIndex("by-owner-state", ["owner_id", "state"], { unique: false });
        }
        database.createObjectStore("leases", { keyPath: "owner_id" });
      };
      request.onsuccess = () => {
        const database = request.result;
        void (async () => {
          try {
            const rawKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
            const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt"]);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const recordId = "draft-sentinel";
            const additionalData = new TextEncoder().encode(`${ownerId}|drafts|${recordId}|v1`);
            const ciphertext = await crypto.subtle.encrypt(
              { name: "AES-GCM", iv, additionalData, tagLength: 128 },
              key,
              new TextEncoder().encode(JSON.stringify({ note: "encrypted v1 draft survives upgrade" })),
            );
            const transaction = database.transaction(["drafts"], "readwrite");
            transaction.objectStore("drafts").put({
              id: `${ownerId}:${recordId}`,
              owner_id: ownerId,
              record_id: recordId,
              key_id: "44444444-4444-4444-8444-444444444444",
              iv: iv.buffer,
              ciphertext,
            });
            transaction.oncomplete = () => { database.close(); resolve(); };
            transaction.onerror = () => { database.close(); reject(transaction.error); };
            transaction.onabort = () => { database.close(); reject(transaction.error); };
          } catch (error) {
            database.close();
            reject(error);
          }
        })();
      };
      request.onerror = () => reject(request.error);
    });
  }, { databaseName, gate, ownerId });
}

async function assertVersionOneDraftDecrypts(page: Page): Promise<void> {
  const plaintext = await page.evaluate(async ({ databaseName, ownerId }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const row = await new Promise<{ iv: ArrayBuffer; ciphertext: ArrayBuffer }>((resolve, reject) => {
      const transaction = database.transaction(["drafts"], "readonly");
      const request = transaction.objectStore("drafts").get(`${ownerId}:draft-sentinel`);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    database.close();
    const rawKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
    const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
    const additionalData = new TextEncoder().encode(`${ownerId}|drafts|draft-sentinel|v1`);
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: row.iv, additionalData, tagLength: 128 },
      key,
      row.ciphertext,
    );
    return new TextDecoder().decode(decrypted);
  }, { databaseName, ownerId });
  expect(plaintext).toBe(JSON.stringify({ note: "encrypted v1 draft survives upgrade" }));
}

async function readBuildGate(page: Page): Promise<{ version: number; gate: Record<string, unknown> | null; diagnosticIndexes: string[]; sentinel: string | null }> {
  return page.evaluate(async (databaseName) => await new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName);
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(["build_gate", "owner_meta", "diagnostics"], "readonly");
      const gateRequest = transaction.objectStore("build_gate").get("build_gate");
      const rowRequest = transaction.objectStore("owner_meta").get("11111111-1111-4111-8111-111111111111");
      const indexes = Array.from(transaction.objectStore("diagnostics").indexNames);
      transaction.oncomplete = () => {
        resolve({ version: database.version, gate: gateRequest.result ?? null, diagnosticIndexes: indexes, sentinel: rowRequest.result?.preserved_sentinel ?? null });
        database.close();
      };
      transaction.onerror = () => { database.close(); reject(transaction.error); };
    };
    request.onerror = () => reject(request.error);
  }), databaseName);
}

test("production shell survives a browser restart offline and keeps private paths out of Cache Storage", async () => {
  test.setTimeout(120_000);
  const first = await openProfile();
  try {
    try {
      await first.page.goto(`${baseURL}/work`);
      await expect.poll(async () => await first.page.evaluate(async () => {
        try {
          const manifest = await fetch("/dayforge-build.json", { cache: "no-store" }).then((response) => response.json());
          const cache = await caches.open(`dayforge-shell:${manifest.build_id}`);
          const ready = await cache.match("/__dayforge_shell_ready__");
          if (!ready) return false;
          return ready.headers.get("X-Dayforge-Build") === manifest.build_id && await ready.text() === manifest.build_id;
        } catch { return false; }
      }), { timeout: 60_000, intervals: [100, 250, 500, 1_000] }).toBe(true);

      const cachedPaths = await first.page.evaluate(async () => {
        const names = await caches.keys();
        const paths: string[] = [];
        for (const name of names) {
          const cache = await caches.open(name);
          for (const request of await cache.keys()) paths.push(new URL(request.url).pathname);
        }
        return paths;
      });
      const workerState = await first.page.evaluate(async () => {
        const registrations = await navigator.serviceWorker.getRegistrations();
        return {
          secure: isSecureContext,
          controlled: Boolean(navigator.serviceWorker.controller),
          registrations: registrations.map((registration) => ({
            scope: registration.scope,
            active: registration.active?.state ?? null,
            waiting: registration.waiting?.state ?? null,
            installing: registration.installing?.state ?? null,
            activeScript: registration.active?.scriptURL ?? null,
          })),
          caches: await caches.keys(),
        };
      });
      expect(cachedPaths, JSON.stringify(workerState)).toContain("/work");
      expect(cachedPaths).toContain("/milestones");
      expect(cachedPaths.some((entry) => entry.startsWith("/api/") || entry.startsWith("/account") ||
        entry.startsWith("/verify-email") || entry.startsWith("/reset-password"))).toBe(false);

      await first.context.setOffline(true);
      await first.page.goto(`${baseURL}/milestones?date=2026-11-02&scale=year`);
      await expect(first.page).toHaveURL(/\/milestones\?date=2026-11-02&scale=year$/);
      await expect(first.page.locator("main")).toBeVisible();
      const privateRequest = await first.page.evaluate(async () => {
        try { await fetch("/api/v1/auth/session", { cache: "no-store", credentials: "same-origin" }); return "resolved"; }
        catch { return "rejected"; }
      });
      expect(privateRequest).toBe("rejected");
    } finally {
      await first.context.close();
    }

    const restarted = await chromium.launchPersistentContext(first.directory, {
      baseURL,
      headless: true,
      ignoreHTTPSErrors: true,
      serviceWorkers: "allow",
    });
    try {
      await restarted.setOffline(true);
      const page = restarted.pages()[0] ?? await restarted.newPage();
      await page.goto(`${baseURL}/`);
      await expect(page).toHaveURL(/\/work$/);
      await expect(page.locator("main")).toBeVisible();
    } finally {
      await restarted.close();
    }
  } finally {
    await rm(first.directory, { recursive: true, force: true });
  }
});

test("schema migration requires the switching gate and preserves a v1 vault on rejection", async () => {
  test.setTimeout(60_000);
  const profile = await openProfile();
  try {
    await profile.page.goto(`${baseURL}/dayforge-build.json`);
    const buildId = await profile.page.evaluate(async () => {
      const response = await fetch("/dayforge-build.json", { cache: "no-store" });
      return (await response.json()).build_id as string;
    });
    await createVersionOneVault(profile.page, {
      key: "build_gate",
      approved_build: "old-approved-build",
      target_build: null,
      update_epoch: null,
      target_schema_version: null,
      phase: "running",
      schema_version: 1,
      revision: 1,
    });
    await profile.page.goto(`${baseURL}/work`);
    await expect(profile.page.locator(".offline-build-gate")).toContainText(/build|kho local|cập nhật/i);
    const state = await readBuildGate(profile.page);
    expect(state.version).toBe(1);
    expect(state.gate).toMatchObject({ approved_build: "old-approved-build", phase: "running", schema_version: 1 });
    expect(state.sentinel).toBe("local-vault-row");
    expect(state.diagnosticIndexes).not.toContain("by-owner-superseded");
    await assertVersionOneDraftDecrypts(profile.page);
    expect(buildId).not.toBe("old-approved-build");
  } finally {
    await closeProfile(profile.context, profile.directory);
  }
});

test("schema migration rolls back when its gate checkpoint cannot advance", async () => {
  test.setTimeout(60_000);
  const profile = await openProfile();
  try {
    await profile.page.goto(`${baseURL}/dayforge-build.json`);
    const buildId = await profile.page.evaluate(async () => {
      const response = await fetch("/dayforge-build.json", { cache: "no-store" });
      return (await response.json()).build_id as string;
    });
    await createVersionOneVault(profile.page, {
      key: "build_gate",
      approved_build: "old-approved-build",
      target_build: buildId,
      update_epoch: updateEpoch,
      target_schema_version: 2,
      phase: "switching",
      schema_version: 1,
      revision: Number.MAX_SAFE_INTEGER,
    });
    await profile.page.goto(`${baseURL}/work`);
    await expect(profile.page.locator(".offline-build-gate")).toContainText(/revision is exhausted/i);
    const state = await readBuildGate(profile.page);
    expect(state.version).toBe(1);
    expect(state.gate).toMatchObject({
      approved_build: "old-approved-build",
      target_build: buildId,
      phase: "switching",
      schema_version: 1,
      revision: Number.MAX_SAFE_INTEGER,
    });
    expect(state.sentinel).toBe("local-vault-row");
    expect(state.diagnosticIndexes).not.toContain("by-owner-superseded");
    await assertVersionOneDraftDecrypts(profile.page);
  } finally {
    await closeProfile(profile.context, profile.directory);
  }
});

test("schema migration reports a blocked old tab and resumes after its connection closes", async () => {
  test.setTimeout(120_000);
  const profile = await openProfile();
  const blocker = await profile.context.newPage();
  try {
    await profile.page.goto(`${baseURL}/dayforge-build.json`);
    const buildId = await profile.page.evaluate(async () => {
      const response = await fetch("/dayforge-build.json", { cache: "no-store" });
      return (await response.json()).build_id as string;
    });
    await createVersionOneVault(profile.page, {
      key: "build_gate",
      approved_build: "old-approved-build",
      target_build: buildId,
      update_epoch: updateEpoch,
      target_schema_version: 2,
      phase: "switching",
      schema_version: 1,
      revision: 1,
    });
    await blocker.goto(`${baseURL}/dayforge-build.json`);
    await blocker.evaluate(async (databaseName) => {
      const request = indexedDB.open(databaseName, 1);
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      (window as unknown as { __dayforgeHeldVault?: IDBDatabase }).__dayforgeHeldVault = database;
    }, databaseName);

    await profile.page.goto(`${baseURL}/work`);
    await expect(profile.page.locator(".offline-build-gate"))
      .toContainText(/blocked by another open tab/i);
    await blocker.evaluate(() => {
      (window as unknown as { __dayforgeHeldVault?: IDBDatabase }).__dayforgeHeldVault?.close();
    });
    await expect.poll(async () => await profile.page.evaluate(async (databaseName) => await new Promise<number>((resolve, reject) => {
      const request = indexedDB.open(databaseName);
      request.onsuccess = () => { const database = request.result; const version = database.version; database.close(); resolve(version); };
      request.onerror = () => reject(request.error);
    }), databaseName), { timeout: 30_000 }).toBe(2);

    await profile.page.reload();
    await expect.poll(async () => {
      try {
        return await profile.page.evaluate(async ({ buildId, databaseName }) => await new Promise<boolean>((resolve, reject) => {
          const request = indexedDB.open(databaseName);
          request.onsuccess = () => {
            const database = request.result;
            const transaction = database.transaction(["build_gate"], "readonly");
            const gateRequest = transaction.objectStore("build_gate").get("build_gate");
            transaction.oncomplete = () => {
              const gate = gateRequest.result as Record<string, unknown> | undefined;
              const approved = database.version === 2 && gate?.phase === "running" && gate.approved_build === buildId;
              database.close();
              resolve(approved);
            };
            transaction.onerror = () => { database.close(); reject(transaction.error); };
          };
          request.onerror = () => reject(request.error);
        }), { buildId, databaseName });
      } catch {
        return false;
      }
    }, { timeout: 60_000 }).toBe(true);
  } finally {
    await blocker.close();
    await closeProfile(profile.context, profile.directory);
  }
});

test("authorized v1 to v2 migration checkpoints the gate before approving the new build", async () => {
  test.setTimeout(120_000);
  const profile = await openProfile();
  try {
    await profile.page.goto(`${baseURL}/dayforge-build.json`);
    const buildId = await profile.page.evaluate(async () => {
      const response = await fetch("/dayforge-build.json", { cache: "no-store" });
      return (await response.json()).build_id as string;
    });
    await createVersionOneVault(profile.page, {
      key: "build_gate",
      approved_build: "old-approved-build",
      target_build: buildId,
      update_epoch: updateEpoch,
      target_schema_version: 2,
      phase: "switching",
      schema_version: 1,
      revision: 1,
    });
    await profile.page.goto(`${baseURL}/work`);
    await expect.poll(async () => {
      try { return await profile.page.evaluate(async (expectedBuild) => {
      try {
        const request = indexedDB.open("dayforge-local");
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const transaction = database.transaction(["build_gate"], "readonly");
        const gate = await new Promise<Record<string, unknown>>((resolve, reject) => {
          const get = transaction.objectStore("build_gate").get("build_gate");
          get.onsuccess = () => resolve(get.result);
          get.onerror = () => reject(get.error);
        });
        const complete = database.version === 2 && gate.phase === "running" && gate.approved_build === expectedBuild && gate.schema_version === 2;
        database.close();
        return complete;
      } catch { return false; }
      }, buildId); } catch { return false; }
    }, { timeout: 60_000, intervals: [100, 250, 500, 1_000] }).toBe(true);
    const inspectionPage = await profile.context.newPage();
    await inspectionPage.goto(`${baseURL}/work`);
    await inspectionPage.locator("main").waitFor({ state: "visible" });
    const state = await readBuildGate(inspectionPage);
    expect(state.version).toBe(2);
    expect(state.gate).toMatchObject({ approved_build: buildId, target_build: null, phase: "running", schema_version: 2 });
    expect(state.diagnosticIndexes).toContain("by-owner-superseded");
    expect(state.sentinel).toBe("local-vault-row");
    await assertVersionOneDraftDecrypts(inspectionPage);
  } finally {
    await closeProfile(profile.context, profile.directory);
  }
});

test("schema checkpoint resumes after the app closes between migration commit and build approval", async () => {
  test.setTimeout(120_000);
  const profile = await openProfile();
  let context = profile.context;
  try {
    await profile.page.goto(`${baseURL}/dayforge-build.json`);
    const buildId = await profile.page.evaluate(async () => {
      const response = await fetch("/dayforge-build.json", { cache: "no-store" });
      return (await response.json()).build_id as string;
    });
    await createVersionOneVault(profile.page, {
      key: "build_gate",
      approved_build: "old-approved-build",
      target_build: buildId,
      update_epoch: updateEpoch,
      target_schema_version: 2,
      phase: "switching",
      schema_version: 1,
      revision: 1,
    });

    const activation = await profile.page.evaluate(async ({ buildId, updateEpoch }) => {
      const workerUrl = new URL("/sw.js", location.origin);
      workerUrl.searchParams.set("build", buildId);
      workerUrl.searchParams.set("schema", "2");
      const registration = await navigator.serviceWorker.register(workerUrl, { scope: "/", updateViaCache: "none" });
      await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 30_000;
        const check = () => {
          if (registration.waiting?.state === "installed") { resolve(); return; }
          if (registration.active?.state === "activated") { resolve(); return; }
          if (Date.now() >= deadline) { reject(new Error("Approved update worker did not install")); return; }
          setTimeout(check, 100);
        };
        check();
      });
      const worker = registration.waiting ?? registration.active;
      if (!worker) throw new Error("Approved update worker is unavailable");
      const channel = new MessageChannel();
      const result = new Promise<{ accepted?: boolean; updateEpoch?: string }>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Update worker did not answer the activation request")), 10_000);
        channel.port1.onmessage = (event) => { clearTimeout(timeout); resolve(event.data); };
      });
      worker.postMessage({ type: "DAYFORGE_SKIP_WAITING", updateEpoch }, [channel.port2]);
      return result;
    }, { buildId, updateEpoch });
    expect(activation).toEqual({ accepted: true, updateEpoch });

    await profile.page.addInitScript((databaseName) => {
      const originalOpen = IDBFactory.prototype.open;
      const windowState = window as typeof window & {
        __dayforgePauseSchemaSuccess?: boolean;
        __dayforgeSchemaCheckpointReached?: boolean;
      };
      windowState.__dayforgePauseSchemaSuccess = true;
      IDBFactory.prototype.open = function patchedOpen(name: string, version?: number): IDBOpenDBRequest {
        const request = originalOpen.call(this, name, version);
        if (name === databaseName && version === 2) {
          request.addEventListener("success", (event) => {
            if (!windowState.__dayforgePauseSchemaSuccess || request.result.version !== 2) return;
            windowState.__dayforgePauseSchemaSuccess = false;
            windowState.__dayforgeSchemaCheckpointReached = true;
            event.stopImmediatePropagation();
          }, { once: true });
        }
        return request;
      };
    }, databaseName);
    await profile.page.goto(`${baseURL}/work`);
    await expect.poll(() => profile.page.evaluate(() => Boolean(
      (window as typeof window & { __dayforgeSchemaCheckpointReached?: boolean }).__dayforgeSchemaCheckpointReached,
    )), { timeout: 60_000, intervals: [100, 250, 500, 1_000] }).toBe(true);

    const checkpoint = await readBuildGate(profile.page);
    expect(checkpoint.version).toBe(2);
    expect(checkpoint.gate).toMatchObject({
      approved_build: "old-approved-build",
      target_build: buildId,
      update_epoch: updateEpoch,
      phase: "switching",
      schema_version: 2,
    });
    expect(checkpoint.diagnosticIndexes).toContain("by-owner-superseded");
    expect(checkpoint.sentinel).toBe("local-vault-row");

    await context.close();
    context = await chromium.launchPersistentContext(profile.directory, {
      baseURL,
      headless: true,
      ignoreHTTPSErrors: true,
      serviceWorkers: "allow",
    });
    const resumedPage = context.pages()[0] ?? await context.newPage();
    await resumedPage.goto(`${baseURL}/work`);
    await expect.poll(async () => {
      try {
        const state = await readBuildGate(resumedPage);
        return state.version === 2 && state.gate?.phase === "running" &&
          state.gate.approved_build === buildId && state.gate.schema_version === 2;
      } catch { return false; }
    }, { timeout: 60_000, intervals: [100, 250, 500, 1_000] }).toBe(true);
    const resumed = await readBuildGate(resumedPage);
    expect(resumed.gate).toMatchObject({ approved_build: buildId, target_build: null, phase: "running", schema_version: 2 });
    expect(resumed.sentinel).toBe("local-vault-row");
    await assertVersionOneDraftDecrypts(resumedPage);
  } finally {
    await context.close();
    await rm(profile.directory, { recursive: true, force: true });
  }
});

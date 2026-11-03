"use strict";

const assert = require("node:assert/strict");
const { randomBytes, randomUUID } = require("node:crypto");
const { spawn, spawnSync } = require("node:child_process");
const { createServer } = require("node:net");
const http = require("node:http");
const { copyFile, mkdir, mkdtemp, rename, rm, stat } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require(path.join(__dirname, "..", "frontend", "node_modules", "@playwright", "test"));

const root = path.resolve(__dirname, "..");
const frontend = path.join(root, "frontend");
const nextDirectory = path.join(frontend, ".next");
const manifestPath = path.join(frontend, "public", "dayforge-build.json");
const nextCli = path.join(frontend, "node_modules", "next", "dist", "bin", "next");
const ownerId = randomUUID();
const recordId = "offline-update-draft-sentinel";
const keyId = randomUUID();
const vaultKeyBytes = randomBytes(32);
const noteSentinel = "offline-update-private-note-7f4e2a";
const titleSentinel = "offline-update-private-title-1c9b3d";
const tokenSentinel = "offline-update-private-token-6a2e5f";
const keySentinel = "offline-update-private-key-8d4c1a";
const pendingTitle = "offline-update-pending-plan-9a7c";
const uncertainPushTitle = "offline-update-lost-push-plan-2d8b";

function assertChildPath(parent, target) {
  const parentPath = path.resolve(parent);
  const targetPath = path.resolve(target);
  const relative = path.relative(parentPath, targetPath);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Refusing to manage a path outside its intended directory: ${targetPath}`);
  }
}

async function availablePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to select a local port");
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(check, label, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

function build(buildId) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "build-frontend.cjs")], {
    cwd: frontend,
    env: {
      ...process.env,
      API_INTERNAL_ORIGIN: "http://127.0.0.1:8000",
      DAYFORGE_BUILD_ID: buildId,
      DAYFORGE_OFFLINE_UPDATE_TEST_HARNESS: "1",
    },
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Production build ${buildId} failed with exit code ${result.status}`);
}

async function moveBuiltArtifact(destination) {
  await rename(nextDirectory, path.join(destination, ".next"));
  await rename(manifestPath, path.join(destination, "dayforge-build.json"));
}

async function installBuiltArtifact(source) {
  await rename(path.join(source, ".next"), nextDirectory);
  await copyFile(path.join(source, "dayforge-build.json"), manifestPath);
}

async function startServer(port) {
  const child = spawn(process.execPath, [nextCli, "start", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: frontend,
    env: {
      ...process.env,
      API_INTERNAL_ORIGIN: "http://127.0.0.1:8000",
      DAYFORGE_OFFLINE_UPDATE_TEST_HARNESS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { output = `${output}${chunk.toString()}`.slice(-4_000); });
  }
  const deadline = Date.now() + 60_000;
  let lastStatus = null;
  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`server exited with code ${child.exitCode}`);
      const response = await fetch(`http://127.0.0.1:${port}/dayforge-build.json`).catch(() => null);
      lastStatus = response?.status ?? null;
      if (response?.ok) return child;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error(`timed out (last manifest HTTP status: ${lastStatus ?? "no response"})`);
  } catch (error) {
    await stopServer(child).catch(() => undefined);
    throw new Error(`Next.js server did not start: ${error instanceof Error ? error.message : String(error)}\n${output}`);
  }
}

async function startProxy(port, upstreamPort) {
  const state = { failNextStaticAsset: false, failedStaticAssets: [], holdNextFlight: false, heldFlight: null, signalHeldFlight: null };
  const server = http.createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (state.failNextStaticAsset && pathname.startsWith("/_next/static/")) {
      state.failNextStaticAsset = false;
      state.failedStaticAssets.push(request.url ?? pathname);
      response.writeHead(503, { "cache-control": "no-store" });
      response.end("Injected offline-update asset failure");
      return;
    }
    const upstream = http.request({
      hostname: "127.0.0.1",
      port: upstreamPort,
      path: request.url,
      method: request.method,
      headers: {
        ...request.headers,
        host: `127.0.0.1:${upstreamPort}`,
        "x-forwarded-host": request.headers.host ?? "",
      },
    }, (upstreamResponse) => {
      upstreamResponse.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end("Upstream response failed");
      });
      response.on("error", () => upstream.destroy());
      if (state.holdNextFlight && (request.url ?? "").includes("_rsc=")) {
        state.holdNextFlight = false;
        state.heldFlight = { request, response, upstreamResponse };
        state.signalHeldFlight?.();
        state.signalHeldFlight = null;
        return;
      }
      response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });
    upstream.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end("Upstream server unavailable");
    });
    request.on("error", () => upstream.destroy());
    request.pipe(upstream);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return {
    server,
    failedStaticAssets: state.failedStaticAssets,
    failNextStaticAsset() { state.failNextStaticAsset = true; },
    holdNextFlightResponse() {
      if (state.holdNextFlight || state.heldFlight) throw new Error("A Flight response is already held");
      state.holdNextFlight = true;
      return new Promise((resolve) => { state.signalHeldFlight = resolve; });
    },
    releaseHeldFlightResponse() {
      const held = state.heldFlight;
      if (!held) throw new Error("No in-flight Flight response is held");
      state.heldFlight = null;
      held.response.writeHead(held.upstreamResponse.statusCode ?? 502, held.upstreamResponse.headers);
      held.upstreamResponse.pipe(held.response);
    },
  };
}

async function stopProxy(proxy) {
  if (!proxy?.server.listening) return;
  await new Promise((resolve, reject) => proxy.server.close((error) => error ? reject(error) : resolve()));
}

async function startUpdateApiStub(ownerId) {
  const nowIso = () => new Date().toISOString();
  const state = {
    authenticated: false,
    ownerId,
    epoch: randomUUID(),
    groups: [],
    receipts: new Map(),
    expectedPush: null,
    requests: [],
    pushBodies: [],
    pushWaiters: [],
    holdResponsesRemaining: 0,
    heldResponses: [],
  };
  const sendJson = (response, status, value, contentType = "application/json") => {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { "Cache-Control": "no-store", "Content-Type": contentType });
    response.end(JSON.stringify(value));
  };
  const readBody = async (request) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString("utf8");
  };
  const pageAfter = (cursor) => {
    const throughCursor = state.groups.at(-1)?.cursor ?? cursor;
    const groups = state.groups.filter((group) => BigInt(group.cursor) > BigInt(cursor));
    return {
      epoch: state.epoch,
      through_cursor: throughCursor,
      next_cursor: groups.at(-1)?.cursor ?? throughCursor,
      has_more: false,
      next_page_token: null,
      groups,
    };
  };
  const server = http.createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1:8000");
      state.requests.push(`${request.method} ${url.pathname}`);
      if (url.pathname === "/api/v1/auth/session" && request.method === "GET") {
        if (!state.authenticated) {
          sendJson(response, 401, { code: "authentication_required", title: "Authentication required", status: 401 }, "application/problem+json");
          return;
        }
        const timestamp = nowIso();
        sendJson(response, 200, {
          authenticated: true,
          owner: { id: ownerId, email: "offline-update@example.test", email_verified_at: timestamp },
          session: {
            id: randomUUID(),
            remember_me: false,
            idle_expires_at: new Date(Date.now() + 30 * 60_000).toISOString(),
            absolute_expires_at: new Date(Date.now() + 24 * 60 * 60_000).toISOString(),
            password_authenticated_at: timestamp,
          },
          csrf_token: "a".repeat(43),
          server_time: timestamp,
          logout_ticket: null,
        });
        return;
      }
      if (url.pathname === "/api/v1/version" && request.method === "GET") {
        sendJson(response, 200, {
          api_major: 1,
          protocol_versions: [1],
          reducer_versions: [1],
          server_time: nowIso(),
          limits: {
            push_operations: 100,
            push_request_bytes: 8_388_608,
            operation_bytes: 2_097_152,
            commands_per_operation: 1_000,
            page_operations: 200,
            page_bytes: 8_388_608,
            page_token_ttl_seconds: 1_800,
          },
        });
        return;
      }
      if (url.pathname === "/api/v1/sync/clock" && request.method === "GET") {
        const serverTimeMs = Date.now();
        sendJson(response, 200, {
          calibration_id: randomUUID(),
          server_time_ms: serverTimeMs,
          server_time: new Date(serverTimeMs).toISOString(),
          max_future_skew_ms: 300_000,
        });
        return;
      }
      if (url.pathname === "/api/v1/sync/push" && request.method === "POST") {
        const body = await readBody(request);
        const parsed = JSON.parse(body);
        if (!parsed || !Array.isArray(parsed.operations) || parsed.operations.length === 0) {
          sendJson(response, 400, { code: "invalid_push", title: "Invalid push", status: 400 }, "application/problem+json");
          return;
        }
        state.pushBodies.push(body);
        for (const waiter of [...state.pushWaiters]) {
          if (state.pushBodies.length >= waiter.target) waiter.resolve();
        }
        state.pushWaiters = state.pushWaiters.filter((waiter) => state.pushBodies.length < waiter.target);
        const results = [];
        for (const operation of parsed.operations) {
          let receipt = state.receipts.get(operation.operation_id);
          const duplicate = Boolean(receipt);
          const expected = state.expectedPush;
          if (!receipt) {
            if (!expected || expected.operationId !== operation.operation_id) {
              sendJson(response, 409, { code: "unexpected_operation", title: "Unexpected operation", status: 409 }, "application/problem+json");
              return;
            }
            const cursor = (BigInt(state.groups.at(-1)?.cursor ?? "0") + 1n).toString();
            receipt = {
              operation_id: operation.operation_id,
              request_hash: expected.requestHash,
              recorded: true,
              commit_cursor: cursor,
              effect_at_commit: "applied",
              reason_at_commit: null,
            };
            state.receipts.set(operation.operation_id, receipt);
            state.groups.push({ cursor, committed_at: nowIso(), operation });
          }
          results.push({ operation_id: operation.operation_id, status: duplicate ? "duplicate" : "recorded", receipt });
        }
        const payload = { epoch: state.epoch, head_cursor: state.groups.at(-1)?.cursor ?? "0", results };
        if (state.holdResponsesRemaining > 0) {
          state.holdResponsesRemaining -= 1;
          await new Promise((resolve) => state.heldResponses.push({ response, payload, resolve }));
        }
        sendJson(response, 200, payload);
        return;
      }
      if ((url.pathname === "/api/v1/sync/pull" || url.pathname === "/api/v1/sync/bootstrap") && request.method === "GET") {
        if (url.pathname.endsWith("/pull") && url.searchParams.get("epoch") !== state.epoch) {
          sendJson(response, 409, { code: "cursor_epoch_mismatch", title: "Epoch changed", status: 409 }, "application/problem+json");
          return;
        }
        const after = url.pathname.endsWith("/pull") ? url.searchParams.get("after") ?? "0" : "0";
        sendJson(response, 200, pageAfter(after));
        return;
      }
      sendJson(response, 404, { code: "not_found", title: "Not found", status: 404 }, "application/problem+json");
    })().catch((error) => {
      sendJson(response, 500, { code: "test_api_error", title: error instanceof Error ? error.message : "Test API error", status: 500 }, "application/problem+json");
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(8000, "127.0.0.1", resolve);
  });
  return {
    server,
    epoch: state.epoch,
    enableSession() { state.authenticated = true; },
    setRecordedFixture(fixture) {
      const cursor = fixture.commitCursor;
      const receipt = {
        operation_id: fixture.operation.operation_id,
        request_hash: fixture.requestHash,
        recorded: true,
        commit_cursor: cursor,
        effect_at_commit: "applied",
        reason_at_commit: null,
      };
      state.receipts.set(fixture.operation.operation_id, receipt);
      state.groups.push({ cursor, committed_at: nowIso(), operation: fixture.operation });
    },
    expectPush(operationId, requestHash) { state.expectedPush = { operationId, requestHash }; },
    holdNextPushResponses(count) { state.holdResponsesRemaining = count; },
    waitForPushCount(target, timeoutMs = 30_000) {
      if (state.pushBodies.length >= target) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error(`Timed out waiting for ${target} sync push requests`)), timeoutMs);
        state.pushWaiters.push({
          target,
          resolve: () => { clearTimeout(timeout); resolve(); },
        });
      });
    },
    releaseHeldPushResponses() {
      for (const held of state.heldResponses.splice(0)) {
        held.resolve();
      }
    },
    pushStats() {
      return {
        requestCount: state.pushBodies.length,
        requests: [...state.requests],
        requestBodies: [...state.pushBodies],
        recordedOperationIds: [...state.receipts.keys()],
        groupCursors: state.groups.map((group) => group.cursor),
      };
    },
  };
}

async function stopServer(child) {
  if (child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Next.js test server did not stop")), 10_000);
    child.once("exit", () => {
      clearTimeout(timeout);
      resolve();
    });
    child.kill();
  });
}

async function readGate(page) {
  return page.evaluate(async () => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("dayforge-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(["build_gate"], "readonly");
        const request = transaction.objectStore("build_gate").get("build_gate");
        transaction.oncomplete = () => resolve(request.result ?? null);
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
  });
}

async function seedEncryptedRows(page) {
  return page.evaluate(async ({ ownerId, recordId, keyId, keyBytes, noteSentinel, titleSentinel, tokenSentinel, keySentinel }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("dayforge-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const rawKey = Uint8Array.from(keyBytes);
      const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt"]);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const additionalData = new TextEncoder().encode(`${ownerId}|drafts|${recordId}|v1`);
      const ciphertext = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv, additionalData, tagLength: 128 },
        key,
        new TextEncoder().encode(JSON.stringify({ note: noteSentinel, title: titleSentinel, token: tokenSentinel, key: keySentinel })),
      );
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(["drafts"], "readwrite");
        transaction.objectStore("drafts").put({
          id: `${ownerId}:${recordId}`,
          owner_id: ownerId,
          record_id: recordId,
          key_id: keyId,
          iv: iv.buffer,
          ciphertext,
        });
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      return Array.from(new Uint8Array(ciphertext));
    } finally {
      database.close();
    }
  }, { ownerId, recordId, keyId, keyBytes: [...vaultKeyBytes], noteSentinel, titleSentinel, tokenSentinel, keySentinel });
}

async function readEncryptedDraft(page) {
  return page.evaluate(async ({ ownerId, recordId, keyBytes, noteSentinel, titleSentinel, tokenSentinel, keySentinel }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("dayforge-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const row = await new Promise((resolve, reject) => {
        const transaction = database.transaction(["drafts"], "readonly");
        const request = transaction.objectStore("drafts").get(`${ownerId}:${recordId}`);
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
      });
      if (!row) throw new Error("Encrypted draft disappeared during build update");
      const rawKey = Uint8Array.from(keyBytes);
      const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
      const additionalData = new TextEncoder().encode(`${ownerId}|drafts|${recordId}|v1`);
      const plaintext = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: row.iv, additionalData, tagLength: 128 }, key, row.ciphertext,
      );
      if (new TextDecoder().decode(plaintext) !== JSON.stringify({
        note: noteSentinel,
        title: titleSentinel,
        token: tokenSentinel,
        key: keySentinel,
      })) {
        throw new Error("Encrypted draft changed during build update");
      }
      return Array.from(new Uint8Array(row.ciphertext));
    } finally {
      database.close();
    }
  }, { ownerId, recordId, keyBytes: [...vaultKeyBytes], noteSentinel, titleSentinel, tokenSentinel, keySentinel });
}

async function readPendingOutboxOperation(page, operationId) {
  return page.evaluate(async ({ ownerId, operationId }) => {
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("dayforge-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const row = await new Promise((resolve, reject) => {
        const transaction = database.transaction(["outbox"], "readonly");
        const request = transaction.objectStore("outbox").get(`${ownerId}:${operationId}`);
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = () => reject(transaction.error);
      });
      if (!row) return null;
      return {
        id: row.id,
        owner_id: row.owner_id,
        record_id: row.record_id,
        state: row.state,
        request_hash: row.request_hash,
        superseded_by: row.superseded_by,
        iv: Array.from(new Uint8Array(row.iv)),
        ciphertext: Array.from(new Uint8Array(row.ciphertext)),
      };
    } finally {
      database.close();
    }
  }, { ownerId, operationId });
}

async function cachedBuildReady(page, buildId) {
  return page.evaluate(async (expectedBuild) => {
    const cache = await caches.open(`dayforge-shell:${expectedBuild}`);
    const ready = await cache.match("/__dayforge_shell_ready__");
    return Boolean(ready && ready.headers.get("X-Dayforge-Build") === expectedBuild &&
      await ready.text() === expectedBuild);
  }, buildId);
}

async function runIndexedDbQuotaScenario(baseURL) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL, serviceWorkers: "block" });
  const page = await context.newPage();
  const origin = new URL(baseURL).origin;
  const quotaSession = await context.newCDPSession(page);
  const testOwnerId = randomUUID();
  const testKeyId = randomUUID();
  const testKeyBytes = randomBytes(32);
  try {
    await page.goto(`${baseURL}/dayforge-build.json`);
    await quotaSession.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: 256 * 1024 });
    await page.goto(`${baseURL}/offline-update`);
    await page.getByRole("heading", { name: "Offline update mutation harness" }).waitFor({ state: "visible" });
    await page.evaluate((input) => window.__dayforgeOfflineUpdateHarness.initializeVault(
      input.ownerId, input.keyId, input.keyBytes,
    ), { ownerId: testOwnerId, keyId: testKeyId, keyBytes: [...testKeyBytes] });
    const before = await page.evaluate((owner) => window.__dayforgeOfflineUpdateHarness.inspectQuotaVault(owner), testOwnerId);
    let failure = null;
    try {
      await page.evaluate((owner) => window.__dayforgeOfflineUpdateHarness.createQuotaPressureMutation(owner), testOwnerId);
    } catch (error) {
      failure = error;
    }
    assert(failure, "a large valid owner mutation must hit the constrained IndexedDB quota");
    assert.match(String(failure.message), /QuotaExceededError|quota/i,
      "the constrained browser must report a real IndexedDB quota error");
    const after = await page.evaluate((owner) => window.__dayforgeOfflineUpdateHarness.inspectQuotaVault(owner), testOwnerId);
    assert.deepEqual(after, before,
      "IndexedDB quota failure must atomically preserve owner revision, outbox, and projection rows");
    console.log("A fresh production harness origin returned QuotaExceededError for a valid oversized local mutation; owner revision/outbox/projection remained unchanged.");
  } finally {
    await quotaSession.send("Storage.overrideQuotaForOrigin", { origin, quotaSize: 1_000_000_000 }).catch(() => undefined);
    await quotaSession.detach().catch(() => undefined);
    await context.close();
    await browser.close();
  }
}

async function updateDiagnostics(page, pendingRequests = []) {
  const gate = await readGate(page).catch((error) => ({ read_error: error.message }));
  const browser = await page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration("/");
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open("dayforge-local");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    let vault = null;
    try {
      vault = await new Promise((resolve, reject) => {
        const transaction = database.transaction(["owner_meta", "auth_state"], "readonly");
        const metadataRequest = transaction.objectStore("owner_meta").getAll();
        const authRequest = transaction.objectStore("auth_state").getAll();
        transaction.oncomplete = () => resolve({
          owners: metadataRequest.result.map((entry) => entry.owner_id),
          auth: authRequest.result.map((entry) => ({ owner_id: entry.owner_id, locked: entry.locked, has_crypto_key: Boolean(entry.crypto_key) })),
        });
        transaction.onerror = () => reject(transaction.error);
      });
    } finally {
      database.close();
    }
    let session = null;
    try {
      const response = await fetch("/api/v1/auth/session", { cache: "no-store", credentials: "same-origin" });
      const payload = await response.json().catch(() => null);
      session = { status: response.status, authenticated: payload?.authenticated ?? null, owner_id: payload?.owner?.id ?? null };
    } catch (error) {
      session = { error: error instanceof Error ? error.message : String(error) };
    }
    return {
      url: location.href,
      session,
      vault,
      controller: navigator.serviceWorker.controller?.scriptURL ?? null,
      active: registration?.active ? { url: registration.active.scriptURL, state: registration.active.state } : null,
      waiting: registration?.waiting ? { url: registration.waiting.scriptURL, state: registration.waiting.state } : null,
      installing: registration?.installing ? { url: registration.installing.scriptURL, state: registration.installing.state } : null,
      cacheKeys: await caches.keys(),
    };
  }).catch((error) => ({ browser_error: error.message }));
  const text = await page.locator("body").innerText().catch((error) => error.message);
  return { gate, browser, text, pendingRequests };
}

async function assertNoPrivateCacheContent(page) {
  const privateSentinels = [ownerId, vaultKeyBytes.toString("base64url"), noteSentinel, titleSentinel, tokenSentinel, keySentinel, pendingTitle];
  const leaks = await page.evaluate(async ({ privateSentinels }) => {
    const found = [];
    for (const cacheName of await caches.keys()) {
      const cache = await caches.open(cacheName);
      for (const request of await cache.keys()) {
        const response = await cache.match(request);
        if (!response) continue;
        const type = response.headers.get("Content-Type") ?? "";
        if (!/(?:text\/|javascript|json|xml)/i.test(type)) continue;
        const body = await response.clone().text();
        if (privateSentinels.some((sentinel) => body.includes(sentinel))) found.push(new URL(request.url).pathname);
      }
    }
    return found;
  }, { privateSentinels });
  assert.deepEqual(leaks, [], "shared build caches must not contain private owner, title, token, key, or note data");
}

async function runBrowserScenario(baseURL, buildA, buildB, switchToBuildB, failNextStaticAsset, failedStaticAssets,
  holdNextFlightResponse, releaseHeldFlightResponse, apiStub) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    baseURL,
    ignoreHTTPSErrors: true,
    serviceWorkers: "allow",
  });
  let page = context.pages()[0] ?? await context.newPage();
  const pendingRequests = new Map();
  const monitorPage = (monitoredPage) => {
    monitoredPage.on("request", (request) => pendingRequests.set(request.url(), Date.now()));
    monitoredPage.on("requestfinished", (request) => pendingRequests.delete(request.url()));
    monitoredPage.on("requestfailed", (request) => pendingRequests.delete(request.url()));
    monitoredPage.on("response", (response) => {
      if (response.status() >= 500) console.error(`Browser HTTP ${response.status()}: ${response.url()}`);
    });
    monitoredPage.on("console", (message) => {
      if (message.type() === "error" && !message.text().includes("401 (Unauthorized)")) {
        console.error(`Browser console error: ${message.text()}`);
      }
    });
    monitoredPage.on("pageerror", (error) => console.error(`Browser page error: ${error.message}`));
  };
  monitorPage(page);
  try {
    await page.goto(`${baseURL}/work`);
    await page.locator("main").waitFor({ state: "visible" });
    await waitFor(async () => (await readGate(page))?.approved_build === buildA, "build A gate initialization");
    await waitFor(() => cachedBuildReady(page, buildA), "build A offline shell");
    await page.goto(`${baseURL}/offline-update`);
    await page.getByRole("heading", { name: "Offline update mutation harness" }).waitFor({ state: "visible" });
    await waitFor(() => page.evaluate(() => typeof window.__dayforgeOfflineUpdateHarness?.createPendingPlan === "function"),
      "production mutation harness");
    await context.setOffline(true);
    const createdPendingOperation = await page.evaluate((input) =>
      window.__dayforgeOfflineUpdateHarness.createPendingPlan(input.name, input.ownerId, input.keyId, input.keyBytes),
    { name: pendingTitle, ownerId, keyId, keyBytes: [...vaultKeyBytes] });
    assert.equal(createdPendingOperation.state, "queued", "the actual mutation API must leave its operation pending");
    assert.equal(createdPendingOperation.planNamePresent, true, "the actual mutation API must update the local projection");
    const originalCiphertext = await seedEncryptedRows(page);
    const queuedPendingOperation = await readPendingOutboxOperation(page, createdPendingOperation.operationId);
    assert.equal(queuedPendingOperation.state, "queued", "the mutation API must initially leave its operation pending");
    assert.equal(queuedPendingOperation.request_hash, createdPendingOperation.requestHash,
      "the pending operation must carry the hash returned by the mutation API");
    const uncertainPushOperation = await page.evaluate((input) =>
      window.__dayforgeOfflineUpdateHarness.createPendingPlan(input.name, input.ownerId, input.keyId, input.keyBytes),
    { name: uncertainPushTitle, ownerId, keyId, keyBytes: [...vaultKeyBytes] });
    const queuedUncertainPushOperation = await readPendingOutboxOperation(page, uncertainPushOperation.operationId);
    assert.equal(queuedUncertainPushOperation.state, "queued", "a second actual mutation must be ready for sync");
    const acknowledgedFixture = await page.evaluate((input) => window.__dayforgeOfflineUpdateHarness.acknowledgePendingOperationForUpdateTest(
      input.ownerId, input.operationId, input.serverEpoch,
    ), { ownerId, operationId: createdPendingOperation.operationId, serverEpoch: apiStub.epoch });
    apiStub.setRecordedFixture(acknowledgedFixture);
    apiStub.expectPush(uncertainPushOperation.operationId, uncertainPushOperation.requestHash);
    const originalPendingOperation = await readPendingOutboxOperation(page, createdPendingOperation.operationId);
    assert.equal(originalPendingOperation.state, "ack_waiting_pull",
      "the update scenario must retain an acknowledged operation until its matching pull is committed");

    await page.goto(`${baseURL}/work`);
    await page.locator("main").waitFor({ state: "visible" });

    const secondPage = await context.newPage();
    await secondPage.goto(`${baseURL}/work`);
    await secondPage.locator("main").waitFor({ state: "visible" });
    await waitFor(async () => (await readGate(secondPage))?.approved_build === buildA, "second tab build A gate initialization");
    await waitFor(() => cachedBuildReady(secondPage, buildA), "second tab build A offline shell");
    assert.deepEqual(await readPendingOutboxOperation(secondPage, createdPendingOperation.operationId), originalPendingOperation,
      "a new offline tab must read the operation created through the local mutation API");
    assert.deepEqual(await readPendingOutboxOperation(secondPage, uncertainPushOperation.operationId), queuedUncertainPushOperation,
      "a new offline tab must read the second operation from the same encrypted owner outbox");
    await context.setOffline(false);

    await secondPage.evaluate(() => {
      const dirty = document.createElement("div");
      dirty.id = "offline-update-dirty-sentinel";
      dirty.contentEditable = "true";
      dirty.dataset.dayforgeDirty = "true";
      dirty.textContent = "unsaved test input";
      document.body.append(dirty);
    });

    await switchToBuildB();
    failNextStaticAsset();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await page.getByText(/Không thể chuẩn bị bản offline/i).waitFor({ state: "visible", timeout: 30_000 });
    assert.equal((await readGate(page))?.approved_build, buildA, "a failed worker install must keep build A approved");
    assert(await cachedBuildReady(page, buildA), "build A shell must remain available after build B install fails");
    assert.equal(failedStaticAssets.length, 1, "the proxy must fail exactly one real build asset request");
    assert(failedStaticAssets[0].startsWith("/_next/static/"), "the injected failure must target a build asset");
    const cachesAfterFailedInstall = await page.evaluate(async () => await caches.keys());
    assert(cachesAfterFailedInstall.includes(`dayforge-shell:${buildA}`), "failed install must preserve the active build A cache");
    assert(!cachesAfterFailedInstall.includes(`dayforge-shell:${buildB}`), "failed install must remove its incomplete build B cache");
    console.log("An injected build B asset failure left build A approved and removed only the incomplete build B cache.");

    const quotaSession = await context.newCDPSession(page);
    const installFailureCount = await page.evaluate(() => {
      window.__dayforgeInstallFailureCount = 0;
      navigator.serviceWorker.addEventListener("message", (event) => {
        if (event.data?.type === "DAYFORGE_INSTALL_FAILED") window.__dayforgeInstallFailureCount += 1;
      });
      return window.__dayforgeInstallFailureCount;
    });
    await quotaSession.send("Storage.overrideQuotaForOrigin", { origin: new URL(baseURL).origin, quotaSize: 1 });
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await waitFor(async () => page.evaluate((previousCount) =>
      window.__dayforgeInstallFailureCount > previousCount, installFailureCount),
    "the service worker install to fail under a constrained Cache Storage quota", 30_000);
    assert.equal((await readGate(page))?.approved_build, buildA, "a quota failure must keep build A approved");
    assert(await cachedBuildReady(page, buildA), "build A shell must survive a quota failure");
    const cachesAfterQuotaFailure = await page.evaluate(async () => await caches.keys());
    assert(!cachesAfterQuotaFailure.includes(`dayforge-shell:${buildB}`), "quota failure must discard the incomplete build B cache");
    console.log("A constrained origin quota failed build B install without changing build A approval or cache.");
    await quotaSession.send("Storage.overrideQuotaForOrigin", { origin: new URL(baseURL).origin, quotaSize: 1_000_000_000 });
    await quotaSession.detach();

    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await waitFor(async () => page.evaluate(async (expectedBuild) => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const worker = registration?.waiting;
      if (!worker) return false;
      return new URL(worker.scriptURL).searchParams.get("build") === expectedBuild;
    }, buildB), "build B waiting worker");

    const flightProbe = await page.evaluate(async () => {
      const response = await fetch("/work?_rsc=offline-update-gate-probe", {
        cache: "no-store",
        headers: { RSC: "1", Accept: "text/x-component", "Next-Router-Prefetch": "1" },
      });
      return {
        status: response.status,
        build: response.headers.get("X-Dayforge-Build"),
        offlineNavigation: response.headers.get("X-Dayforge-Offline-Navigation"),
      };
    });
    assert.deepEqual(flightProbe, { status: 409, build: buildA, offlineNavigation: "document" },
      "the B Flight response must be rejected while build A remains approved");
    await page.reload();
    await page.locator("main").waitFor({ state: "visible" });
    const gateAfterPrematureReload = await readGate(page);
    assert.equal(gateAfterPrematureReload?.approved_build, buildA, "a reload before handshake must remain pinned to build A");
    assert.equal(gateAfterPrematureReload?.phase, "running", "a reload must not start migration before explicit update consent");
    console.log("The B Flight response and a direct reload stayed pinned to build A before the update handshake.");

    let updateButton = page.getByRole("button", { name: "Cập nhật" });
    await updateButton.waitFor({ state: "visible" });
    await updateButton.click();
    await page.getByText(/update was deferred/i).waitFor({ state: "visible" });
    console.log("Build A correctly deferred the update when a second tab contained unsaved input.");
    assert.equal((await readGate(page))?.approved_build, buildA, "dirty tab must keep build A approved");
    assert.equal((await readGate(secondPage))?.approved_build, buildA, "dirty second tab must keep build A approved");
    assert.deepEqual(await readEncryptedDraft(page), originalCiphertext, "deferred update must preserve encrypted draft bytes");
    assert.deepEqual(await readPendingOutboxOperation(page, createdPendingOperation.operationId), originalPendingOperation,
      "deferring an update must preserve the pending operation bytes and metadata");
    assert.deepEqual(await readPendingOutboxOperation(page, uncertainPushOperation.operationId), queuedUncertainPushOperation,
      "deferring an update must preserve the queued retry candidate bytes and metadata");

    await secondPage.locator("#offline-update-dirty-sentinel").evaluate((element) => element.remove());
    apiStub.enableSession();
    apiStub.holdNextPushResponses(2);
    await page.reload();
    await secondPage.reload();
    await page.locator("main").waitFor({ state: "visible" });
    await secondPage.locator("main").waitFor({ state: "visible" });
    await waitFor(async () => {
      const gate = await readGate(page);
      return gate?.phase === "running" && gate.approved_build === buildA;
    }, "build A ready for the suspended-tab handshake case");
    updateButton = page.getByRole("button", { name: "Cập nhật" });
    await updateButton.waitFor({ state: "visible" });
    try {
      await apiStub.waitForPushCount(1);
    } catch (error) {
      throw new Error(`Coordinator did not issue its first held push: ${error.message}; API=${JSON.stringify(apiStub.pushStats())}; browser=${JSON.stringify(await updateDiagnostics(page, [...pendingRequests.keys()]))}`);
    }
    const uncertainOperationSending = await readPendingOutboxOperation(page, uncertainPushOperation.operationId);
    assert.equal(uncertainOperationSending.state, "sending",
      "the sync coordinator must have a push in flight after the test API has committed and held its response");
    assert.equal(apiStub.pushStats().groupCursors.length, 2,
      "the held push response must follow a durable test-server commit of the uncertain operation");

    await secondPage.evaluate(() => {
      const suppressHandshake = (event) => {
        if (event.data?.type === "DAYFORGE_PREPARE_CLIENT") {
          event.stopImmediatePropagation();
          window.__silentUpdateEpoch = event.data.updateEpoch;
          const drains = [];
          window.dispatchEvent(new CustomEvent("dayforge:pause-writers", {
            detail: { updateEpoch: event.data.updateEpoch, waitUntil: (promise) => drains.push(Promise.resolve(promise)) },
          }));
          void Promise.all(drains).then(() => { window.__silentTabWritersDrained = true; }).catch(() => undefined);
          event.ports?.[0]?.close();
          return;
        }
        if (event.data?.type === "DAYFORGE_RESUME_CLIENT" && event.data.updateEpoch === window.__silentUpdateEpoch) {
          event.stopImmediatePropagation();
          window.__silentUpdateEpoch = null;
          window.dispatchEvent(new CustomEvent("dayforge:resume-writers", { detail: { updateEpoch: event.data.updateEpoch } }));
        }
      };
      window.__suppressUpdateHandshake = suppressHandshake;
      window.__silentTabWritersDrained = false;
      navigator.serviceWorker.addEventListener("message", suppressHandshake, true);
    });
    await updateButton.click();
    await waitFor(async () => (await readGate(page))?.phase === "preparing", "nonresponding-tab handshake begins");
    await waitFor(async () => {
      const gate = await readGate(page);
      return gate?.phase === "running" && gate.approved_build === buildA;
    }, "nonresponding tab times out and cancels preparation", 25_000);
    await page.getByText(/did not respond|update was deferred/i).waitFor({ state: "visible", timeout: 25_000 });
    const gateAfterSuspendedTab = await readGate(page);
    assert.equal(gateAfterSuspendedTab?.phase, "running",
      "a tab that does not respond during the update handshake must cancel preparation and keep the old build running");
    assert.equal(gateAfterSuspendedTab?.approved_build, buildA,
      "a nonresponding tab must not be treated as consent to switch builds");
    await secondPage.evaluate(() => navigator.serviceWorker.removeEventListener(
      "message", window.__suppressUpdateHandshake, true,
    ));
    console.log("A tab that did not respond during the update handshake caused preparation to time out; build A stayed approved.");
    await apiStub.waitForPushCount(2);
    const uncertainOperationRetry = await readPendingOutboxOperation(page, uncertainPushOperation.operationId);
    assert.equal(uncertainOperationRetry.state, "sending",
      "the operation whose first push response was lost must remain active for the identical retry");
    const retryStats = apiStub.pushStats();
    assert.equal(retryStats.requestBodies[0], retryStats.requestBodies[1],
      "a response lost during update deferral must retry the identical serialized operation envelope");
    await waitFor(async () => page.evaluate(async (expectedBuild) => {
      const registration = await navigator.serviceWorker.getRegistration("/");
      const worker = registration?.waiting;
      return Boolean(worker && new URL(worker.scriptURL).searchParams.get("build") === expectedBuild);
    }, buildB), "build B remains waiting after the suspended-tab deferral");

    await page.evaluate(() => {
      window.__updateWriterDrainFinished = false;
      window.__updatePauseWaitUntilObserved = false;
      window.addEventListener("dayforge:pause-writers", (event) => {
        const waitUntil = event.detail?.waitUntil;
        if (typeof waitUntil !== "function") return;
        window.__updatePauseWaitUntilObserved = true;
        waitUntil(new Promise((resolve) => window.setTimeout(() => {
          window.__updateWriterDrainFinished = true;
          resolve();
        }, 750)));
      }, { once: true });
      const originalPostMessage = ServiceWorker.prototype.postMessage;
      let heldRequest = null;
      window.__releasePrepareRequest = () => {
        if (!heldRequest) throw new Error("No build preparation request is being held");
        const [worker, message, transfer] = heldRequest;
        heldRequest = null;
        originalPostMessage.call(worker, message, transfer);
      };
      ServiceWorker.prototype.postMessage = function (message, transfer) {
        if (message?.type === "DAYFORGE_PREPARE_UPDATE" && !heldRequest) {
          heldRequest = [this, message, transfer];
          return;
        }
        return originalPostMessage.call(this, message, transfer);
      };
    });
    await updateButton.click();
    await waitFor(async () => (await readGate(page))?.phase === "preparing", "durable build preparation gate");
    await waitFor(() => page.evaluate(() => typeof window.__releasePrepareRequest === "function"), "held build preparation request");

    const thirdPage = await context.newPage();
    await thirdPage.goto(`${baseURL}/work`);
    await waitFor(async () => (await readGate(thirdPage))?.phase === "preparing", "third tab joins the preparation gate");
    await thirdPage.getByText("Các tab đang dừng ghi để chuẩn bị cập nhật.").waitFor({ state: "visible" });
    assert.equal((await readGate(thirdPage))?.approved_build, buildA, "late tab must remain gated on the approved build during preparation");

    const flightPath = "/work?_rsc=offline-update-inflight-switch";
    const flightHeld = holdNextFlightResponse();
    const inFlightResponse = page.waitForResponse((response) => response.url().includes("offline-update-inflight-switch"), { timeout: 30_000 });
    await page.evaluate((url) => {
      void fetch(url, {
        cache: "no-store",
        headers: { RSC: "1", Accept: "text/x-component", "Next-Router-Prefetch": "1" },
      }).catch(() => undefined);
    }, flightPath);
    await flightHeld;

    await page.evaluate(() => window.__releasePrepareRequest());
    await page.waitForTimeout(100);
    const gateWhileWriterDrains = await readGate(page);
    assert.equal(gateWhileWriterDrains?.phase, "preparing",
      "the update must remain in preparing until the in-flight writer drain promise resolves");
    assert.equal(await page.evaluate(() => window.__updatePauseWaitUntilObserved), true,
      "the page handshake must expose and observe a writer drain callback");
    assert.equal(await page.evaluate(() => window.__updateWriterDrainFinished), false,
      "the simulated writer must still be active before its drain delay completes");
    await waitFor(async () => (await readGate(page))?.phase === "switching", "durable build switching gate");
    assert.equal(await page.evaluate(() => window.__updateWriterDrainFinished), true,
      "build switching must wait until the writer drain promise resolves");
    const switchingDiagnostics = await updateDiagnostics(page, [...pendingRequests.keys()]);
    assert.equal(switchingDiagnostics.gate?.phase, "switching", "accepted update should durably enter switching before restart");
    assert.equal(switchingDiagnostics.gate?.approved_build, buildA, "build A stays approved until build B activates");
    assert.deepEqual(await readPendingOutboxOperation(page, createdPendingOperation.operationId), originalPendingOperation,
      "the ACK-waiting operation must remain byte-identical up to the build switching boundary");
    assert.deepEqual(await readPendingOutboxOperation(page, uncertainPushOperation.operationId), uncertainOperationRetry,
      "an uncertain in-flight push must remain byte-identical while the update switches");
    releaseHeldFlightResponse();
    const switchedFlightResponse = await inFlightResponse;
    assert.equal(switchedFlightResponse.status(), 409,
      "a B Flight response already in flight at switching must be rejected for the still-approved A document");
    assert.equal(switchedFlightResponse.headers()["x-dayforge-build"], buildA,
      "the in-flight Flight rejection must carry the approved A build marker");
    assert.equal(switchedFlightResponse.headers()["x-dayforge-offline-navigation"], "document",
      "the incompatible in-flight Flight response must direct the client to its approved document shell");
    console.log("A B Flight response held across the durable switching boundary was rejected and remained pinned to build A.");
    try {
      await waitFor(async () => {
        const [firstGate, secondGate, thirdGate] = await Promise.all([readGate(page), readGate(secondPage), readGate(thirdPage)]);
        return firstGate?.phase === "running" && firstGate.approved_build === buildB &&
          secondGate?.phase === "running" && secondGate.approved_build === buildB &&
          thirdGate?.phase === "running" && thirdGate.approved_build === buildB;
      }, "all three tabs approved on build B after guarded document reload", 20_000);
    } catch (error) {
      console.error("Build update recovery diagnostics:", JSON.stringify(await updateDiagnostics(page, [...pendingRequests.keys()]), null, 2));
      throw error;
    }
    await page.locator("main").waitFor({ state: "visible" });
    await secondPage.locator("main").waitFor({ state: "visible" });
    await thirdPage.locator("main").waitFor({ state: "visible" });
    assert.deepEqual(await readEncryptedDraft(page), originalCiphertext, "accepted update must preserve encrypted draft bytes");
    assert.deepEqual(await readEncryptedDraft(secondPage), originalCiphertext, "second tab must preserve the encrypted draft bytes");
    assert.deepEqual(await readEncryptedDraft(thirdPage), originalCiphertext, "late third tab must preserve the encrypted draft bytes");
    await waitFor(() => cachedBuildReady(page, buildB), "build B offline shell");
    await waitFor(() => cachedBuildReady(secondPage, buildB), "second tab build B offline shell");
    await waitFor(() => cachedBuildReady(thirdPage, buildB), "third tab build B offline shell");
    await assertNoPrivateCacheContent(page);
    await assertNoPrivateCacheContent(secondPage);
    await assertNoPrivateCacheContent(thirdPage);
    const caches = await page.evaluate(async () => await caches.keys());
    assert(caches.includes(`dayforge-shell:${buildA}`), "build A cache should remain available during the update");
    assert(caches.includes(`dayforge-shell:${buildB}`), "build B cache should be installed before approval");
    await apiStub.waitForPushCount(3);
    await waitFor(async () => apiStub.pushStats().recordedOperationIds.includes(uncertainPushOperation.operationId),
      "build B duplicate-receipt retry after the uncertain push");
    const completedPushStats = apiStub.pushStats();
    assert.deepEqual(completedPushStats.requestBodies[0], completedPushStats.requestBodies[1],
      "the first in-flight response loss must preserve byte-identical retry bodies");
    assert.deepEqual(completedPushStats.requestBodies[1], completedPushStats.requestBodies[2],
      "the response lost during build switching must preserve the same operation body on build B");
    assert.equal(completedPushStats.requestCount, 3,
      "the two held response losses must reconcile through one retry on build B");
    assert.deepEqual(completedPushStats.groupCursors, ["1", "2"],
      "the server must record one effect for each operation despite the two lost push responses");
    await waitFor(async () =>
      await readPendingOutboxOperation(page, createdPendingOperation.operationId) === null &&
      await readPendingOutboxOperation(page, uncertainPushOperation.operationId) === null,
    "build B pull reconciles both exact server operations");
    assert.equal(await readPendingOutboxOperation(page, createdPendingOperation.operationId), null,
      "build B pull must remove the ACK-waiting operation only after ingesting its matching event");
    assert.equal(await readPendingOutboxOperation(page, uncertainPushOperation.operationId), null,
      "build B retry receipt and pull must reconcile the uncertain operation without duplicating it");
    apiStub.releaseHeldPushResponses();
    console.log("A/B offline update passed in three tabs: two real mutation API operations survived defer/switch, a committed push response was lost once during handshake deferral and again during switching, build B retried byte-identical envelopes and pulled two single-effect events, and draft/cache/privacy checks passed.");
  } finally {
    await context.close();
    await browser.close();
  }
}

async function main() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "dayforge-offline-update-builds-"));
  const artifactA = path.join(temporary, "build-a");
  const artifactB = path.join(temporary, "build-b");
  assertChildPath(os.tmpdir(), temporary);
  assertChildPath(temporary, artifactA);
  assertChildPath(temporary, artifactB);
  assertChildPath(frontend, nextDirectory);
  assertChildPath(frontend, manifestPath);
  await Promise.all([mkdir(artifactA), mkdir(artifactB)]);
  const originalNextExists = await stat(nextDirectory).then(() => true, () => false);
  const originalManifestExists = await stat(manifestPath).then(() => true, () => false);
  const originalNext = path.join(temporary, "original-next");
  const originalManifest = path.join(temporary, "original-dayforge-build.json");
  let server = null;
  let proxy = null;
  let apiServer = null;
  let apiStub = null;
  let port = null;
  let buildA = `offline-a-${process.pid}`;
  let buildB = `offline-b-${process.pid}`;
  try {
    if (originalNextExists) await rename(nextDirectory, originalNext);
    if (originalManifestExists) await rename(manifestPath, originalManifest);

    build(buildA);
    await moveBuiltArtifact(artifactA);
    build(buildB);
    await moveBuiltArtifact(artifactB);

    await installBuiltArtifact(artifactA);
    apiStub = await startUpdateApiStub(ownerId);
    apiServer = apiStub.server;
    port = await availablePort();
    server = await startServer(port);
    const proxyPort = await availablePort();
    proxy = await startProxy(proxyPort, port);
    await runIndexedDbQuotaScenario(`http://127.0.0.1:${proxyPort}`);
    await runBrowserScenario(`http://127.0.0.1:${proxyPort}`, buildA, buildB, async () => {
      await stopServer(server);
      server = null;
      await rename(nextDirectory, path.join(artifactA, ".next"));
      await rm(manifestPath, { force: true });
      await installBuiltArtifact(artifactB);
      server = await startServer(port);
    }, () => proxy.failNextStaticAsset(), proxy.failedStaticAssets,
    () => proxy.holdNextFlightResponse(), () => proxy.releaseHeldFlightResponse(), apiStub);

    await stopServer(server);
    server = null;
    await stopProxy(proxy);
    proxy = null;
  } finally {
    apiStub?.releaseHeldPushResponses();
    if (server) await stopServer(server).catch(() => undefined);
    if (proxy) await stopProxy(proxy).catch(() => undefined);
    if (apiServer?.listening) await new Promise((resolve) => apiServer.close(resolve));
    await rm(nextDirectory, { recursive: true, force: true });
    await rm(manifestPath, { force: true });
    if (originalNextExists) await rename(originalNext, nextDirectory);
    if (originalManifestExists) await rename(originalManifest, manifestPath);
    await rm(temporary, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : String(error));
  process.exitCode = 1;
});

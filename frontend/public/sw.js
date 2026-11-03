/* Public calendar shell worker. It never handles API, account, or callback data. */
const DB_NAME = "dayforge-local";
const SHELL_PREFIX = "dayforge-shell:";
const SHELL_ROUTES = ["/work", "/milestones"];
const BUILD_MARKER = "X-Dayforge-Build";
const CACHE_READY_PATH = "/__dayforge_shell_ready__";
const workerUrl = new URL(self.location.href);
const workerBuildId = workerUrl.searchParams.get("build");
const workerSchemaVersion = Number(workerUrl.searchParams.get("schema"));

function cacheName(buildId) {
  return `${SHELL_PREFIX}${buildId}`;
}

function hasNoStore(response) {
  return (response.headers.get("Cache-Control") || "")
    .split(",")
    .some((directive) => directive.trim().toLowerCase() === "no-store");
}

function cacheablePublicResponse(response, expectedBuild, expectedPath, kind) {
  const cacheControl = response.headers.get("Cache-Control") || "";
  const vary = (response.headers.get("Vary") || "").split(",").map((value) => value.trim().toLowerCase());
  const contentType = (response.headers.get("Content-Type") || "").toLowerCase();
  const typeAllowed = kind === "html"
    ? contentType.startsWith("text/html")
    : /^(?:text\/css|text\/javascript|application\/(?:javascript|json|wasm|font-woff2?)|font\/|image\/)/.test(contentType);
  return response.status === 200 &&
    !response.redirected &&
    response.type === "basic" &&
    new URL(response.url).origin === self.location.origin &&
    new URL(response.url).pathname === expectedPath &&
    !hasNoStore(response) &&
    !/(?:^|,)\s*private(?:\s|,|$)/i.test(cacheControl) &&
    !response.headers.has("Set-Cookie") &&
    !vary.includes("*") && !vary.includes("cookie") && !vary.includes("authorization") &&
    typeAllowed &&
    response.headers.get(BUILD_MARKER) === expectedBuild;
}

async function readBuildManifest() {
  const response = await fetch("/dayforge-build.json", { cache: "no-store", credentials: "same-origin" });
  if (!response.ok || response.headers.get(BUILD_MARKER) === null) throw new Error("Build manifest unavailable");
  const manifest = await response.json();
  if (!workerBuildId || !/^[A-Za-z0-9._-]{1,128}$/.test(workerBuildId) ||
      !manifest || typeof manifest.build_id !== "string" || manifest.build_id !== workerBuildId ||
      response.headers.get(BUILD_MARKER) !== manifest.build_id || manifest.protocol_version !== 1 ||
      !Number.isInteger(workerSchemaVersion) || workerSchemaVersion < 1 || manifest.schema_version !== workerSchemaVersion ||
      !Array.isArray(manifest.routes) ||
      !SHELL_ROUTES.every((route) => manifest.routes.includes(route)) ||
      !Array.isArray(manifest.assets) || manifest.assets.some((asset) => typeof asset !== "string" ||
        !asset.startsWith("/_next/static/") || asset.includes("..") || asset.includes("\\") || asset.includes("?"))) {
    throw new Error("Build manifest is incompatible");
  }
  return manifest;
}

function staticAssetsFromHtml(html) {
  const assets = new Set();
  const attribute = /\b(?:src|href)\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
  let match;
  while ((match = attribute.exec(html))) {
    const raw = match[1] || match[2];
    try {
      const url = new URL(raw, self.location.origin);
      if (url.origin === self.location.origin && url.pathname.startsWith("/_next/static/")) {
        assets.add(url.href);
      }
    } catch {
      // Ignore invalid optional references; required route documents are checked below.
    }
  }
  return [...assets];
}

async function precacheShell(buildId) {
  const name = cacheName(buildId);
  const cache = await caches.open(name);
  const readyUrl = new URL(CACHE_READY_PATH, self.location.origin);
  const ready = await cache.match(readyUrl);
  if (ready?.headers.get(BUILD_MARKER) === buildId && await ready.text() === buildId) return;
  await cache.delete(readyUrl);
  const requiredAssets = new Set();
  try {
    const manifest = await readBuildManifest();
    for (const asset of manifest.assets) requiredAssets.add(new URL(asset, self.location.origin).href);
    for (const route of SHELL_ROUTES) {
      const response = await fetch(route, { cache: "no-store", credentials: "omit" });
      if (!cacheablePublicResponse(response, buildId, route, "html")) throw new Error(`Calendar shell ${route} is not cacheable for this build`);
      const html = await response.clone().text();
      requiredAssets.add(new URL(route, self.location.origin).href);
      for (const asset of staticAssetsFromHtml(html)) requiredAssets.add(asset);
      await cache.put(new URL(route, self.location.origin), response);
    }

    for (const asset of requiredAssets) {
      if (SHELL_ROUTES.some((route) => new URL(asset).pathname === route)) continue;
      const assetPath = new URL(asset).pathname;
      const response = await fetch(asset, { cache: "no-store", credentials: "omit" });
      if (!cacheablePublicResponse(response, buildId, assetPath, "asset")) throw new Error(`Shell asset does not belong to build ${buildId}`);
      await cache.put(asset, response);
    }
    await cache.put(readyUrl, new Response(buildId, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", [BUILD_MARKER]: buildId },
    }));
  } catch (error) {
    await caches.delete(name);
    throw error;
  }
}

function openExistingDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onupgradeneeded = () => {
      request.transaction.abort();
      reject(new Error("The local build gate has not been initialized"));
    };
    request.onerror = () => reject(request.error || new Error("Unable to read the local build gate"));
    request.onsuccess = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("build_gate")) {
        database.close();
        reject(new Error("The local build gate is unavailable"));
        return;
      }
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

async function readGate() {
  const database = await openExistingDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(["build_gate"], "readonly");
      const request = transaction.objectStore("build_gate").get("build_gate");
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error || new Error("Unable to read build gate"));
      transaction.onabort = () => reject(transaction.error || new Error("Build gate read aborted"));
    });
  } finally {
    database.close();
  }
}

async function approvedBuild() {
  const gate = await readGate();
  if (!gate || typeof gate.approved_build !== "string") return null;
  return gate.approved_build;
}

async function servingBuild() {
  const gate = await readGate();
  if (gate?.phase === "switching" && gate.target_build === workerBuildId && gate.target_schema_version === workerSchemaVersion) {
    return workerBuildId;
  }
  return gate && typeof gate.approved_build === "string" ? gate.approved_build : null;
}

function askPageToPause(page, updateEpoch, targetBuild) {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timeout = setTimeout(() => {
      channel.port1.close();
      resolve(false);
    }, 15_000);
    channel.port1.onmessage = (event) => {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(Boolean(event.data?.ready && event.data?.updateEpoch === updateEpoch));
    };
    try {
      page.postMessage({ type: "DAYFORGE_PREPARE_CLIENT", updateEpoch, targetBuild }, [channel.port2]);
    } catch {
      clearTimeout(timeout);
      channel.port1.close();
      resolve(false);
    }
  });
}

async function cachedShell(buildId, path, search = "") {
  const cache = await caches.open(cacheName(buildId));
  const ready = await cache.match(new URL(CACHE_READY_PATH, self.location.origin));
  if (!ready || ready.headers.get(BUILD_MARKER) !== buildId || await ready.text() !== buildId) return null;
  const url = new URL(path, self.location.origin);
  url.search = search;
  let response = await cache.match(url.href, { ignoreSearch: true });
  if (!response || response.headers.get(BUILD_MARKER) !== buildId) return null;
  return response;
}

function updateGateAllowsActivation(gate) {
  return gate && ((gate.phase === "running" && gate.approved_build === workerBuildId) ||
    (gate.phase === "switching" && gate.target_build === workerBuildId &&
      gate.target_schema_version === workerSchemaVersion && gate.update_epoch));
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    try {
      const manifest = await readBuildManifest();
      await precacheShell(manifest.build_id);
      const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const page of pages) page.postMessage({
        type: "DAYFORGE_UPDATE_READY",
        buildId: workerBuildId,
        schemaVersion: workerSchemaVersion,
      });
    } catch (error) {
      const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const page of pages) page.postMessage({
        type: "DAYFORGE_INSTALL_FAILED",
        buildId: workerBuildId,
        reason: error instanceof Error ? error.message : "Shell install failed",
      });
      throw error;
    }
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    try {
      const gate = await readGate();
      if (updateGateAllowsActivation(gate)) await self.clients.claim();
    } catch {
      // Keep the worker installed but do not take control without a durable build gate.
    }
  })());
});

self.addEventListener("message", (event) => {
  const message = event.data;
  if (!message || typeof message.type !== "string") return;
  if (message.type === "DAYFORGE_GET_BUILD") {
    event.ports?.[0]?.postMessage({ buildId: workerBuildId, schemaVersion: workerSchemaVersion });
    return;
  }
  if (message.type === "DAYFORGE_SKIP_WAITING") {
    const reply = event.ports?.[0];
    event.waitUntil((async () => {
      const gate = await readGate();
      if (gate?.phase === "switching" && gate.target_build === workerBuildId &&
          gate.target_schema_version === workerSchemaVersion && gate.update_epoch === message.updateEpoch) {
        try {
          const result = self.skipWaiting();
          reply?.postMessage({ accepted: true, updateEpoch: message.updateEpoch });
          void result.catch(() => undefined);
        } catch (error) {
          reply?.postMessage({ accepted: false, reason: String(error) });
        }
      } else {
        reply?.postMessage({ accepted: false, reason: "gate_mismatch" });
      }
    })());
    return;
  }
  if (message.type === "DAYFORGE_PREPARE_UPDATE") {
    const reply = event.ports?.[0];
    event.waitUntil((async () => {
      if (!reply || !message.updateEpoch || message.targetBuild !== workerBuildId) return;
      const gate = await readGate();
      if (gate?.phase !== "preparing" || gate.update_epoch !== message.updateEpoch || gate.target_build !== workerBuildId ||
          gate.target_schema_version !== workerSchemaVersion) {
        reply.postMessage({ ready: false, reason: "gate_mismatch" });
        return;
      }
      const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const results = await Promise.all(pages.map((page) => askPageToPause(page, message.updateEpoch, workerBuildId)));
      const ready = results.every(Boolean);
      if (!ready) {
        for (const page of pages) page.postMessage({ type: "DAYFORGE_RESUME_CLIENT", updateEpoch: message.updateEpoch });
      }
      reply.postMessage({ ready, updateEpoch: message.updateEpoch, clients: pages.length });
    })());
    return;
  }
  if (message.type === "DAYFORGE_CANCEL_PREPARE") {
    event.waitUntil((async () => {
      const gate = await readGate();
      if (gate?.phase !== "running" || gate.update_epoch !== null) return;
      const pages = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const page of pages) page.postMessage({ type: "DAYFORGE_RESUME_CLIENT", updateEpoch: message.updateEpoch });
    })());
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/account") ||
      url.pathname.startsWith("/verify-email") || url.pathname.startsWith("/reset-password") ||
      url.pathname === "/sw.js" || url.pathname === "/dayforge-build.json") return;

  if (request.mode === "navigate") {
    if (url.pathname === "/") {
      event.respondWith(Response.redirect(new URL("/work", self.location.origin), 302));
      return;
    }
    if (!SHELL_ROUTES.includes(url.pathname)) return;
    event.respondWith((async () => {
      let buildId;
      try { buildId = await servingBuild(); } catch { buildId = null; }
      if (!buildId) return new Response("Connect online to prepare DAYFORGE for offline use.", { status: 503 });
      try {
        const response = await fetch(request, { cache: "no-store", credentials: "omit" });
        if (cacheablePublicResponse(response, buildId, url.pathname, "html")) {
          const cache = await caches.open(cacheName(buildId));
          await cache.put(new URL(url.pathname, self.location.origin), response.clone());
          return response;
        }
      } catch {
        // An unavailable or unapproved server build falls back to the pinned shell below.
      }
      const fallback = await cachedShell(buildId, url.pathname, url.search);
      if (fallback) return fallback;
      return new Response("This calendar has not been prepared for offline use. Connect to the internet first.", { status: 503 });
    })());
    return;
  }

  const isCalendarFlight = SHELL_ROUTES.includes(url.pathname) &&
    (request.headers.get("RSC") === "1" || request.headers.get("Accept")?.includes("text/x-component") || url.searchParams.has("_rsc"));
  if (isCalendarFlight) {
    event.respondWith((async () => {
      let buildId;
      try { buildId = await servingBuild(); } catch { buildId = null; }
      if (!buildId) return new Response("Build gate unavailable", { status: 503 });
      try {
        const response = await fetch(request, { cache: "no-store", credentials: "same-origin" });
        if (response.headers.get(BUILD_MARKER) === buildId) return response;
      } catch {
        // App Router Flight cannot safely consume cached HTML; the page must navigate as a document.
      }
      const isPrefetch = request.headers.get("Purpose")?.toLowerCase() === "prefetch" ||
        request.headers.has("Next-Router-Prefetch") || request.headers.has("Next-Router-Segment-Prefetch");
      if (!isPrefetch && event.clientId) {
        const client = await self.clients.get(event.clientId);
        if (client) {
          const target = new URL(url.pathname, self.location.origin);
          for (const key of ["date", "scale"]) {
            const value = url.searchParams.get(key);
            if (value !== null) target.searchParams.set(key, value);
          }
          client.postMessage({ type: "DAYFORGE_DOCUMENT_NAVIGATION_REQUIRED", href: target.href });
        }
      }
      return new Response("Use document navigation for the approved offline calendar shell.", {
        status: 409,
        headers: { "X-Dayforge-Offline-Navigation": "document", [BUILD_MARKER]: buildId },
      });
    })());
    return;
  }

  if (url.pathname.startsWith("/_next/static/")) {
    event.respondWith((async () => {
      let buildId;
      try { buildId = await servingBuild(); } catch { buildId = null; }
      if (!buildId) return new Response("Approved build is unavailable", { status: 503 });
      try {
        const response = await fetch(request, { cache: "no-store", credentials: "same-origin" });
        if (response.headers.get(BUILD_MARKER) === buildId) return response;
      } catch {
        // Use only the exact approved build cache.
      }
      const cache = await caches.open(cacheName(buildId));
      const cached = await cache.match(request.url);
      return cached?.headers.get(BUILD_MARKER) === buildId ? cached : new Response("Approved build asset unavailable", { status: 503 });
    })());
  }
});

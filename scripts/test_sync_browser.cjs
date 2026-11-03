const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { createServer: createHttpServer, request: httpRequest } = require("node:http");
const { createServer: createHttpsServer } = require("node:https");
const { mkdtemp, rename, rm, stat } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { chromium } = require(path.join(__dirname, "..", "frontend", "node_modules", "@playwright", "test"));

const root = path.resolve(__dirname, "..");
const frontend = path.join(root, "frontend");
const nextCli = path.join(frontend, "node_modules", "next", "dist", "bin", "next");
const nextDirectory = path.join(frontend, ".next");
const manifestPath = path.join(frontend, "public", "dayforge-build.json");
const browserPort = Number(process.env.DAYFORGE_SYNC_BROWSER_PORT);

async function waitForTestEpochRestore(ownerId) {
  if (process.env.DAYFORGE_SYNC_BROWSER_EPOCH_CONTROL !== "1") return null;
  console.log(`DAYFORGE_TEST_RESET_EPOCH ${ownerId}`);
  const control = readline.createInterface({ input: process.stdin });
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timed out waiting for isolated test epoch reset")), 30_000);
      control.once("line", (line) => {
        clearTimeout(timeout);
        if (!line.startsWith("DAYFORGE_TEST_EPOCH_RESET_DONE ")) {
          reject(new Error("The isolated test runner returned an invalid epoch reset signal"));
          return;
        }
        resolve(line.slice("DAYFORGE_TEST_EPOCH_RESET_DONE ".length));
      });
    });
  } finally {
    control.close();
  }
}

function assertChildPath(parent, target) {
  const parentPath = path.resolve(parent);
  const targetPath = path.resolve(target);
  const relative = path.relative(parentPath, targetPath);
  if (!relative || relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Refusing to manage a path outside its intended directory: ${targetPath}`);
  }
}

async function availablePort() {
  const server = createHttpServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to select a temporary port");
  const { port } = address;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitFor(check, label, timeoutMs = 45_000) {
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

async function completesWithin(promise, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve(promise).then(() => true, () => true),
      new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function pausePageExecution(session) {
  const paused = new Promise((resolve) => {
    const onPaused = (details) => {
      session.off("Debugger.paused", onPaused);
      resolve(details);
    };
    session.on("Debugger.paused", onPaused);
  });
  await session.send("Debugger.enable");
  await session.send("Debugger.pause");
  return paused;
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { cache: "no-store" });
      if (response.ok) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Frontend did not become ready${lastError ? `: ${lastError.message}` : ""}`);
}

async function startFrontend(port) {
  const child = spawn(process.execPath, [nextCli, "dev", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: frontend,
    env: {
      ...process.env,
      API_INTERNAL_ORIGIN: "http://127.0.0.1:8000",
      DAYFORGE_SYNC_TEST_HARNESS: "1",
      NEXT_PUBLIC_DAYFORGE_BUILD_ID: "development",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => { output = `${output}${chunk.toString()}`.slice(-5_000); });
  }
  try {
    await waitForHttp(`http://127.0.0.1:${port}/account`);
    return { child, output: () => output };
  } catch (error) {
    await stopProcess(child).catch(() => undefined);
    throw new Error(`Next.js dev server failed to start: ${error.message}\n${output}`);
  }
}

function startTlsProxy(port, nextPort) {
  const certificate = require("node:fs").readFileSync(process.env.DAYFORGE_SYNC_TLS_CERT);
  const key = require("node:fs").readFileSync(process.env.DAYFORGE_SYNC_TLS_KEY);
  const server = createHttpsServer({ cert: certificate, key }, (request, response) => {
    const proxy = httpRequest({
      hostname: "127.0.0.1",
      port: nextPort,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: `127.0.0.1:${nextPort}`, "x-forwarded-proto": "https" },
    }, (upstream) => {
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end("Development server connection closed");
      });
      response.on("error", () => proxy.destroy());
      response.writeHead(upstream.statusCode ?? 502, upstream.headers);
      upstream.pipe(response);
    });
    proxy.on("error", () => {
      if (!response.headersSent) response.writeHead(502);
      response.end("Development server unavailable");
    });
    request.on("error", () => proxy.destroy());
    request.pipe(proxy);
  });
  server.on("upgrade", (request, socket, head) => {
    const upstream = httpRequest({
      hostname: "127.0.0.1",
      port: nextPort,
      path: request.url,
      method: request.method,
      headers: { ...request.headers, host: `127.0.0.1:${nextPort}`, "x-forwarded-proto": "https" },
    });
    upstream.on("upgrade", (response, upstreamSocket, upstreamHead) => {
      socket.on("error", () => upstreamSocket.destroy());
      upstreamSocket.on("error", () => socket.destroy());
      socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`);
      for (const [name, value] of Object.entries(response.headers)) {
        if (Array.isArray(value)) for (const item of value) socket.write(`${name}: ${item}\r\n`);
        else if (value !== undefined) socket.write(`${name}: ${value}\r\n`);
      }
      socket.write("\r\n");
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      socket.pipe(upstreamSocket).pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
  });
  return server;
}

async function startServer(server, port) {
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function stopServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  if (process.platform === "win32" && child.pid) {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const taskkill = path.join(systemRoot, "System32", "taskkill.exe");
    const killer = spawn(taskkill, ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    await new Promise((resolve) => {
      const timeout = setTimeout(resolve, 5_000);
      killer.once("exit", () => { clearTimeout(timeout); resolve(); });
      killer.once("error", () => { clearTimeout(timeout); resolve(); });
    });
  } else {
    child.kill("SIGTERM");
  }
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Frontend process did not stop")), 10_000);
    child.once("exit", () => { clearTimeout(timeout); resolve(); });
    if (child.exitCode !== null) { clearTimeout(timeout); resolve(); }
  });
  child.stdout?.destroy();
  child.stderr?.destroy();
}

async function login(page) {
  await page.goto("/account");
  await page.locator("#account-email").waitFor({ state: "visible" });
  await page.locator("#account-email").fill(process.env.OWNER_EMAIL);
  await page.locator("#account-password").fill("A sufficiently long password for Dayforge");
  await page.getByRole("button", { name: "Đăng nhập và mở kho local" }).click();
  try {
    await page.getByText(/Đã mở kho local/).waitFor({ state: "visible", timeout: 20_000 });
  } catch (error) {
    console.error(`Login did not open the local vault; current page text: ${await page.locator("body").innerText().catch(() => "unavailable")}`);
    throw error;
  }
  await page.goto("/sync-browser");
  await page.getByText("Test sync harness sẵn sàng.").waitFor({ state: "visible" });
  await page.waitForFunction(() => Boolean(window.__dayforgeSyncBrowserHarness));
}

function watchSyncResponses(page) {
  const evidence = { pushes: [], pulls: [], bootstraps: [] };
  page.on("response", (response) => {
    let pathname;
    try { pathname = new URL(response.url()).pathname; } catch { return; }
    const bucket = pathname === "/api/v1/sync/push" ? evidence.pushes :
      pathname === "/api/v1/sync/pull" ? evidence.pulls :
        pathname === "/api/v1/sync/bootstrap" ? evidence.bootstraps : null;
    if (!bucket) return;
    void response.text().then((rawBody) => {
      let body = null;
      try { body = JSON.parse(rawBody); } catch { body = rawBody.slice(0, 500); }
      bucket.push({ status: response.status(), contentType: response.headers()["content-type"] ?? null, body });
    }).catch(() => undefined);
  });
  return evidence;
}

async function runBrowserScenario(baseURL) {
  const browser = await chromium.launch({ headless: true });
  const contextA = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, serviceWorkers: "block" });
  const contextB = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, serviceWorkers: "block" });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  let releaseHeldPull = () => {};
  let expectedLostPushResponseConsoleError = false;
  const evidenceA = watchSyncResponses(pageA);
  const evidenceB = watchSyncResponses(pageB);
  let evidenceSuccessor = evidenceA;
  for (const [label, page] of [["A", pageA], ["B", pageB]]) {
    page.on("pageerror", (error) => console.error(`Browser ${label} page error: ${error.message}`));
    page.on("console", (message) => {
      if (message.type() === "error" && expectedLostPushResponseConsoleError && message.text().includes("Failed to load resource")) {
        expectedLostPushResponseConsoleError = false;
        return;
      }
      if (message.type() === "error" && !message.text().includes("service worker")) {
        console.error(`Browser ${label} console error at ${message.location().url}: ${message.text()}`);
      }
    });
  }
  try {
    await Promise.all([login(pageA), login(pageB)]);
    console.log("Both browser sessions authenticated and opened separate owner vaults.");
    const initialA = await pageA.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
    const initialB = await pageB.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
    assert.equal(initialA.ownerId, initialB.ownerId, "both real browser sessions must authenticate the same owner");
    assert.notEqual(initialA.deviceId, initialB.deviceId, "each browser context must initialize a distinct device lane");
    await waitFor(async () => {
      const [left, right] = await Promise.all([
        pageA.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect()),
        pageB.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect()),
      ]);
      return Boolean(left.serverEpoch && right.serverEpoch && left.serverEpoch === right.serverEpoch);
    }, "both devices to bootstrap the same server epoch");
    console.log("Both devices completed bootstrap.");
    const recalibrateWithWallSkew = async (page, wallOffsetMs, label) => {
      const before = await page.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
      assert(before.clockCalibration, `${label} requires the initial persisted calibration`);
      await page.evaluate((offsetMs) => window.__dayforgeSyncBrowserHarness.setClockOffsetForTest(offsetMs), wallOffsetMs);
      await page.evaluate(() => window.__dayforgeSyncBrowserHarness.expireClockCalibrationForTest());
      await page.evaluate(() => window.__dayforgeSyncBrowserHarness.expireLeaseForClockTest());
      await page.evaluate(() => window.__dayforgeSyncBrowserHarness.wakeSync());
      try {
        await waitFor(async () => {
          const state = await page.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
          return state.clockCalibration?.calibrationId !== before.clockCalibration.calibrationId &&
            Math.abs(state.clockCalibration.offsetMs + wallOffsetMs) < 10_000;
        }, `${label} to recalibrate against the real sync clock`, 45_000);
      } catch (error) {
        const diagnostics = await Promise.all([
          page.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect()),
          page.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorDetails()),
          page.evaluate(() => window.__dayforgeSyncBrowserHarness.leaseState()),
        ]);
        throw new Error(`${error.message}; calibration diagnostics=${JSON.stringify({ before, after: diagnostics[0], coordinator: diagnostics[1], lease: diagnostics[2], wallOffsetMs })}`);
      }
      return page.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
    };
    const driftCalibrationIds = new Set();
    const driftA1 = await recalibrateWithWallSkew(pageA, 240_000, "device A's first +4 minute wall-clock drift");
    driftCalibrationIds.add(driftA1.clockCalibration.calibrationId);
    const driftB1 = await recalibrateWithWallSkew(pageB, -180_000, "device B's first -3 minute wall-clock drift");
    driftCalibrationIds.add(driftB1.clockCalibration.calibrationId);
    const driftA2 = await recalibrateWithWallSkew(pageA, -360_000, "device A's second -6 minute wall-clock drift");
    driftCalibrationIds.add(driftA2.clockCalibration.calibrationId);
    const driftB2 = await recalibrateWithWallSkew(pageB, 120_000, "device B's second +2 minute wall-clock drift");
    driftCalibrationIds.add(driftB2.clockCalibration.calibrationId);
    const driftA3 = await recalibrateWithWallSkew(pageA, 0, "device A's return to its synchronized wall clock");
    driftCalibrationIds.add(driftA3.clockCalibration.calibrationId);
    const driftB3 = await recalibrateWithWallSkew(pageB, 0, "device B's return to its synchronized wall clock");
    driftCalibrationIds.add(driftB3.clockCalibration.calibrationId);
    assert.equal(driftCalibrationIds.size, 6, "each device calibration cycle must receive a fresh server calibration id");
    console.log("Two device lanes recalibrated through six real /sync/clock cycles under changing browser wall-clock skew, then returned to zero skew.");
    console.log("Coordinator states:", JSON.stringify(await Promise.all([
      pageA.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorState()),
      pageB.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorState()),
    ])));

    const pushFaultEvidence = { requestBodies: [], serverResponses: [], serverResponseDetails: [] };
    const recurringLostResponse = { rootId: null, action: null, armed: false, lost: false, requestBodies: [] };
    const staleLeaderResponse = { armed: false, held: false };
    let releaseStaleLeaderResponse = () => {};
    let signalStaleLeaderResponse = () => {};
    const staleLeaderResponseHeld = new Promise((resolve) => { signalStaleLeaderResponse = resolve; });
    const staleLeaderResponseGate = new Promise((resolve) => { releaseStaleLeaderResponse = resolve; });
    const processDeathResponse = { armed: false, held: false, terminated: false };
    let releaseProcessDeathResponse = () => {};
    let signalProcessDeathResponse = () => {};
    const processDeathResponseHeld = new Promise((resolve) => { signalProcessDeathResponse = resolve; });
    const processDeathResponseGate = new Promise((resolve) => { releaseProcessDeathResponse = resolve; });
    const recoveryProcessDeathResponse = { armed: false, held: false, terminated: false };
    let releaseRecoveryProcessDeathResponse = () => {};
    const recoveryProcessDeathResponseGate = new Promise((resolve) => { releaseRecoveryProcessDeathResponse = resolve; });
    await contextA.route("**/api/v1/sync/push", async (route) => {
      const requestBody = route.request().postData() ?? "";
      pushFaultEvidence.requestBodies.push(requestBody);
      const realResponse = await route.fetch();
      const rawResponse = await realResponse.body();
      const rawText = rawResponse.toString("utf8");
      let body = null;
      try { body = JSON.parse(rawText); } catch { body = rawText.slice(0, 1000); }
      pushFaultEvidence.serverResponses.push(body);
      pushFaultEvidence.serverResponseDetails.push({
        status: realResponse.status(),
        contentType: realResponse.headers()["content-type"] ?? null,
        body,
      });
      if (pushFaultEvidence.requestBodies.length === 1) {
        expectedLostPushResponseConsoleError = true;
        await route.fulfill({
          status: 503,
          headers: { "cache-control": "private, no-store", "content-type": "application/problem+json" },
          body: JSON.stringify({
            type: "about:blank",
            title: "Temporary test response loss",
            status: 503,
            detail: "The server committed the request before this test replaced its response.",
            instance: "/api/v1/sync/push",
            code: "service_unavailable",
            request_id: crypto.randomUUID(),
            retryable: true,
            server_time: new Date().toISOString(),
          }),
        });
        return;
      }
      const parsedRequest = JSON.parse(requestBody);
      const recurringOperation = recurringLostResponse.armed && recurringLostResponse.rootId
        ? (parsedRequest.operations ?? []).find((operation) => operation.commands?.some((command) =>
          command.root?.kind === "work_item" && command.root.id === recurringLostResponse.rootId &&
          command.action === recurringLostResponse.action))
        : null;
      if (recurringOperation) {
        recurringLostResponse.requestBodies.push(requestBody);
        if (!recurringLostResponse.lost) {
          recurringLostResponse.lost = true;
          expectedLostPushResponseConsoleError = true;
          await route.fulfill({
            status: 503,
            headers: { "cache-control": "private, no-store", "content-type": "application/problem+json" },
            body: JSON.stringify({
              type: "about:blank",
              title: "Temporary recurrence response loss",
              status: 503,
              detail: "The recurrence operation was recorded before this test replaced its response.",
              instance: "/api/v1/sync/push",
              code: "service_unavailable",
              request_id: crypto.randomUUID(),
              retryable: true,
              server_time: new Date().toISOString(),
            }),
          });
          return;
        }
      }
      if (staleLeaderResponse.armed && !staleLeaderResponse.held) {
        staleLeaderResponse.held = true;
        signalStaleLeaderResponse();
        await staleLeaderResponseGate;
      }
      let responseBelongsToCrashedLeader = false;
      if (processDeathResponse.armed && !processDeathResponse.held) {
        processDeathResponse.armed = false;
        processDeathResponse.held = true;
        responseBelongsToCrashedLeader = true;
        signalProcessDeathResponse();
        await processDeathResponseGate;
      }
      if (recoveryProcessDeathResponse.armed && !recoveryProcessDeathResponse.held) {
        recoveryProcessDeathResponse.armed = false;
        recoveryProcessDeathResponse.held = true;
        responseBelongsToCrashedLeader = true;
        await recoveryProcessDeathResponseGate;
      }
      try {
        await route.fulfill({
          status: realResponse.status(),
          headers: { "cache-control": "private, no-store", "content-type": "application/json" },
          body: rawResponse,
        });
      } catch (error) {
        const crashedLeaderTerminated = processDeathResponse.terminated || recoveryProcessDeathResponse.terminated;
        if (!responseBelongsToCrashedLeader || !crashedLeaderTerminated) throw error;
      }
    });

    const name = `browser-sync-${process.pid}-${Date.now()}`;
    const localRaceName = `${name}-local-race`;
    let signalHeldPull = () => {};
    const heldPullGate = new Promise((resolve) => { releaseHeldPull = resolve; });
    const stalePullEvidence = { totalResponses: 0, matchingResponses: 0, firstCursor: null, firstOperationId: null };
    await contextB.route("**/api/v1/sync/pull**", async (route) => {
      const response = await route.fetch();
      const rawResponse = await response.body();
      const body = JSON.parse(rawResponse.toString("utf8"));
      stalePullEvidence.totalResponses += 1;
      const containsRemotePlan = (body.groups ?? []).some((group) =>
        group.operation.commands?.some((command) => command.payload?.data?.name === name));
      if (containsRemotePlan) {
        stalePullEvidence.matchingResponses += 1;
        stalePullEvidence.firstCursor ??= body.groups.find((group) =>
          group.operation.commands?.some((command) => command.payload?.data?.name === name))?.cursor ?? null;
        stalePullEvidence.firstOperationId ??= body.groups.find((group) =>
          group.operation.commands?.some((command) => command.payload?.data?.name === name))?.operation.operation_id ?? null;
        if (stalePullEvidence.matchingResponses === 1) {
          signalHeldPull();
          await heldPullGate;
        }
      }
      await route.fulfill({
        status: response.status(),
        headers: { "cache-control": "private, no-store", "content-type": "application/json" },
        body: rawResponse,
      });
    });

    const created = await pageA.evaluate((planName) => window.__dayforgeSyncBrowserHarness.createPlan(planName), name);
    await pageB.evaluate(() => window.dispatchEvent(new Event("online")));
    const operationId = created.operationId;
    const isRecorded = async (page, planName = name, id = operationId) => page.evaluate(async ({ planName, id }) => {
      const state = await window.__dayforgeSyncBrowserHarness.inspect();
      return state.planNames.includes(planName) && state.recordedEvents.some((event) => event.operationId === id) &&
        state.pending.every((entry) => entry.operationId !== id) && BigInt(state.pullCursor) > 0n;
    }, { planName, id });
    await waitFor(() => isRecorded(pageA), "device A push receipt and pull publication");
    console.log("Device A operation was recorded after the injected lost response.");
    await waitFor(() => pageB.evaluate(() => window.__dayforgeSyncBrowserHarness.wakeSync()),
      "device B coordinator to become ready before the in-flight pull race");
    console.log("Device B coordinator was explicitly woken after the server commit.");
    try {
      await waitFor(() => stalePullEvidence.matchingResponses === 1,
        "device B to pause after receiving the remote event but before local ingestion", 45_000);
    } catch (error) {
      const state = await pageB.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorState()).catch(() => "unavailable");
      console.error("Device B pull diagnostic:", JSON.stringify({
        coordinator_state: state,
        total_pull_responses: stalePullEvidence.totalResponses,
        matching_remote_event_responses: stalePullEvidence.matchingResponses,
        observed_responses: evidenceB.pulls.map(({ status, body }) => ({
          status,
          next_cursor: body?.next_cursor,
          groups: body?.groups?.length,
        })),
      }));
      throw error;
    }
    console.log("Device B received the remote page and its response is paused before ingestion.");

    const localRace = await pageB.evaluate((planName) => window.__dayforgeSyncBrowserHarness.createPlan(planName), localRaceName);
    const beforeRelease = await pageB.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
    assert(beforeRelease.planNames.includes(localRaceName), "the concurrent local save must commit before the delayed pull response is released");
    assert(beforeRelease.pending.some((entry) => entry.operationId === localRace.operationId),
      "the concurrent local save must remain in active outbox while pull ingestion is pending");
    console.log("Device B committed a second local operation while the remote pull response was paused.");
    releaseHeldPull();
    await pageB.evaluate(() => window.dispatchEvent(new Event("online")));
    console.log("Released the stale pull response; waiting for coordinator CAS retry.");
    await waitFor(() => isRecorded(pageB), "device B to retry stale pull preparation and publish the MySQL event", 45_000);
    console.log("Device B published the remote operation after re-preparing the pull page.");
    const isLocalRaceRecorded = async (page) => page.evaluate(async ({ planName, id }) => {
      const state = await window.__dayforgeSyncBrowserHarness.inspect();
      return state.planNames.includes(planName) && state.recordedEvents.some((event) => event.operationId === id) &&
        state.pending.every((entry) => entry.operationId !== id);
    }, { planName: localRaceName, id: localRace.operationId });
    await waitFor(() => isLocalRaceRecorded(pageB), "device B to push and pull its concurrent local save", 45_000);
    console.log("Device B's concurrent local operation is now recorded and pulled.");
    await waitFor(() => isLocalRaceRecorded(pageA), "device A to pull the concurrent local save", 45_000);
    console.log("Device A pulled the concurrent local operation.");
    assert(stalePullEvidence.matchingResponses >= 2,
      "a local revision change during pull must cause the stale response to be fetched and prepared again");

    const reconnectName = `${name}-offline-reconnect-original`;
    const reconnectEditedName = `${name}-offline-reconnect-edited`;
    await contextA.setOffline(true);
    const reconnectOperation = await pageA.evaluate(
      (planName) => window.__dayforgeSyncBrowserHarness.createPlan(planName), reconnectName,
    );
    const reconnectEdit = await pageA.evaluate(({ planId, planName, dependencyId }) =>
      window.__dayforgeSyncBrowserHarness.replacePlan(planId, planName, dependencyId),
    { planId: reconnectOperation.planId, planName: reconnectEditedName, dependencyId: reconnectOperation.operationId });
    const reconnectWorkItem = await pageA.evaluate(({ planId, dependencyId }) =>
      window.__dayforgeSyncBrowserHarness.createWorkItem(planId, dependencyId),
    { planId: reconnectOperation.planId, dependencyId: reconnectEdit.operationId });
    const reconnectDelete = await pageA.evaluate(({ workItemId, dependencyId }) =>
      window.__dayforgeSyncBrowserHarness.deleteWorkItem(workItemId, dependencyId),
    { workItemId: reconnectWorkItem.workItemId, dependencyId: reconnectWorkItem.operationId });
    const reconnectOperations = [reconnectOperation, reconnectEdit, reconnectWorkItem, reconnectDelete];
    await waitFor(async () => {
      const state = await pageA.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
      return state.planNames.includes(reconnectEditedName) && !state.planNames.includes(reconnectName) &&
        state.deletedWorkItemIds.includes(reconnectWorkItem.workItemId) &&
        reconnectOperations.every((operation) => state.pending.some((entry) =>
          entry.operationId === operation.operationId && entry.state === "queued"));
    }, "offline create, edit, and delete operations to stay committed locally and queued with dependencies", 20_000);
    const beforeReconnectA = await pageA.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
    assert(reconnectOperations.every((operation) => beforeReconnectA.pending.some((entry) => entry.operationId === operation.operationId)),
      "every offline create, edit, and delete operation must remain pending before reconnection");
    await contextA.setOffline(false);
    await pageA.evaluate(() => { window.dispatchEvent(new Event("online")); window.__dayforgeSyncBrowserHarness.wakeSync(); });
    await pageB.evaluate(() => { window.dispatchEvent(new Event("online")); window.__dayforgeSyncBrowserHarness.wakeSync(); });
    const allReconnectOperationsRecorded = async (page) => page.evaluate(({ expectedIds, editedName, deletedWorkItemId }) => {
      return window.__dayforgeSyncBrowserHarness.inspect().then((state) =>
        expectedIds.every((id) => state.recordedEvents.some((event) => event.operationId === id) &&
          !state.pending.some((entry) => entry.operationId === id)) &&
        state.planNames.includes(editedName) && !state.planNames.includes(`${editedName.replace(/-edited$/, "-original")}`) &&
        state.deletedWorkItemIds.includes(deletedWorkItemId));
    }, {
      expectedIds: reconnectOperations.map((operation) => operation.operationId),
      editedName: reconnectEditedName,
      deletedWorkItemId: reconnectWorkItem.workItemId,
    });
    await waitFor(() => allReconnectOperationsRecorded(pageA),
      "device A to reconnect and record its dependent create/edit/delete operations in MySQL", 60_000);
    await waitFor(() => allReconnectOperationsRecorded(pageB),
      "device B to pull and replay the offline create/edit/delete operation chain", 60_000);
    const [reconnectedA, reconnectedB] = await Promise.all([
      pageA.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect()),
      pageB.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect()),
    ]);
    for (const state of [reconnectedA, reconnectedB]) {
      for (const operation of reconnectOperations) {
        const recorded = state.recordedEvents.find((event) => event.operationId === operation.operationId);
        assert(recorded, "both devices must publish each reconnected operation in recorded shadow");
        assert.equal(recorded.requestHash, operation.requestHash,
          "reconnect must preserve each operation id and hash created while offline");
        assert(!state.pending.some((entry) => entry.operationId === operation.operationId),
          "reconnected operation must leave the active outbox only after it is pulled");
      }
      assert(state.planNames.includes(reconnectEditedName), "offline plan edit must survive reconnect and replay");
      assert(!state.planNames.includes(reconnectName), "offline plan replacement must win on both devices");
      assert(state.deletedWorkItemIds.includes(reconnectWorkItem.workItemId), "offline delete tombstone must survive reconnect");
    }
    console.log("Offline create/edit/delete operations reconnected in dependency order with original ids/hashes and converged through MySQL on both devices.");

    const recurrenceDates = [
      "2030-01-01", "2030-01-08", "2030-01-09", "2030-01-10", "2030-01-15", "2030-01-16",
      "2030-01-17", "2030-01-20", "2030-01-22", "2030-01-24", "2030-01-29", "2030-01-31",
    ];
    const recurrencePlan = await pageA.evaluate((planName) =>
      window.__dayforgeSyncBrowserHarness.createPlan(planName), `${name}-recurrence-plan`);
    const exceptionPlan = await pageA.evaluate((planName) =>
      window.__dayforgeSyncBrowserHarness.createPlan(planName), `${name}-recurrence-exception-plan`);
    const exceptionPlanUpdate = await pageA.evaluate(({ planId, planName, dependencyId }) =>
      window.__dayforgeSyncBrowserHarness.replacePlan(planId, planName, dependencyId), {
      planId: exceptionPlan.planId,
      planName: `${name}-recurrence-exception-plan-purple`,
      dependencyId: exceptionPlan.operationId,
    });
    const recurringSeries = await pageA.evaluate((input) =>
      window.__dayforgeSyncBrowserHarness.createRecurringTask(input), {
      planId: recurrencePlan.planId,
      dependencyIds: [recurrencePlan.operationId, exceptionPlanUpdate.operationId],
      startDate: "2030-01-01",
      weekdays: [2],
    });
    const readRecurrenceState = (page) => page.evaluate((dates) =>
      window.__dayforgeSyncBrowserHarness.inspect(dates), recurrenceDates);
    const recurringRootId = recurringSeries.workItemId;
    const recurringRecordReady = async (page, operationIds) => page.evaluate(({ dates, rootId, expectedIds }) => {
      return window.__dayforgeSyncBrowserHarness.inspect(dates).then((state) => {
        const family = state.recurrenceFamilies.find((item) => item.rootId === rootId);
        return Boolean(family) && expectedIds.every((id) => state.recordedEvents.some((event) => event.operationId === id) &&
          !state.pending.some((entry) => entry.operationId === id));
      });
    }, { dates: recurrenceDates, rootId: recurringRootId, expectedIds: operationIds });
    await waitFor(() => Promise.all([
      recurringRecordReady(pageA, [recurrencePlan.operationId, exceptionPlan.operationId, exceptionPlanUpdate.operationId, recurringSeries.operationId]),
      recurringRecordReady(pageB, [recurrencePlan.operationId, exceptionPlan.operationId, exceptionPlanUpdate.operationId, recurringSeries.operationId]),
    ]).then((results) => results.every(Boolean)), "recurrence plan and series to be stored and pulled on both devices", 60_000);

    const initialRecurrenceState = await readRecurrenceState(pageA);
    const initialFamily = initialRecurrenceState.recurrenceFamilies.find((item) => item.rootId === recurringRootId);
    assert(initialFamily, "the created recurrence family must exist in the local projection");
    const originalSegment = initialFamily.family.segments.find((segment) => segment.from_date === "2030-01-01");
    assert(originalSegment, "the recurrence must have its original segment");
    assert.equal(initialRecurrenceState.workItems.filter((item) => item.rootId === recurringRootId && item.target.kind === "occurrence").length, 5,
      "the initial Tuesday recurrence should expand into the selected visible dates");

    await contextA.setOffline(true);
    const movedFirstTuesday = await pageA.evaluate((input) =>
      window.__dayforgeSyncBrowserHarness.replaceOccurrence(input), {
      workItemId: recurringRootId,
      sourceSegmentId: originalSegment.segment_id,
      originalDate: "2030-01-08",
      data: {
        title: "Moved Tuesday exception",
        date: "2030-01-09",
        period: "afternoon",
        duration_minutes: 40,
        plan_id: exceptionPlan.planId,
        standalone_color_id: "coral",
        status: "completed",
        order_key: "1024",
      },
      dependencyIds: [recurringSeries.operationId],
    });
    const olderSameTargetEdit = await pageA.evaluate((input) =>
      window.__dayforgeSyncBrowserHarness.replaceOccurrence(input), {
      workItemId: recurringRootId,
      sourceSegmentId: originalSegment.segment_id,
      originalDate: "2030-01-22",
      data: {
        title: "Older offline same-target edit",
        date: "2030-01-22",
        period: "morning",
        duration_minutes: 25,
        plan_id: exceptionPlan.planId,
        standalone_color_id: "teal",
        status: "pending",
        order_key: "2048",
      },
      dependencyIds: [recurringSeries.operationId],
    });
    const queuedRecurrenceState = await readRecurrenceState(pageA);
    assert([movedFirstTuesday.operationId, olderSameTargetEdit.operationId].every((id) =>
      queuedRecurrenceState.pending.some((entry) => entry.operationId === id && entry.state === "queued")),
    "offline recurrence edits must remain queued with their original operation ids");

    const movedSecondTuesday = await pageB.evaluate((input) =>
      window.__dayforgeSyncBrowserHarness.replaceOccurrence(input), {
      workItemId: recurringRootId,
      sourceSegmentId: originalSegment.segment_id,
      originalDate: "2030-01-15",
      data: {
        title: "Moved second Tuesday exception",
        date: "2030-01-16",
        period: "evening",
        duration_minutes: 35,
        plan_id: exceptionPlan.planId,
        standalone_color_id: "teal",
        status: "completed",
        order_key: "1024",
      },
      dependencyIds: [recurringSeries.operationId],
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    const newerSameTargetEdit = await pageB.evaluate((input) =>
      window.__dayforgeSyncBrowserHarness.replaceOccurrence(input), {
      workItemId: recurringRootId,
      sourceSegmentId: originalSegment.segment_id,
      originalDate: "2030-01-22",
      data: {
        title: "Newer online same-target edit",
        date: "2030-01-22",
        period: "afternoon",
        duration_minutes: 50,
        plan_id: exceptionPlan.planId,
        standalone_color_id: "coral",
        status: "completed",
        order_key: "3072",
      },
      dependencyIds: [recurringSeries.operationId],
    });
    await waitFor(() => Promise.all([
      recurringRecordReady(pageB, [movedSecondTuesday.operationId, newerSameTargetEdit.operationId]),
    ]).then((results) => results.every(Boolean)), "device B's recurrence edits to be recorded before A reconnects");
    await contextA.setOffline(false);
    await pageA.evaluate(() => { window.dispatchEvent(new Event("online")); window.__dayforgeSyncBrowserHarness.wakeSync(); });
    await pageB.evaluate(() => { window.dispatchEvent(new Event("online")); window.__dayforgeSyncBrowserHarness.wakeSync(); });
    const occurrenceOperations = [movedFirstTuesday, olderSameTargetEdit, movedSecondTuesday, newerSameTargetEdit];
    await waitFor(() => Promise.all([
      recurringRecordReady(pageA, occurrenceOperations.map((operation) => operation.operationId)),
      recurringRecordReady(pageB, occurrenceOperations.map((operation) => operation.operationId)),
    ]).then((results) => results.every(Boolean)), "offline/online occurrence edits to converge in MySQL and both device projections", 90_000);
    let [occurrencesA, occurrencesB] = await Promise.all([readRecurrenceState(pageA), readRecurrenceState(pageB)]);
    const movedFirstCard = occurrencesA.workItems.filter((item) => item.rootId === recurringRootId &&
      item.target.kind === "occurrence" && item.target.original_date === "2030-01-08");
    const movedSecondCard = occurrencesA.workItems.filter((item) => item.rootId === recurringRootId &&
      item.target.kind === "occurrence" && item.target.original_date === "2030-01-15");
    const sameTargetCard = occurrencesA.workItems.filter((item) => item.rootId === recurringRootId &&
      item.target.kind === "occurrence" && item.target.original_date === "2030-01-22");
    assert.equal(movedFirstCard.length, 1, "a moved occurrence must be projected once at its effective date");
    assert.equal(movedFirstCard[0].data.date, "2030-01-09");
    assert.equal(movedSecondCard.length, 1, "an independent edit on another occurrence must also survive");
    assert.equal(movedSecondCard[0].data.date, "2030-01-16");
    assert.equal(sameTargetCard.length, 1, "same-target replacements must not create duplicate occurrence cards");
    assert.equal(sameTargetCard[0].data.title, "Newer online same-target edit",
      "the later calibrated edit must win when an older offline replacement arrives afterward");
    for (const state of [occurrencesA, occurrencesB]) {
      const family = state.recurrenceFamilies.find((item) => item.rootId === recurringRootId);
      assert(family, "each device must retain the recurrence family");
      assert.equal(family.rootHash, occurrencesA.recurrenceFamilies.find((item) => item.rootId === recurringRootId).rootHash,
        "both devices must compute the same semantic family hash after occurrence edits");
      assert(state.planColors.some((plan) => plan.id === exceptionPlan.planId && plan.colorId === "purple"),
        "the referenced exception plan and its purple color must sync");
      for (const operation of occurrenceOperations) {
        const recorded = state.recordedEvents.find((event) => event.operationId === operation.operationId);
        assert(recorded, "both devices must publish each recurrence edit in recorded shadow");
        assert.equal(recorded.requestHash, operation.requestHash, "occurrence sync must preserve the operation id and hash");
        assert(!state.pending.some((entry) => entry.operationId === operation.operationId), "synced occurrence edits must leave the outbox");
      }
    }
    console.log("Two devices converged distinct occurrence edits and a same-target LWW conflict; offline operation IDs and hashes were retained.");

    recurringLostResponse.rootId = recurringRootId;
    recurringLostResponse.action = "series.edit_future";
    recurringLostResponse.armed = true;
    const futureTemplate = {
      title: "Review after rule change",
      period: "evening",
      duration_minutes: 45,
      plan_id: recurrencePlan.planId,
      standalone_color_id: "blue",
      order_key: "0",
    };
    const futureRuleEdit = await pageA.evaluate((input) =>
      window.__dayforgeSyncBrowserHarness.editSeriesFuture(input), {
      workItemId: recurringRootId,
      sourceSegmentId: originalSegment.segment_id,
      cutoffOriginalDate: "2030-01-08",
      rule: { weekdays: [4] },
      template: futureTemplate,
      dependencyIds: [recurringSeries.operationId, exceptionPlanUpdate.operationId,
        ...occurrenceOperations.map((operation) => operation.operationId)],
    });
    const recurrenceEditRequests = () => recurringLostResponse.requestBodies.filter((raw) => {
      const request = JSON.parse(raw);
      return request.operations?.some((operation) => operation.operation_id === futureRuleEdit.operationId);
    });
    await waitFor(async () => {
      const [readyA, readyB] = await Promise.all([
        recurringRecordReady(pageA, [futureRuleEdit.operationId]),
        recurringRecordReady(pageB, [futureRuleEdit.operationId]),
      ]);
      return recurringLostResponse.lost && recurrenceEditRequests().length >= 2 && readyA && readyB;
    }, "future series edit to retry after its committed push response is lost and reach both devices", 90_000);
    const recurrenceEditRequestBodies = recurrenceEditRequests();
    assert(recurringLostResponse.lost, "the future rule edit must pass through the lost-response fault");
    assert(recurrenceEditRequestBodies.length >= 2, "the committed series edit must be retried after its response is lost");
    assert.equal(new Set(recurrenceEditRequestBodies).size, 1,
      "lost-response retry must preserve the exact byte-identical series operation body");
    [occurrencesA, occurrencesB] = await Promise.all([readRecurrenceState(pageA), readRecurrenceState(pageB)]);
    const editedFamilyA = occurrencesA.recurrenceFamilies.find((item) => item.rootId === recurringRootId);
    assert(editedFamilyA, "the future-edited family must exist");
    const newSegment = editedFamilyA.family.segments.find((segment) => segment.from_date === "2030-01-08");
    assert(newSegment, "the new rule segment must begin at the original-date cutoff");
    assert.deepEqual(newSegment.rule.weekdays, [4], "the future rule must use Thursday occurrences");
    const detachedByOriginalDate = new Map(editedFamilyA.family.detached.map((child) => [child.original_date, child]));
    assert.equal(detachedByOriginalDate.size, 3, "all edited exceptions from the cutoff must become retained detached tasks");
    assert.equal(detachedByOriginalDate.get("2030-01-08").data.date, "2030-01-09");
    assert.equal(detachedByOriginalDate.get("2030-01-08").data.plan_id, exceptionPlan.planId);
    assert.equal(detachedByOriginalDate.get("2030-01-08").data.standalone_color_id, "coral");
    assert.equal(detachedByOriginalDate.get("2030-01-15").data.date, "2030-01-16");
    assert.equal(detachedByOriginalDate.get("2030-01-22").data.title, "Newer online same-target edit");
    assert(occurrencesA.workItems.some((item) => item.rootId === recurringRootId && item.data.date === "2030-01-10" &&
      item.data.title === futureTemplate.title && item.target.kind === "occurrence"),
    "the new template must generate its Thursday occurrence after the cutoff");
    for (const state of [occurrencesA, occurrencesB]) {
      const family = state.recurrenceFamilies.find((item) => item.rootId === recurringRootId);
      assert(family, "both devices must retain the edited recurrence family");
      assert.equal(family.rootHash, editedFamilyA.rootHash, "future rule edit and detached exceptions must have matching device hashes");
      const child = family.family.detached.find((entry) => entry.original_date === "2030-01-08");
      assert(child && !child.deleted, "the moved exception must remain as a live detached task on both devices");
      assert.equal(child.data.plan_id, exceptionPlan.planId, "series edits must preserve the detached task's plan");
      assert.equal(child.data.standalone_color_id, "coral", "series edits must preserve the detached task's color");
    }
    console.log("Future rule edit retried byte-identically; detached exceptions kept their effective dates, plan ids, and colors on both devices.");

    const movedFutureOccurrence = await pageA.evaluate((input) =>
      window.__dayforgeSyncBrowserHarness.replaceOccurrence(input), {
      workItemId: recurringRootId,
      sourceSegmentId: newSegment.segment_id,
      originalDate: "2030-01-17",
      data: {
        title: "Moved future Thursday",
        date: "2030-01-20",
        period: "afternoon",
        duration_minutes: 45,
        plan_id: recurrencePlan.planId,
        standalone_color_id: "blue",
        status: "pending",
        order_key: "1024",
      },
      dependencyIds: [futureRuleEdit.operationId],
    });
    await waitFor(() => Promise.all([
      recurringRecordReady(pageA, [movedFutureOccurrence.operationId]),
      recurringRecordReady(pageB, [movedFutureOccurrence.operationId]),
    ]).then((results) => results.every(Boolean)), "the moved future occurrence to become visible on both devices");
    const beforeStop = await readRecurrenceState(pageA);
    const beforeStopFamily = beforeStop.recurrenceFamilies.find((item) => item.rootId === recurringRootId);
    assert(beforeStopFamily, "the family must be present before stopping future occurrences");
    assert(beforeStop.workItems.some((item) => item.rootId === recurringRootId && item.target.kind === "occurrence" &&
      item.target.original_date === "2030-01-17" && item.data.date === "2030-01-20"),
    "the rescheduled occurrence must be visible at its effective date before the stop");

    const stopFuture = await pageA.evaluate((input) =>
      window.__dayforgeSyncBrowserHarness.stopSeriesFuture(input), {
      workItemId: recurringRootId,
      sourceSegmentId: newSegment.segment_id,
      cutoffOriginalDate: "2030-01-17",
      dependencyIds: [futureRuleEdit.operationId, movedFutureOccurrence.operationId],
    });
    await waitFor(() => Promise.all([
      recurringRecordReady(pageA, [stopFuture.operationId]),
      recurringRecordReady(pageB, [stopFuture.operationId]),
    ]).then((results) => results.every(Boolean)), "stop-by-original-date to remove later generated and moved members on both devices");
    const [stoppedA, stoppedB] = await Promise.all([readRecurrenceState(pageA), readRecurrenceState(pageB)]);
    const stoppedFamily = stoppedA.recurrenceFamilies.find((item) => item.rootId === recurringRootId);
    assert(stoppedFamily, "the stopped family must remain for history");
    assert(stoppedA.workItems.some((item) => item.rootId === recurringRootId && item.data.date === "2030-01-01"),
      "the first historical occurrence must remain before the stop cutoff");
    assert(stoppedA.workItems.some((item) => item.rootId === recurringRootId && item.data.date === "2030-01-10" && item.target.kind === "occurrence"),
      "generated history before the stop cutoff must remain");
    assert(!stoppedA.workItems.some((item) => item.rootId === recurringRootId && item.data.date === "2030-01-20"),
      "a moved occurrence whose original date equals the cutoff must be removed");
    assert(!stoppedA.workItems.some((item) => item.rootId === recurringRootId && ["2030-01-24", "2030-01-31"].includes(item.data.date)),
      "future generated occurrences must be removed after the cutoff");
    assert.equal(stoppedFamily.family.detached.length, 3, "detached tasks must survive stopping the future series");
    assert.deepEqual(stoppedB.recurrenceFamilies.find((item) => item.rootId === recurringRootId).family, stoppedFamily.family,
      "both devices must have the same stopped history and detached exceptions");

    const undoStop = await pageA.evaluate((input) =>
      window.__dayforgeSyncBrowserHarness.undoWorkItemOperation(input), {
      workItemId: recurringRootId,
      originalOperationId: stopFuture.operationId,
    });
    await waitFor(() => Promise.all([
      recurringRecordReady(pageA, [undoStop.operationId]),
      recurringRecordReady(pageB, [undoStop.operationId]),
    ]).then((results) => results.every(Boolean)), "the atomic series-stop undo to replay on both devices");
    const [undoneA, undoneB] = await Promise.all([readRecurrenceState(pageA), readRecurrenceState(pageB)]);
    const undoneFamily = undoneA.recurrenceFamilies.find((item) => item.rootId === recurringRootId);
    assert(undoneFamily, "the undone family must remain");
    assert.equal(undoneFamily.rootHash, beforeStopFamily.rootHash, "undo must restore the exact pre-stop semantic family hash");
    assert.deepEqual(undoneA.workItems.filter((item) => item.rootId === recurringRootId),
      beforeStop.workItems.filter((item) => item.rootId === recurringRootId),
    "undo must restore the complete recurrence projection, including the moved member and detached children");
    assert.deepEqual(undoneB.recurrenceFamilies.find((item) => item.rootId === recurringRootId).family, undoneFamily.family,
      "both devices must converge to the same restored family after undo");
    const recurrenceOperations = [recurrencePlan, exceptionPlan, exceptionPlanUpdate, recurringSeries,
      ...occurrenceOperations, futureRuleEdit, movedFutureOccurrence, stopFuture, undoStop];
    for (const state of [undoneA, undoneB]) {
      for (const operation of recurrenceOperations) {
        const recorded = state.recordedEvents.find((event) => event.operationId === operation.operationId);
        assert(recorded, "the complete recurrence operation history must be recorded on both devices");
        assert.equal(recorded.requestHash, operation.requestHash, "the recurrence history must retain every original operation hash");
        assert(!state.pending.some((entry) => entry.operationId === operation.operationId), "no recurrence operation may remain pending after convergence");
      }
    }
    assert.equal(undoneA.recurrenceFamilies.find((item) => item.rootId === recurringRootId).rootHash,
      undoneB.recurrenceFamilies.find((item) => item.rootId === recurringRootId).rootHash,
    "the final semantic recurrence hashes must agree across device lanes");
    console.log("Stop-by-original-date removed a moved member while retaining history and detached tasks; atomic undo restored both device projections and matching hashes.");

    // Drain in-flight pull handlers before installing the next fault injector.
    await contextB.unrouteAll({ behavior: "wait" });
    const pullAbortName = `${name}-pull-transaction-abort`;
    let pullAbortResponseCount = 0;
    let signalFirstPullAbortResponse = () => {};
    let releaseFirstPullAbortResponse = () => {};
    let signalRetryPullAbortResponse = () => {};
    let releaseRetryPullAbortResponse = () => {};
    const firstPullAbortResponseHeld = new Promise((resolve) => { signalFirstPullAbortResponse = resolve; });
    const firstPullAbortResponseGate = new Promise((resolve) => { releaseFirstPullAbortResponse = resolve; });
    const retryPullAbortResponseHeld = new Promise((resolve) => { signalRetryPullAbortResponse = resolve; });
    const retryPullAbortResponseGate = new Promise((resolve) => { releaseRetryPullAbortResponse = resolve; });
    await contextB.route("**/api/v1/sync/pull**", async (route) => {
      const response = await route.fetch();
      const rawResponse = await response.body();
      const body = JSON.parse(rawResponse.toString("utf8"));
      const containsAbortPlan = (body.groups ?? []).some((group) =>
        group.operation.commands?.some((command) => command.payload?.data?.name === pullAbortName));
      if (containsAbortPlan) {
        pullAbortResponseCount += 1;
        if (pullAbortResponseCount === 1) {
          signalFirstPullAbortResponse();
          await firstPullAbortResponseGate;
        } else if (pullAbortResponseCount === 2) {
          signalRetryPullAbortResponse();
          await retryPullAbortResponseGate;
        }
      }
      await route.fulfill({
        status: response.status(),
        headers: { "cache-control": "private, no-store", "content-type": "application/json" },
        body: rawResponse,
      });
    });
    await pageB.evaluate(() => window.__dayforgeSyncBrowserHarness.wakeSync());
    const pullAbortOperation = await pageA.evaluate((planName) =>
      window.__dayforgeSyncBrowserHarness.createPlan(planName), pullAbortName);
    await waitFor(() => isRecorded(pageA, pullAbortName, pullAbortOperation.operationId),
      "device A to record the operation used for pull transaction abort");
    await waitFor(() => Promise.race([
      firstPullAbortResponseHeld.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 45_000)),
    ]), "device B to hold the pull page before ingestion");
    const beforePullAbort = await pageB.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
    await pageB.evaluate(() => window.__dayforgeSyncBrowserHarness.armOwnerWriteAbortForTest("pull-page"));
    releaseFirstPullAbortResponse();
    await waitFor(() => pageB.evaluate(() =>
      window.__dayforgeSyncBrowserHarness.ownerWriteAbortStateForTest()?.injectedTargets.includes("pull-page") === true),
    "pull ingestion transaction to abort before its owner revision commit");
    await waitFor(() => Promise.race([
      retryPullAbortResponseHeld.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 45_000)),
    ]), "device B to retry and hold the same uncommitted pull page");
    assert.deepEqual(await pageB.evaluate(() => window.__dayforgeSyncBrowserHarness.disarmOwnerWriteAbortForTest()), ["pull-page"],
      "the pull ingestion fault hook must abort exactly one owner transaction");
    const afterPullAbort = await pageB.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
    assert.equal(afterPullAbort.pullCursor, beforePullAbort.pullCursor,
      "an aborted pull page must not advance its committed cursor");
    assert(!afterPullAbort.recordedEvents.some((event) => event.operationId === pullAbortOperation.operationId),
      "an aborted pull page must not publish its event into the recorded shadow");
    assert(!afterPullAbort.planNames.includes(pullAbortName),
      "an aborted pull page must not publish its projection");
    console.log("An aborted pull-page transaction left cursor, recorded shadow, and projection unchanged before retry.");
    releaseRetryPullAbortResponse();
    await waitFor(() => isRecorded(pageB, pullAbortName, pullAbortOperation.operationId),
      "device B to publish the unchanged pull page after retry", 45_000);
    await contextB.unrouteAll({ behavior: "wait" });
    console.log("Device B committed the exact pull page after retry with no partial state from the aborted transaction.");

    const [finalA, finalB] = await Promise.all([
      pageA.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect()),
      pageB.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect()),
    ]);
    assert.equal(finalA.ownerId, finalB.ownerId);
    assert.notEqual(finalA.deviceId, finalB.deviceId);
    assert.equal(finalA.serverEpoch, finalB.serverEpoch);
    assert(finalA.planNames.includes(name));
    assert(finalB.planNames.includes(name));
    assert(finalA.planNames.includes(localRaceName));
    assert(finalB.planNames.includes(localRaceName));
    const eventA = finalA.recordedEvents.find((event) => event.operationId === operationId);
    const eventB = finalB.recordedEvents.find((event) => event.operationId === operationId);
    const raceEventA = finalA.recordedEvents.find((event) => event.operationId === localRace.operationId);
    const raceEventB = finalB.recordedEvents.find((event) => event.operationId === localRace.operationId);
    assert(eventA && eventB, "both device shadows must contain the pushed event");
    assert(raceEventA && raceEventB, "both device shadows must retain the save that raced with pull ingestion");
    assert.equal(eventA.requestHash, created.requestHash, "recorded event hash must match the exact local request hash");
    assert.equal(eventB.requestHash, created.requestHash, "second device must pull the same immutable operation hash");
    assert.equal(raceEventA.requestHash, localRace.requestHash);
    assert.equal(raceEventB.requestHash, localRace.requestHash);
    const pushResponse = evidenceA.pushes.flatMap((entry) => entry.body?.results ?? [])
      .find((entry) => entry.operation_id === operationId && ["recorded", "duplicate"].includes(entry.status));
    assert(pushResponse?.receipt, "API push response must include the operation receipt");
    assert.equal(pushResponse.receipt.request_hash, created.requestHash);
    assert.equal(pushResponse.receipt.commit_cursor, eventA.cursor);
    const operationPushIndexes = pushFaultEvidence.serverResponses
      .map((response, index) => response?.results?.some((entry) => entry.operation_id === operationId) ? index : -1)
      .filter((index) => index >= 0);
    assert.equal(operationPushIndexes.length, 2, "the committed operation must be retried once after its response is lost");
    const [firstOperationPushIndex, retryOperationPushIndex] = operationPushIndexes;
    assert.equal(pushFaultEvidence.requestBodies[firstOperationPushIndex], pushFaultEvidence.requestBodies[retryOperationPushIndex],
      "the retry must send the byte-identical request body");
    const originalOperationResult = pushFaultEvidence.serverResponses[firstOperationPushIndex].results.find((entry) => entry.operation_id === operationId);
    const retryOperationResult = pushFaultEvidence.serverResponses[retryOperationPushIndex].results.find((entry) => entry.operation_id === operationId);
    const originalReceipt = originalOperationResult?.receipt;
    const retryReceipt = retryOperationResult?.receipt;
    assert.equal(originalOperationResult?.status, "recorded");
    assert.equal(retryOperationResult?.status, "duplicate");
    assert.equal(originalReceipt.commit_cursor, retryReceipt.commit_cursor, "duplicate retry must return the original commit cursor");
    assert.equal(originalReceipt.request_hash, retryReceipt.request_hash);
    const returnedGroups = [...evidenceB.pulls, ...evidenceB.bootstraps]
      .flatMap((entry) => entry.body?.groups ?? []);
    assert(returnedGroups.some((group) => group.operation.operation_id === operationId && group.cursor === eventB.cursor),
      "B's API response must contain the event at the cursor committed to local shadow");
    assert(BigInt(finalA.pullCursor) >= BigInt(eventA.cursor));
    assert(BigInt(finalB.pullCursor) >= BigInt(eventB.cursor));

    const beforeMutationAbort = await pageA.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
    await assert.rejects(
      pageA.evaluate(() => window.__dayforgeSyncBrowserHarness.abortNextOwnerWriteForTest("mutation")),
      /transaction failed|abort/i,
      "an aborted owner transaction must fail the local mutation",
    );
    const afterMutationAbort = await pageA.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
    assert.equal(afterMutationAbort.localStateRevision, beforeMutationAbort.localStateRevision,
      "an aborted local mutation must not advance the owner revision");
    assert.deepEqual(afterMutationAbort.pending, beforeMutationAbort.pending,
      "an aborted local mutation must not leave an outbox entry");
    assert.deepEqual(afterMutationAbort.planNames, beforeMutationAbort.planNames,
      "an aborted local mutation must not alter the projection");
    assert.deepEqual(afterMutationAbort.recordedEvents, beforeMutationAbort.recordedEvents,
      "an aborted local mutation must not alter recorded shadow");
    console.log("An injected IndexedDB transaction abort rolled back the local mutation, outbox, projection, and revision atomically.");

    const sameDeviceTab = await contextA.newPage();
    await sameDeviceTab.goto("/sync-browser");
    await sameDeviceTab.getByText("Test sync harness sẵn sàng.").waitFor({ state: "visible" });
    await sameDeviceTab.waitForFunction(() => Boolean(window.__dayforgeSyncBrowserHarness));
    const sameDeviceState = await sameDeviceTab.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
    assert.equal(sameDeviceState.ownerId, initialA.ownerId, "a tab in the same browser profile must retain the local owner");
    assert.equal(sameDeviceState.deviceId, initialA.deviceId, "tabs in the same browser profile must share the device lane");
    await waitFor(() => sameDeviceTab.evaluate(() => window.__dayforgeSyncBrowserHarness.wakeSync()),
      "same-profile second tab coordinator to become ready before the failover test");
    const profilePages = [pageA, sameDeviceTab];
    await waitFor(async () => {
      const states = await Promise.all(profilePages.map((page) => page.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorState())));
      return states.filter((state) => state !== "waiting_for_leader" && state !== "stopped").length === 1;
    }, "exactly one tab in the shared profile to hold sync leadership");
    const profileStates = await Promise.all(profilePages.map((page) => page.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorState())));
    let leaderIndex = profileStates.findIndex((state) => state !== "waiting_for_leader" && state !== "stopped");
    let leaderPage = profilePages[leaderIndex];
    let successorPage = profilePages[1 - leaderIndex];
    evidenceSuccessor = watchSyncResponses(successorPage);
    let leaseBeforeFailover = await leaderPage.evaluate(() => window.__dayforgeSyncBrowserHarness.leaseState());
    assert(leaseBeforeFailover && leaseBeforeFailover.fencing_token > 0, "the active profile leader must own a durable fencing token");

    const idleLeaderCdp = await contextA.newCDPSession(leaderPage);
    const idleFreezeStartedMs = Date.now();
    await pausePageExecution(idleLeaderCdp);
    await waitFor(async () => {
      const [state, lease] = await Promise.all([
        successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorState()),
        successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.leaseState()),
      ]);
      return state !== "waiting_for_leader" && state !== "stopped" &&
        lease?.fencing_token > leaseBeforeFailover.fencing_token &&
        lease.expires_at_ms > Date.now() + 8_000 && Date.now() - idleFreezeStartedMs >= 3 * 12_000;
    }, "an idle frozen leader to be replaced naturally while its successor renews through three lease TTLs", 55_000);
    const leaseAfterLongFreeze = await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.leaseState());
    await idleLeaderCdp.send("Debugger.resume");
    await waitFor(() => leaderPage.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorState())
      .then((state) => state === "waiting_for_leader"), "the resumed suspended tab to observe its lost fencing token", 15_000);
    await idleLeaderCdp.detach();
    [leaderPage, successorPage] = [successorPage, leaderPage];
    leaderIndex = profilePages.indexOf(leaderPage);
    leaseBeforeFailover = leaseAfterLongFreeze;
    console.log("An idle leader stayed frozen across three lease TTLs; its successor took over and kept renewing without forced lease edits.");

    await leaderPage.bringToFront();
    await waitFor(() => leaderPage.evaluate(() => document.visibilityState === "visible"),
      "the successor leader tab to become visible before the stale-response test");
    await leaderPage.evaluate(() => { window.dispatchEvent(new Event("online")); window.__dayforgeSyncBrowserHarness.wakeSync(); });
    await waitFor(async () => {
      const [state, lease] = await Promise.all([
        leaderPage.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorState()),
        leaderPage.evaluate(() => window.__dayforgeSyncBrowserHarness.leaseState()),
      ]);
      return state === "syncing" && lease?.fencing_token === leaseBeforeFailover.fencing_token &&
        lease.expires_at_ms > Date.now();
    }, "the promoted tab to hold its renewed leader lease before the stale-response test");
    const staleLeaderPlan = `${name}-stale-leader-response`;
    const beforeStaleLeader = await leaderPage.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
    assert.equal(beforeStaleLeader.pending.length, 0, "stale-response fencing begins with an empty active outbox");
    const stalePushStartIndex = pushFaultEvidence.requestBodies.length;
    staleLeaderResponse.armed = true;
    const staleLeaderOperation = await leaderPage.evaluate(
      async (planName) => {
        const operation = await window.__dayforgeSyncBrowserHarness.createPlan(planName);
        window.dispatchEvent(new Event("online"));
        return { ...operation, syncWoken: window.__dayforgeSyncBrowserHarness.wakeSync() };
      },
      staleLeaderPlan,
    );
    assert(staleLeaderOperation.syncWoken, "the successor leader coordinator must be available to push the stale-response operation");
    try {
      await waitFor(() => staleLeaderResponse.held,
        "the old leader's push response to arrive from the server and pause before the browser receives it");
    } catch (error) {
      const diagnostics = await leaderPage.evaluate(async () => ({
        online: navigator.onLine,
        visibility: document.visibilityState,
        coordinator: window.__dayforgeSyncBrowserHarness.coordinatorDetails(),
        lease: await window.__dayforgeSyncBrowserHarness.leaseState(),
        state: await window.__dayforgeSyncBrowserHarness.inspect(),
      }));
      const observedPushes = pushFaultEvidence.requestBodies.slice(stalePushStartIndex).map((body) => {
        const request = JSON.parse(body);
        return (request.operations ?? []).map((operation) => ({
          operationId: operation.operation_id,
          actions: operation.commands?.map((command) => command.action),
          planNames: operation.commands?.map((command) => command.payload?.data?.name).filter(Boolean),
        }));
      });
      console.error("Stale leader push diagnostics:", JSON.stringify({
        online: diagnostics.online,
        visibility: diagnostics.visibility,
        coordinator: diagnostics.coordinator,
        lease: diagnostics.lease,
        pending: diagnostics.state.pending,
        recorded: diagnostics.state.recordedEvents.filter((event) => event.operationId === staleLeaderOperation.operationId),
        observedPushes,
      }));
      throw error;
    }
    const staleLeaderCdp = await contextA.newCDPSession(leaderPage);
    await staleLeaderCdp.send("Page.setWebLifecycleState", { state: "frozen" });
    const injectedFence = await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.fenceLeaseForTest());
    assert(injectedFence.fencingToken > injectedFence.previousToken, "fault injection must advance the persisted fencing token");
    await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.expireFencedLeaseForTest());
    releaseStaleLeaderResponse();
    await waitFor(async () => {
      const [state, lease] = await Promise.all([
        successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorState()),
        successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.leaseState()),
      ]);
      return state !== "waiting_for_leader" && state !== "stopped" && lease?.fencing_token > injectedFence.fencingToken;
    }, "a successor leader to acquire a newer lease after the stale callback is fenced", 20_000);
    await waitFor(() => isRecorded(successorPage, staleLeaderPlan, staleLeaderOperation.operationId),
      "the successor to retry and reconcile the committed operation after takeover", 45_000);
    await staleLeaderCdp.send("Page.setWebLifecycleState", { state: "active" });
    await staleLeaderCdp.detach();
    await waitFor(async () => {
      const state = await leaderPage.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
      return !state.pending.some((entry) => entry.operationId === staleLeaderOperation.operationId);
    }, "the resumed stale leader to observe the successor's committed state without recreating pending work", 15_000);
    await waitFor(() => isRecorded(pageB, staleLeaderPlan, staleLeaderOperation.operationId),
      "the independent device to pull the operation after stale-response recovery", 45_000);
    const stalePushBodies = pushFaultEvidence.requestBodies.slice(stalePushStartIndex)
      .filter((body) => JSON.parse(body).operations?.some((operation) => operation.operation_id === staleLeaderOperation.operationId));
    assert.equal(stalePushBodies.length, 2, "the successor must retry the one committed operation after the stale callback is fenced");
    assert.equal(stalePushBodies[0], stalePushBodies[1], "the successor retry must preserve the exact operation envelope bytes");
    const stalePushStatuses = pushFaultEvidence.serverResponses.slice(stalePushStartIndex)
      .flatMap((response) => response.results?.filter((result) => result.operation_id === staleLeaderOperation.operationId)
        .map((result) => result.status) ?? []);
    assert.deepEqual(stalePushStatuses, ["recorded", "duplicate"], "the original response must represent a server commit and the successor response its idempotent retry");
    console.log("A frozen leader could not run its delayed ACK; the successor retried the identical envelope, then the resumed leader observed the committed state.");

    await leaderPage.evaluate(() => window.__dayforgeSyncBrowserHarness.stopSync());
    await waitFor(async () => {
      const state = await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorState());
      return state !== "waiting_for_leader" && state !== "stopped";
    }, "the remaining same-profile tab to acquire leadership after clean leader shutdown");
    const leaseAfterFailover = await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.leaseState());
    assert(leaseAfterFailover && leaseAfterFailover.fencing_token > leaseBeforeFailover.fencing_token,
      "a successor must receive a strictly newer fencing token after the prior leader releases its lease");
    const failoverName = `${name}-leader-failover`;
    const failoverOperation = await successorPage.evaluate((planName) => window.__dayforgeSyncBrowserHarness.createPlan(planName), failoverName);
    await waitFor(() => isRecorded(successorPage, failoverName, failoverOperation.operationId),
      "the successor leader to recover and push a local operation");
    await waitFor(() => isRecorded(pageB, failoverName, failoverOperation.operationId),
      "the independent device to pull the successor leader's operation");
    console.log("A successor tab acquired a strictly newer fencing token and continued syncing after leader shutdown.");

    const processDeathPages = [await contextA.newPage(), await contextA.newPage()];
    for (const page of processDeathPages) {
      await page.goto("/sync-browser");
      await page.getByText("Test sync harness sẵn sàng.").waitFor({ state: "visible" });
      await page.waitForFunction(() => Boolean(window.__dayforgeSyncBrowserHarness));
      await page.evaluate(() => window.__dayforgeSyncBrowserHarness.wakeSync());
    }
    profilePages.push(...processDeathPages);
    await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.stopSync());
    await waitFor(async () => {
      const states = await Promise.all(processDeathPages.map((page) =>
        page.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorState())));
      return states.filter((state) => state !== "waiting_for_leader" && state !== "stopped").length === 1;
    }, "a fresh same-profile tab to acquire leadership before the process-death case");
    const preCrashStates = await Promise.all(processDeathPages.map((page) =>
      page.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorState())));
    const processDeathLeaderIndex = preCrashStates.findIndex((state) => state !== "waiting_for_leader" && state !== "stopped");
    const processDeathLeaderPage = processDeathPages[processDeathLeaderIndex];
    const processDeathSuccessorPage = processDeathPages[1 - processDeathLeaderIndex];
    const leaseBeforeProcessDeath = await processDeathLeaderPage.evaluate(() => window.__dayforgeSyncBrowserHarness.leaseState());
    assert(leaseBeforeProcessDeath, "the renderer selected for process death must hold the owner lease");
    const processDeathPlan = `${name}-process-death-in-flight`;
    const processDeathStartIndex = pushFaultEvidence.requestBodies.length;
    processDeathResponse.armed = true;
    const processDeathOperation = await processDeathLeaderPage.evaluate(
      (planName) => window.__dayforgeSyncBrowserHarness.createPlan(planName),
      processDeathPlan,
    );
    await waitFor(() => processDeathResponse.held,
      "the server to commit the process-death operation while its response is held");
    processDeathResponse.terminated = true;
    await processDeathLeaderPage.close({ runBeforeUnload: false });
    releaseProcessDeathResponse();
    await waitFor(async () => {
      const [state, lease] = await Promise.all([
        processDeathSuccessorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorState()),
        processDeathSuccessorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.leaseState()),
      ]);
      return state !== "waiting_for_leader" && state !== "stopped" &&
        lease?.fencing_token > leaseBeforeProcessDeath.fencing_token;
    }, "a new leader to claim the abandoned sending row after the leader tab is terminated", 30_000);
    await waitFor(() => isRecorded(processDeathSuccessorPage, processDeathPlan, processDeathOperation.operationId),
      "the successor to retry and pull the operation whose leader renderer crashed", 45_000);
    await waitFor(() => isRecorded(pageB, processDeathPlan, processDeathOperation.operationId),
      "the independent device to pull the operation recovered after leader termination", 45_000);
    const processDeathBodies = pushFaultEvidence.requestBodies.slice(processDeathStartIndex)
      .filter((body) => JSON.parse(body).operations?.some((operation) => operation.operation_id === processDeathOperation.operationId));
    const processDeathStatuses = pushFaultEvidence.serverResponses.slice(processDeathStartIndex)
      .flatMap((response) => response.results?.filter((result) => result.operation_id === processDeathOperation.operationId)
        .map((result) => result.status) ?? []);
    assert.equal(processDeathBodies.length, 2, "the recovered sender must retry the operation committed by the terminated leader");
    assert.equal(processDeathBodies[0], processDeathBodies[1], "process-death recovery must preserve the original envelope bytes");
    assert.deepEqual(processDeathStatuses, ["recorded", "duplicate"], "the process-death retry must use the original receipt");
    profilePages.splice(profilePages.indexOf(processDeathLeaderPage), 1);
    successorPage = processDeathSuccessorPage;
    evidenceSuccessor = watchSyncResponses(successorPage);
    console.log("The leader tab was terminated after server commit with the response in flight; a fresh tab retried the exact envelope and both devices converged.");

    const clockRepairName = `${name}-clock-repair`;
    const invalidClockOperation = await successorPage.evaluate(
      (planName) => window.__dayforgeSyncBrowserHarness.createPlan(planName, 3_600_000),
      clockRepairName,
    );
    try {
      await waitFor(async () => {
        const state = await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
        return state.pending.some((entry) => entry.operationId === invalidClockOperation.operationId && entry.state === "quarantined");
      }, "the future-dated operation to be quarantined after the server clock guard rejects it", 15_000);
    } catch (error) {
      const [clockState, clockStatus] = await Promise.all([
        successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect()).catch((cause) => ({ error: String(cause) })),
        successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorDetails()).catch((cause) => ({ error: String(cause) })),
      ]);
      const recentPushes = pushFaultEvidence.serverResponses.slice(-3).map((response) => response.results);
      console.error("Clock rejection diagnostics:", JSON.stringify({
        invalidClockOperation,
        clockStatus,
        clockState,
        recentPushes,
        recentPushResponses: pushFaultEvidence.serverResponseDetails.slice(-3),
      }, null, 2));
      throw error;
    }
    await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.repairClockIssues());
    const alreadyRecordedIds = new Set([
      operationId,
      localRace.operationId,
      ...reconnectOperations.map((operation) => operation.operationId),
      failoverOperation.operationId,
    ]);
    let reauthOperationId = null;
    try {
      await waitFor(async () => {
        const [repairedA, repairedB] = await Promise.all([
          successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect()),
          pageB.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect()),
        ]);
        const newEvent = repairedA.recordedEvents.find((event) => !alreadyRecordedIds.has(event.operationId));
        if (!newEvent || !repairedA.diagnosticIds.includes(invalidClockOperation.operationId) ||
            repairedA.recordedEvents.some((event) => event.operationId === invalidClockOperation.operationId) ||
            repairedA.pending.some((entry) => entry.operationId === invalidClockOperation.operationId)) return false;
        const replicated = repairedB.recordedEvents.some((event) => event.operationId === newEvent.operationId) &&
          repairedB.planNames.includes(clockRepairName);
        if (replicated) reauthOperationId = newEvent.operationId;
        return replicated && repairedA.planNames.includes(clockRepairName);
      }, "clock repair to archive the rejected original and sync a semantic replacement to both devices", 60_000);
    } catch (error) {
      const diagnostics = await Promise.all([successorPage, pageB].map(async (page) => ({
        coordinator: await page.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorDetails()).catch((cause) => ({ error: String(cause) })),
        state: await page.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect()).catch((cause) => ({ error: String(cause) })),
      })));
      console.error("Clock reauthor diagnostics:", JSON.stringify({
        invalidClockOperation,
        diagnostics,
        recentPushResponses: pushFaultEvidence.serverResponseDetails.slice(-5),
      }, null, 2));
      throw error;
    }
    assert(reauthOperationId, "clock repair must produce a new recorded operation id");
    console.log("Clock repair recalibrated, reauthored the rejected operation on a new lane, and archived its original.");

    const recoveryOperationIds = [
      operationId,
      localRace.operationId,
      ...reconnectOperations.map((operation) => operation.operationId),
      pullAbortOperation.operationId,
      failoverOperation.operationId,
      processDeathOperation.operationId,
      reauthOperationId,
    ];
    const beforeJournalAbort = await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
    assert(recoveryOperationIds.every((id) => beforeJournalAbort.recordedEvents.some((event) => event.operationId === id)),
      `all ${recoveryOperationIds.length} events must be acknowledged and present in shadow before simulating server restore`);
    assert.equal(beforeJournalAbort.pending.length, 0, "server restore must begin after every local outbox entry has been pulled");
    const recoveryLease = await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.leaseState());
    assert(recoveryLease, "recovery transaction-abort injection requires the current owner leader lease");
    await assert.rejects(
      successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.abortNextOwnerWriteForTest("recovery-journal")),
      /transaction failed|abort/i,
      "an aborted owner transaction must fail without partially publishing the recovery journal",
    );
    const afterRecoveryJournalAbort = await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
    assert.equal(afterRecoveryJournalAbort.localStateRevision, beforeJournalAbort.localStateRevision,
      "an aborted recovery journal must not advance the owner revision");
    assert.equal(afterRecoveryJournalAbort.journalCount, beforeJournalAbort.journalCount,
      "an aborted recovery journal must leave no partial journal rows");
    assert.equal(afterRecoveryJournalAbort.pullCursor, beforeJournalAbort.pullCursor,
      "an aborted recovery journal must not alter the committed pull cursor");
    assert.deepEqual(afterRecoveryJournalAbort.recordedEvents, beforeJournalAbort.recordedEvents,
      "an aborted recovery journal must not alter the recorded shadow");
    console.log("An injected IndexedDB transaction abort during recovery journal persistence left revision, cursor, shadow, and journal unchanged.");
    const beforeRestore = await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
    assert(recoveryOperationIds.every((id) => beforeRestore.recordedEvents.some((event) => event.operationId === id)),
      `all ${recoveryOperationIds.length} events must be acknowledged and present in shadow before simulating server restore`);
    assert.equal(beforeRestore.pending.length, 0, "server restore must begin after every local outbox entry has been pulled");
    let secondRestoreEpoch = null;
    let recoveryBootstrapCount = 0;
    let deviceBConflictSeen = false;
    let releaseDeviceBConflict = () => {};
    const deviceBConflictGate = new Promise((resolve) => { releaseDeviceBConflict = resolve; });
    await contextB.route("**/api/v1/sync/pull**", async (route) => {
      const response = await route.fetch();
      const body = await response.body();
      let problem = null;
      try { problem = JSON.parse(body.toString("utf8")); } catch { /* Preserve malformed responses for the client. */ }
      if (response.status() === 409 && problem?.code === "cursor_epoch_mismatch") {
        deviceBConflictSeen = true;
        await deviceBConflictGate;
      }
      await route.fulfill({ response, body });
    });
    await contextA.route("**/api/v1/sync/bootstrap**", async (route) => {
      const response = await route.fetch();
      const body = await response.body();
      recoveryBootstrapCount += 1;
      if (recoveryBootstrapCount === 1) {
        console.log("Holding the first recovered bootstrap response while advancing the isolated server epoch again.");
        secondRestoreEpoch = await waitForTestEpochRestore(beforeRestore.ownerId);
        await successorPage.evaluate(() =>
          window.__dayforgeSyncBrowserHarness.armOwnerWriteAbortForTest("bootstrap-stage"));
      }
      await route.fulfill({ response, body });
    });
    const restoredEpoch = await waitForTestEpochRestore(beforeRestore.ownerId);
    if (restoredEpoch) {
      assert.match(restoredEpoch, /^[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.wakeSync());
      await waitFor(() => successorPage.evaluate(() =>
        window.__dayforgeSyncBrowserHarness.ownerWriteAbortStateForTest()?.injectedTargets.length === 1),
      "the first recovery staging transaction to hit its injected abort", 60_000);
      const stageAbortHook = await successorPage.evaluate(() =>
        window.__dayforgeSyncBrowserHarness.ownerWriteAbortStateForTest());
      assert.deepEqual(stageAbortHook?.injectedTargets, ["bootstrap-stage"],
        "the first injected recovery failure must abort exactly one staging transaction");
      const afterStageAbort = await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
      assert.equal(afterStageAbort.serverEpoch, beforeRestore.serverEpoch,
        "an aborted recovery staging transaction must not advance the owner server epoch");
      assert.equal(afterStageAbort.pullCursor, beforeRestore.pullCursor,
        "an aborted recovery staging transaction must not advance the owner cursor");
      assert.deepEqual(afterStageAbort.recordedEvents, beforeRestore.recordedEvents,
        "an aborted recovery staging transaction must retain the prior recorded shadow");
      assert(afterStageAbort.journalCount > 0,
        "the recovery journal must remain available after staging aborts");
      await Promise.all(profilePages.map((page) => page.evaluate(() => window.__dayforgeSyncBrowserHarness.stopSync())));
      await successorPage.addInitScript(() => {
        const key = "dayforge-sync-test-recovery-publish-abort-armed";
        if (sessionStorage.getItem(key)) return;
        sessionStorage.setItem(key, "1");
        window.__dayforgeSyncTestAbortOnReady = "recovery-publish";
      });
      await successorPage.reload();
      await successorPage.waitForFunction(() => Boolean(window.__dayforgeSyncBrowserHarness), { timeout: 30_000 });
      await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.wakeSync());
      await waitFor(() => successorPage.evaluate(() =>
        window.__dayforgeSyncBrowserHarness.ownerWriteAbortStateForTest()?.injectedTargets.length === 1),
      "the recovery generation publication transaction to hit its injected abort after restart", 60_000);
      const publishAbortHook = await successorPage.evaluate(() =>
        window.__dayforgeSyncBrowserHarness.ownerWriteAbortStateForTest());
      assert.deepEqual(publishAbortHook?.injectedTargets, ["recovery-publish"],
        "the restarted recovery must abort exactly one generation publication transaction");
      const afterPublishAbort = await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
      assert.equal(afterPublishAbort.serverEpoch, beforeRestore.serverEpoch,
        "an aborted recovery publication must not advance the owner server epoch");
      assert.equal(afterPublishAbort.pullCursor, beforeRestore.pullCursor,
        "an aborted recovery publication must not advance the owner cursor");
      assert.deepEqual(afterPublishAbort.recordedEvents, beforeRestore.recordedEvents,
        "an aborted recovery publication must retain the prior recorded shadow");
      assert(afterPublishAbort.journalCount > 0,
        "the recovery journal must remain available after the generation publish abort");
      await Promise.all(profilePages.map((page) => page.evaluate(() => window.__dayforgeSyncBrowserHarness.stopSync())));
      const recoveryPushStartIndex = pushFaultEvidence.requestBodies.length;
      recoveryProcessDeathResponse.armed = true;
      await successorPage.reload();
      await successorPage.waitForFunction(() => Boolean(window.__dayforgeSyncBrowserHarness), { timeout: 30_000 });
      await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.wakeSync());
      await waitFor(() => recoveryProcessDeathResponse.held,
        "the server to commit a recovery reupload while the leader response is held", 60_000);
      const recoveryPushCandidateIndex = pushFaultEvidence.requestBodies.findIndex((body, index) => index >= recoveryPushStartIndex &&
        JSON.parse(body).operations?.some((operation) => recoveryOperationIds.includes(operation.operation_id)));
      assert(recoveryPushCandidateIndex >= 0, "the held push must contain a previously acknowledged recovery operation");
      const recoveryPushRequest = pushFaultEvidence.requestBodies[recoveryPushCandidateIndex];
      const recoveryReuploadOperationId = JSON.parse(recoveryPushRequest).operations
        .find((operation) => recoveryOperationIds.includes(operation.operation_id)).operation_id;
      const recoveryLeaderLease = await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.leaseState());
      assert(recoveryLeaderLease, "the recovery process-death injection requires the current owner leader lease");
      recoveryProcessDeathResponse.terminated = true;
      const crashedRecoveryPage = successorPage;
      await crashedRecoveryPage.close({ runBeforeUnload: false });
      releaseRecoveryProcessDeathResponse();

      const recoveryResumePage = await contextA.newPage();
      const crashedPageIndex = profilePages.indexOf(crashedRecoveryPage);
      if (crashedPageIndex >= 0) profilePages.splice(crashedPageIndex, 1);
      profilePages.push(recoveryResumePage);
      await recoveryResumePage.goto("/sync-browser");
      await recoveryResumePage.getByText("Test sync harness sẵn sàng.").waitFor({ state: "visible" });
      await recoveryResumePage.waitForFunction(() => Boolean(window.__dayforgeSyncBrowserHarness));
      await recoveryResumePage.evaluate(() => window.__dayforgeSyncBrowserHarness.wakeSync());
      await waitFor(async () => {
        const [state, lease] = await Promise.all([
          recoveryResumePage.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorState()),
          recoveryResumePage.evaluate(() => window.__dayforgeSyncBrowserHarness.leaseState()),
        ]);
        return state !== "waiting_for_leader" && state !== "stopped" && lease?.fencing_token > recoveryLeaderLease.fencing_token;
      }, "a fresh tab to take over the crashed recovery upload leader", 30_000);
      successorPage = recoveryResumePage;
      await waitFor(() => successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect())
        .then((state) => state.recordedEvents.some((event) => event.operationId === recoveryReuploadOperationId)),
      "the restarted leader to reconcile the reuploaded operation after a byte-identical retry", 60_000);
      const recoveryRetryBodies = pushFaultEvidence.requestBodies.slice(recoveryPushStartIndex)
        .filter((body) => JSON.parse(body).operations?.some((operation) => operation.operation_id === recoveryReuploadOperationId));
      const recoveryRetryStatuses = pushFaultEvidence.serverResponses.slice(recoveryPushStartIndex)
        .flatMap((response) => response.results?.filter((result) => result.operation_id === recoveryReuploadOperationId)
          .map((result) => result.status) ?? []);
      assert.equal(recoveryRetryBodies.length, 2, "the recovered upload must be retried after leader termination");
      assert.equal(recoveryRetryBodies[0], recoveryRetryBodies[1], "recovery upload retry must preserve the complete envelope bytes");
      assert.deepEqual(recoveryRetryStatuses, ["recorded", "duplicate"], "recovery upload must reconcile the original server receipt");
      evidenceSuccessor = watchSyncResponses(successorPage);
      console.log("The recovery reupload leader was terminated after server commit with its response held; a fresh tab retried identical bytes and reconciled the duplicate receipt.");
      console.log("Stage and publish transaction aborts each preserved the old generation; page restarts resumed the journaled recovery.");
      try {
        await waitFor(async () => {
          const recoveredA = await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
          const expectedRecoveryEpoch = secondRestoreEpoch ?? restoredEpoch;
          return recoveredA.serverEpoch === expectedRecoveryEpoch && recoveredA.journalCount === 0 &&
            recoveredA.pending.length === 0 && recoveryOperationIds.every((id) =>
              recoveredA.recordedEvents.some((event) => event.operationId === id));
        }, "the restarted device to recover its acknowledged union after the isolated server epoch reset", 90_000);
        await pageB.reload();
        await pageB.waitForFunction(() => Boolean(window.__dayforgeSyncBrowserHarness), { timeout: 30_000 });
        await waitFor(() => pageB.evaluate(() => window.__dayforgeSyncBrowserHarness.wakeSync()),
          "device B to restart sync after device A has completed recovery");
        await waitFor(async () => {
          const recoveredA = await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
          const expectedRecoveryEpoch = secondRestoreEpoch ?? restoredEpoch;
          return recoveredA.serverEpoch === expectedRecoveryEpoch && recoveredA.journalCount === 0 &&
            recoveredA.pending.length === 0 && recoveryOperationIds.every((id) =>
              recoveredA.recordedEvents.some((event) => event.operationId === id));
        }, "device A to recover its acknowledged union after the isolated server epoch reset", 90_000);
        await pageB.evaluate(() => window.__dayforgeSyncBrowserHarness.wakeSync());
        await waitFor(() => deviceBConflictSeen,
          "device B to reach the current epoch mismatch before resuming recovery", 45_000);
        releaseDeviceBConflict();
        await waitFor(async () => {
          const [recoveredA, recoveredB] = await Promise.all([
            successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect()),
            pageB.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect()),
          ]);
          const expectedRecoveryEpoch = secondRestoreEpoch ?? restoredEpoch;
          const recovered = (state) => state.serverEpoch === expectedRecoveryEpoch && state.journalCount === 0 &&
            state.pending.length === 0 && recoveryOperationIds.every((id) =>
              state.recordedEvents.some((event) => event.operationId === id));
          return recovered(recoveredA) && recovered(recoveredB);
        }, "both devices to recover their acknowledged union after the isolated server epoch reset", 90_000);
        await contextB.unrouteAll({ behavior: "wait" });
      } catch (error) {
        const diagnostics = await Promise.all([successorPage, pageB].map(async (page) => ({
          coordinator: await page.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorState()).catch(() => "unavailable"),
          coordinatorDetails: await page.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorDetails()).catch((cause) => ({ error: String(cause) })),
          state: await page.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect()).catch((cause) => ({ error: String(cause) })),
        })));
        const conflicts = evidenceB.pulls.filter((entry) => entry.status === 409);
        const transactionAbortHook = await successorPage.evaluate(() =>
          window.__dayforgeSyncBrowserHarness.ownerWriteAbortStateForTest()).catch((cause) => ({ error: String(cause) }));
        const summarizePages = (entries) => entries.map(({ status, body }) => ({
          status,
          epoch: body?.epoch ?? null,
          through_cursor: body?.through_cursor ?? null,
          next_cursor: body?.next_cursor ?? null,
          has_more: body?.has_more ?? null,
          groups: (body?.groups ?? []).map((group) => ({ cursor: group.cursor, operation_id: group.operation.operation_id })),
        }));
        console.error("Epoch recovery diagnostics:", JSON.stringify({
          restoredEpoch,
          secondRestoreEpoch,
          diagnostics,
          transactionAbortHook,
          deviceBConflicts: conflicts,
          successorPullPages: summarizePages(evidenceA.pulls),
          successorBootstrapPages: summarizePages(evidenceSuccessor.bootstraps),
          deviceBPullPages: summarizePages(evidenceB.pulls),
          deviceBBootstrapPages: summarizePages(evidenceB.bootstraps),
        }, null, 2));
        throw error;
      }
      console.log("Recovery retried after bootstrap staging and generation publish transaction aborts.");
      assert(recoveryBootstrapCount >= 2 && secondRestoreEpoch && secondRestoreEpoch !== restoredEpoch,
        "a second server restore must occur while the first recovery bootstrap response is held");
      console.log("Both devices reuploaded the previously acknowledged union after two server epoch changes during recovery; journals were cleared atomically after publish.");
    }

    const lockPage = await contextA.newPage();
    await lockPage.goto("/sync-browser");
    await lockPage.getByText("Test sync harness sẵn sàng.").waitFor({ state: "visible" });
    await lockPage.waitForFunction(() => Boolean(window.__dayforgeSyncBrowserHarness));
    const lockPageState = await lockPage.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
    const currentProfileState = await successorPage.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
    assert.equal(lockPageState.ownerId, initialA.ownerId);
    assert.equal(lockPageState.deviceId, currentProfileState.deviceId,
      "a new same-profile tab must use the device lane selected by clock recovery");
    await waitFor(() => lockPage.evaluate(() => window.__dayforgeSyncBrowserHarness.wakeSync()),
      "same-profile lock tab coordinator to become ready");
    const lockEpoch = await lockPage.evaluate(() => window.__dayforgeSyncBrowserHarness.lockVault());
    assert(Number.isSafeInteger(lockEpoch) && lockEpoch > 0, "locking must persist a newer owner lock epoch");
    try {
      await waitFor(async () => {
      const states = await Promise.all([...profilePages, lockPage].map((page) =>
          page.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorState())));
        return states.every((state) => state === "stopped");
      }, "owner lock to stop coordinators in every tab sharing the profile");
    } catch (error) {
      const diagnostics = await Promise.all([...profilePages, lockPage].map(async (page) => ({
        coordinator: await page.evaluate(() => window.__dayforgeSyncBrowserHarness.coordinatorState()).catch(() => "unavailable"),
        vault: await page.evaluate(() => window.__dayforgeSyncBrowserHarness.lockState()).catch((cause) => ({ error: String(cause) })),
      })));
      console.error("Cross-tab lock diagnostics:", JSON.stringify(diagnostics));
      throw error;
    }
    await assert.rejects(
      pageA.evaluate((planName) => window.__dayforgeSyncBrowserHarness.createPlan(planName), `${name}-after-lock`),
      /locked|vault|owner/i,
      "a stale tab must not commit a local mutation after the owner lock epoch changes",
    );
    console.log("Locking the owner from a third tab stopped all same-profile coordinators and rejected a stale-tab local mutation.");
    console.log(JSON.stringify({
      result: "passed",
      owner_matches_across_sessions: finalA.ownerId === finalB.ownerId,
      distinct_device_ids: finalA.deviceId !== finalB.deviceId,
      operation_id: operationId,
      request_hash: created.requestHash,
      receipt_cursor: pushResponse.receipt.commit_cursor,
      device_a_cursor_before_after: [initialA.pullCursor, finalA.pullCursor],
      device_b_cursor_before_after: [initialB.pullCursor, finalB.pullCursor],
      pulled_event_cursor: eventB.cursor,
      local_save_during_pull: {
        operation_id: localRace.operationId,
        request_hash: localRace.requestHash,
        local_revision_won_before_release: true,
        stale_pull_refetches: stalePullEvidence.matchingResponses,
        original_remote_cursor: stalePullEvidence.firstCursor,
        original_remote_operation_id: stalePullEvidence.firstOperationId,
      },
      first_committed_response_was_lost: true,
      retry_request_body_identical: pushFaultEvidence.requestBodies[0] === pushFaultEvidence.requestBodies[1],
      server_retry_statuses: pushFaultEvidence.serverResponses
        .map((response) => response.results.find((entry) => entry.operation_id === operationId)?.status)
        .filter(Boolean),
      leader_failover: {
        previous_fencing_token: leaseBeforeFailover.fencing_token,
        successor_fencing_token: leaseAfterFailover.fencing_token,
        operation_id: failoverOperation.operationId,
        operation_recorded_after_takeover: true,
      },
      epoch_recovery: restoredEpoch ? {
        restored_epoch: secondRestoreEpoch ?? restoredEpoch,
        server_epoch_changes: secondRestoreEpoch ? 2 : 1,
        acknowledged_events_recovered: recoveryOperationIds.length,
        journals_cleared: true,
      } : null,
      recurrence_sync: {
        root_id: recurringRootId,
        operation_count: recurrenceOperations.length,
        offline_operation_ids_preserved: occurrenceOperations.every((operation) =>
          undoneA.recordedEvents.some((event) => event.operationId === operation.operationId && event.requestHash === operation.requestHash)),
        same_target_lww_winner: "Newer online same-target edit",
        lost_response_retry_count: recurrenceEditRequestBodies.length,
        retry_request_body_byte_identical: new Set(recurrenceEditRequestBodies).size === 1,
        detached_exception_count: undoneA.recurrenceFamilies.find((item) => item.rootId === recurringRootId).family.detached.length,
        stop_cutoff: "2030-01-17",
        moved_future_member_removed_then_restored_by_undo: true,
        device_a_root_hash: undoneA.recurrenceFamilies.find((item) => item.rootId === recurringRootId).rootHash,
        device_b_root_hash: undoneB.recurrenceFamilies.find((item) => item.rootId === recurringRootId).rootHash,
      },
      owner_lock: { shared_device_lane: true, lock_epoch: lockEpoch, stopped_all_tabs: true, stale_mutation_rejected: true },
    }, null, 2));
    return await contextA.storageState();
  } finally {
    releaseHeldPull();
    const stopped = await completesWithin(Promise.allSettled([
      ...contextA.pages().map((page) => page.evaluate(() => window.__dayforgeSyncBrowserHarness?.stopSync())),
      pageB.evaluate(() => window.__dayforgeSyncBrowserHarness?.stopSync()),
    ]), 3_000);
    if (!stopped) console.error("Coordinator shutdown exceeded 3 seconds; closing the browser directly.");
    const closed = await completesWithin(browser.close(), 5_000);
    if (!closed) {
      console.error("Browser shutdown exceeded 5 seconds; terminating its test-owned process tree.");
      const browserProcess = browser.process();
      if (browserProcess?.pid && process.platform === "win32") {
        const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
        const killer = spawn(taskkill, ["/PID", String(browserProcess.pid), "/T", "/F"], { stdio: "ignore" });
        await new Promise((resolve) => { killer.once("exit", resolve); killer.once("error", resolve); });
      } else {
        browserProcess?.kill("SIGKILL");
      }
    }
  }
}

async function runRecoveryQuotaScenario(baseURL, storageState = undefined) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ baseURL, ignoreHTTPSErrors: true, serviceWorkers: "block", storageState });
  const page = await context.newPage();
  const quotaOrigin = new URL(baseURL).origin;
  const quotaSession = await context.newCDPSession(page);
  const setOriginQuota = (quotaSize) => quotaSession.send("Storage.overrideQuotaForOrigin", { origin: quotaOrigin, quotaSize });
  const constrainOriginQuota = async (extraBytes = 1_024) => {
    const usage = await quotaSession.send("Storage.getUsageAndQuota", { origin: quotaOrigin });
    const quotaSize = Math.max(1, Math.ceil(usage.usage) + extraBytes);
    await setOriginQuota(quotaSize);
    const applied = await quotaSession.send("Storage.getUsageAndQuota", { origin: quotaOrigin });
    return { usage: usage.usage, quotaSize, reportedQuota: applied.quota };
  };
  try {
    await setOriginQuota(1_000_000);
    await login(page);
    await waitFor(async () => page.evaluate(async () => {
      const state = await window.__dayforgeSyncBrowserHarness.inspect();
      return Boolean(state.serverEpoch);
    }), "quota probe device bootstrap");
    const seedOperation = await page.evaluate((name) => window.__dayforgeSyncBrowserHarness.createPlan(name),
      `quota-transaction-seed-${crypto.randomUUID()}`);
    await waitFor(async () => page.evaluate(async (operationId) => {
      const state = await window.__dayforgeSyncBrowserHarness.inspect();
      return state.recordedEvents.some((entry) => entry.operationId === operationId) &&
        !state.pending.some((entry) => entry.operationId === operationId);
    }, seedOperation.operationId), "quota probe server fixture event");
    const quotaSeedEvent = await page.evaluate(() => window.__dayforgeSyncBrowserHarness.createQuotaSeedEventForTest());
    await waitFor(async () => page.evaluate(async (operationId) => {
      const state = await window.__dayforgeSyncBrowserHarness.inspect();
      return state.recordedEvents.some((entry) => entry.operationId === operationId) &&
        !state.pending.some((entry) => entry.operationId === operationId);
    }, quotaSeedEvent.operationId), "quota probe large-event fixture");
    await page.evaluate(() => window.__dayforgeSyncBrowserHarness.stopSync());
    await page.evaluate(() => window.__dayforgeSyncBrowserHarness.fenceLeaseForTest(120_000));
    const quotaDraftId = await page.evaluate(() => window.__dayforgeSyncBrowserHarness.seedRecoveryDraftForQuotaTest(600_000));
    const before = await page.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
    const initialQuota = await quotaSession.send("Storage.getUsageAndQuota", { origin: quotaOrigin });
    console.log(`Fresh-origin recovery quota probe starts at ${initialQuota.usage} bytes used; the recovery journal will copy a 600 KB encrypted draft.`);
    try {
      const limit = await constrainOriginQuota();
      const journalFailure = await page.evaluate(() => window.__dayforgeSyncBrowserHarness.probeRecoveryJournalQuotaForTest());
      assert.equal(journalFailure.causeName, "QuotaExceededError",
        `recovery journal transaction should expose a real quota error; got ${JSON.stringify({ limit, journalFailure })}`);
      const afterJournal = await page.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
      assert.equal(afterJournal.localStateRevision, before.localStateRevision, "journal quota failure must preserve owner revision");
      assert.equal(afterJournal.journalCount, before.journalCount, "journal quota failure must leave no partial journal");
      console.log(`Recovery journal hit QuotaExceededError at ${limit.quotaSize} bytes; its transaction left no partial rows.`);

      const stageFailure = await page.evaluate(() => window.__dayforgeSyncBrowserHarness.probeBootstrapStageQuotaForTest());
      assert.equal(stageFailure.causeName, "QuotaExceededError",
        `bootstrap staging transaction should expose a real quota error; got ${JSON.stringify(stageFailure)}`);
      const afterStage = await page.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
      assert.equal(afterStage.localStateRevision, before.localStateRevision, "staging quota failure must preserve owner revision");
      assert.equal(afterStage.stagingCount, before.stagingCount, "staging quota failure must leave no partial rows");
      console.log(`Bootstrap staging hit QuotaExceededError at ${limit.quotaSize} bytes; its transaction left no partial rows.`);
    } finally {
      await setOriginQuota(1_000_000_000).catch(() => undefined);
    }

    await page.evaluate((recordId) => window.__dayforgeSyncBrowserHarness.cleanupRecoveryDraftQuotaTest(recordId), quotaDraftId);
    await page.evaluate(() => window.__dayforgeSyncBrowserHarness.expireFencedLeaseForTest());
    const after = await page.evaluate(() => window.__dayforgeSyncBrowserHarness.inspect());
    assert.equal(after.serverEpoch, before.serverEpoch, "recovery quota probes must leave the original epoch active");
    assert.equal(after.pullCursor, before.pullCursor, "recovery quota probes must leave the original cursor active");
    assert.deepEqual(after.recordedEvents, before.recordedEvents, "recovery quota probes must preserve every recorded event");
    assert.equal(after.journalCount, before.journalCount, "journal quota failure must leave no partial journal rows");
    assert.equal(after.stagingCount, before.stagingCount, "bootstrap staging quota failure must leave no partial stage rows");
    console.log("Real QuotaExceededError in recovery journal and bootstrap staging left guarded owner state atomic.");
  } finally {
    await setOriginQuota(1_000_000_000).catch(() => undefined);
    await quotaSession.detach().catch(() => undefined);
    await context.close();
    await browser.close();
  }
}

async function main() {
  if (!Number.isInteger(browserPort) || browserPort < 1024 || browserPort > 65535) {
    throw new Error("Sync browser HTTPS port is invalid");
  }
  const temporary = await mkdtemp(path.join(os.tmpdir(), "dayforge-sync-browser-artifacts-"));
  assertChildPath(os.tmpdir(), temporary);
  assertChildPath(frontend, nextDirectory);
  assertChildPath(frontend, manifestPath);
  const originalNextExists = await stat(nextDirectory).then(() => true, () => false);
  const originalManifestExists = await stat(manifestPath).then(() => true, () => false);
  const originalNext = path.join(temporary, "original-next");
  const originalManifest = path.join(temporary, "original-dayforge-build.json");
  let frontendProcess = null;
  let tlsServer = null;
  try {
    if (originalNextExists) await rename(nextDirectory, originalNext);
    if (originalManifestExists) await rename(manifestPath, originalManifest);
    const nextPort = await availablePort();
    frontendProcess = await startFrontend(nextPort);
    tlsServer = startTlsProxy(browserPort, nextPort);
    await startServer(tlsServer, browserPort);
    const baseURL = `https://127.0.0.1:${browserPort}`;
    if (process.env.DAYFORGE_SYNC_BROWSER_QUOTA_ONLY === "1") {
      await runRecoveryQuotaScenario(baseURL);
    } else {
      const storageState = await runBrowserScenario(baseURL);
      await runRecoveryQuotaScenario(baseURL, storageState);
    }
  } finally {
    if (tlsServer) await stopServer(tlsServer).catch(() => undefined);
    if (frontendProcess?.child) await stopProcess(frontendProcess.child).catch(() => undefined);
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

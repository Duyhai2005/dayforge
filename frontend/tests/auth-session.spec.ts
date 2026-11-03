import { expect, test, type Page } from "@playwright/test";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const DEVICE_ID = "44444444-4444-4444-8444-444444444444";
const OPERATION_ID = "55555555-5555-4555-8555-555555555555";
const LOGOUT_TICKET = "A".repeat(64);
const CSRF_TOKEN = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const LOCAL_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const CALLBACK_TOKEN = "A".repeat(43);
const APP_DB = "dayforge-local";

type SessionView = {
  authenticated: boolean;
  owner: { id: string; email: string; email_verified_at: string } | null;
  session: {
    id: string;
    remember_me: boolean;
    idle_expires_at: string;
    absolute_expires_at: string;
    password_authenticated_at: string | null;
  } | null;
  csrf_token: string;
  server_time: string;
  logout_ticket: string | null;
};

type ApiMockState = {
  currentSession: SessionView;
  requests: Array<{ path: string; method: string; body: string | null; headers: Record<string, string> }>;
  loginBody: Record<string, unknown> | null;
  localKeyRequests: number;
  failLogout: boolean;
  failSession: boolean;
  csrfFailures: Array<{ path: string; remaining: number; refreshedToken?: string }>;
};

function sessionView(authenticated = false): SessionView {
  return {
    authenticated,
    owner: authenticated
      ? {
          id: OWNER_ID,
          email: "owner@example.test",
          email_verified_at: "2026-11-01T00:00:00.000Z",
        }
      : null,
    session: authenticated
      ? {
          id: SESSION_ID,
          remember_me: true,
          idle_expires_at: "2026-11-08T00:00:00.000Z",
          absolute_expires_at: "2026-12-01T00:00:00.000Z",
          password_authenticated_at: "2026-11-01T00:00:00.000Z",
        }
      : null,
    csrf_token: CSRF_TOKEN,
    server_time: "2026-11-01T00:00:00.000Z",
    logout_ticket: authenticated ? LOGOUT_TICKET : null,
  };
}

async function mockAuthApi(page: Page, initial = sessionView()): Promise<ApiMockState> {
  const state: ApiMockState = {
    currentSession: initial,
    requests: [],
    loginBody: null,
    localKeyRequests: 0,
    failLogout: false,
    failSession: false,
    csrfFailures: [],
  };
  await page.route("**/api/v1/auth/**", async (route) => {
    const fulfill = (options: NonNullable<Parameters<typeof route.fulfill>[0]>) => route.fulfill({
      ...options,
      headers: { "cache-control": "no-store", ...options.headers },
    });
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    state.requests.push({
      path,
      method,
      body: request.postData(),
      headers: request.headers(),
    });
    if (method === "POST") {
      const failure = state.csrfFailures.find(item => item.path === path && item.remaining > 0);
      if (failure) {
        failure.remaining -= 1;
        if (failure.refreshedToken) {
          state.currentSession = { ...state.currentSession, csrf_token: failure.refreshedToken };
        }
        await fulfill({ status: 403, json: { code: "csrf_failed" } });
        return;
      }
    }
    if (path === "/api/v1/auth/session" && method === "GET") {
      if (state.failSession) {
        await route.abort();
        return;
      }
      await fulfill({ json: state.currentSession });
      return;
    }
    if (path === "/api/v1/auth/login" && method === "POST") {
      state.loginBody = request.postDataJSON() as Record<string, unknown>;
      state.currentSession = sessionView(true);
      await fulfill({ json: state.currentSession });
      return;
    }
    if (path === "/api/v1/auth/local-key" && method === "GET") {
      state.localKeyRequests += 1;
      await fulfill({
        json: {
          owner_id: OWNER_ID,
          key_id: KEY_ID,
          algorithm: "A256GCM",
          key_base64url: LOCAL_KEY,
        },
      });
      return;
    }
    if (path === "/api/v1/auth/logout" && method === "POST") {
      if (state.failLogout) {
        await route.abort();
        return;
      }
      state.currentSession = sessionView();
      await fulfill({ status: 204, body: "" });
      return;
    }
    if (path === "/api/v1/auth/verification/confirm" && method === "POST") {
      await fulfill({ json: { status: "verified" } });
      return;
    }
    if (path === "/api/v1/auth/password/reset" && method === "POST") {
      await fulfill({ json: { status: "password_reset" } });
      return;
    }
    if (["/api/v1/auth/register", "/api/v1/auth/verification/resend", "/api/v1/auth/password/forgot"].includes(path)) {
      await fulfill({ status: 202, json: { status: "accepted", resend_after_seconds: 60 } });
      return;
    }
    await fulfill({ status: 404, json: { code: "not_found" } });
  });
  return state;
}

export async function readOwnerMeta(page: Page): Promise<Record<string, unknown> | null> {
  return await page.evaluate((dbName) => new Promise((resolve) => {
    const request = indexedDB.open(dbName);
    request.onerror = () => resolve(null);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("owner_meta")) {
        db.close();
        resolve(null);
        return;
      }
      const tx = db.transaction(["owner_meta", "auth_state"], "readonly");
      const ownerId = "11111111-1111-4111-8111-111111111111";
      const metadataRequest = tx.objectStore("owner_meta").get(ownerId);
      const authRequest = tx.objectStore("auth_state").get(ownerId);
      let metadata: Record<string, unknown> | null = null;
      let locked: boolean | undefined;
      metadataRequest.onsuccess = () => { metadata = (metadataRequest.result ?? null) as Record<string, unknown> | null; };
      authRequest.onsuccess = () => {
        const auth = authRequest.result as { locked?: unknown } | undefined;
        if (typeof auth?.locked === "boolean") locked = auth.locked;
      };
      tx.oncomplete = () => {
        db.close();
        resolve(metadata ? { ...metadata, active_key_id: metadata.key_id, locked } : null);
      };
      tx.onerror = () => { db.close(); resolve(null); };
      tx.onabort = () => { db.close(); resolve(null); };
    };
  }), APP_DB);
}

export async function readEncryptedOutbox(page: Page): Promise<unknown[]> {
  return await page.evaluate((dbName) => new Promise((resolve) => {
    const request = indexedDB.open(dbName);
    request.onerror = () => resolve([]);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("outbox")) {
        db.close();
        resolve([]);
        return;
      }
      const tx = db.transaction(["outbox"], "readonly");
      const get = tx.objectStore("outbox").index("by-owner").getAll(
        IDBKeyRange.only("11111111-1111-4111-8111-111111111111")
      );
      get.onsuccess = () => {
        const entries = (get.result as Array<Record<string, unknown>>).map((entry) => {
          return {
            operation_id: entry.record_id,
            status: entry.state,
            encrypted_envelope: {
              iv: Array.from(new Uint8Array(entry.iv as ArrayBuffer)),
              ciphertext: Array.from(new Uint8Array(entry.ciphertext as ArrayBuffer)),
            },
          };
        });
        db.close();
        resolve(entries);
      };
      get.onerror = () => {
        db.close();
        resolve([]);
      };
    };
  }), APP_DB);
}

async function seedLegacyPendingLogoutTicket(page: Page): Promise<void> {
  await page.evaluate(async ({ dbName, ownerId, ticket }) => {
    const request = indexedDB.open(dbName);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction(["auth_state", "owner_meta"], "readwrite");
    const authStore = transaction.objectStore("auth_state");
    const metadataStore = transaction.objectStore("owner_meta");
    const authRequest = authStore.get(ownerId);
    const metadataRequest = metadataStore.get(ownerId);
    let remaining = 2;
    let auth: Record<string, unknown> | null = null;
    let metadata: Record<string, unknown> | null = null;
    const commit = () => {
      if (--remaining !== 0) return;
      if (!auth || !metadata) {
        transaction.abort();
        return;
      }
      const epoch = Math.max(Number(auth.lock_epoch), Number(metadata.lock_epoch)) + 1;
      authStore.put({ ...auth, owner_id: ownerId, locked: true, lock_epoch: epoch, crypto_key: null, logout_ticket: ticket });
      metadataStore.put({
        ...metadata,
        lock_epoch: epoch,
        local_state_revision: Number(metadata.local_state_revision) + 1,
      });
    };
    authRequest.onsuccess = () => { auth = (authRequest.result ?? null) as Record<string, unknown> | null; commit(); };
    metadataRequest.onsuccess = () => { metadata = (metadataRequest.result ?? null) as Record<string, unknown> | null; commit(); };
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
  }, { dbName: APP_DB, ownerId: OWNER_ID, ticket: LOGOUT_TICKET });
}

async function readPendingLogoutRows(page: Page): Promise<Array<{ owner_id: string; logout_ticket: string }>> {
  return await page.evaluate(async (dbName) => {
    const request = indexedDB.open(dbName);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction(["auth_state"], "readonly");
    const read = transaction.objectStore("auth_state").getAll();
    const rows = await new Promise<unknown[]>((resolve, reject) => {
      read.onsuccess = () => resolve(read.result as unknown[]);
      read.onerror = () => reject(read.error);
    });
    db.close();
    return rows
      .filter((value): value is { owner_id?: unknown; logout_ticket?: unknown } => Boolean(value && typeof value === "object"))
      .filter((value): value is { owner_id: string; logout_ticket: string } =>
        typeof value.owner_id === "string" && typeof value.logout_ticket === "string")
      .map(value => ({ owner_id: value.owner_id, logout_ticket: value.logout_ticket }));
  }, APP_DB);
}

export async function prepareUnlockedOwnerWithPendingOperation(page: Page): Promise<ApiMockState> {
  const api = await mockAuthApi(page);
  await page.goto("/account");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Mật khẩu").fill("Sundial Maple Crane 7429");
  await page.getByRole("button", { name: "Đăng nhập và mở kho local", exact: true }).click();
  await expect.poll(async () => (await readOwnerMeta(page))?.locked).toBe(false);
  const seeded = await page.evaluate(async ({ ownerId, keyId, deviceId, operationId, dbName }) => {
    const dbRequest = indexedDB.open(dbName);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      dbRequest.onsuccess = () => resolve(dbRequest.result);
      dbRequest.onerror = () => reject(dbRequest.error);
    });
    const cryptoKey = await new Promise<CryptoKey>((resolve, reject) => {
      const tx = db.transaction(["auth_state"], "readonly");
      const request = tx.objectStore("auth_state").get(ownerId);
      request.onsuccess = () => {
        const row = request.result as { crypto_key?: CryptoKey | null } | undefined;
        if (row?.crypto_key) resolve(row.crypto_key);
        else reject(new Error("local key missing"));
      };
      request.onerror = () => reject(request.error);
    });
    const envelopePayload = {
      commands: [{
        root: { kind: "plan", id: "66666666-6666-4666-8666-666666666666" },
        action: "plan.create",
        payload: { data: { name: "Pending Plan", color_id: "green" } },
        precondition: null,
      }],
      dependencies: [],
      device_id: deviceId,
      device_sequence: "1",
      edit_time: {
        physical_ms: 1793500000000,
        logical: 0,
        calibration_id: deviceId,
        raw_wall_ms: 1793500000000,
        quality: "calibrated",
      },
      operation_id: operationId,
      owner_id: ownerId,
      protocol_version: 1,
      reducer_version: 1,
    };
    const canonicalize = (value: unknown): string => {
      if (value === null || typeof value !== "object") return JSON.stringify(value);
      if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalize(record[key])}`).join(",")}}`;
    };
    const canonicalOperation = canonicalize(envelopePayload);
    const requestHashBytes = new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalOperation)
    ));
    const requestHash = Array.from(requestHashBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const storedEnvelope = {
      operation: envelopePayload,
      request_hash: requestHash,
      state: "queued",
      ever_recorded: false,
      commit_uncertain: false,
      attempts: 0,
      next_attempt_at_ms: null,
      superseded_by: null,
      receipt: null,
      problem_code: null,
    };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode(`${ownerId}|outbox|${operationId}|v1`);
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      cryptoKey,
      new TextEncoder().encode(canonicalize(storedEnvelope))
    ));
    const transaction = db.transaction(["outbox", "drafts"], "readwrite");
    transaction.objectStore("outbox").put({
      id: `${ownerId}:${operationId}`,
      owner_id: ownerId,
      record_id: operationId,
      key_id: keyId,
      iv: iv.buffer.slice(0),
      ciphertext: ciphertext.buffer.slice(0),
      state: "queued",
      request_hash: requestHash,
      superseded_by: null,
      created_at_ms: Date.now(),
    });
    const draftIv = crypto.getRandomValues(new Uint8Array(12));
    transaction.objectStore("drafts").put({
      id: `${ownerId}:draft-test-1`,
      owner_id: ownerId,
      record_id: "draft-test-1",
      key_id: keyId,
      iv: draftIv.buffer.slice(0),
      ciphertext: new Uint8Array([1, 2, 3]).buffer,
    });
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
    return true;
  }, { ownerId: OWNER_ID, keyId: KEY_ID, deviceId: DEVICE_ID, operationId: OPERATION_ID, dbName: APP_DB });
  expect(seeded).toBe(true);
  return api;
}

test("accountLoginDefaultsRememberMeAndUnlocksOwner", async ({ page }) => {
  const api = await mockAuthApi(page);
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "Tài khoản", level: 1 })).toBeVisible();
  await expect(page.getByLabel("Ghi nhớ phiên trên thiết bị này")).toBeChecked();
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Mật khẩu").fill("Sundial Maple Crane 7429");
  await page.getByRole("button", { name: "Đăng nhập và mở kho local", exact: true }).click();
  await expect(page.locator("p[role='status']")).toContainText("Đã mở kho local");
  expect(api.loginBody).toMatchObject({ email: "owner@example.test", remember_me: true });
  expect(api.localKeyRequests).toBe(1);
  await expect.poll(async () => readOwnerMeta(page)).toMatchObject({
    owner_id: OWNER_ID,
    active_key_id: KEY_ID,
    locked: false,
  });
});

test("ownerCanCreateAndEditAPlanThroughTheCalendarWidget", async ({ page }) => {
  await mockAuthApi(page);
  await page.goto("/account");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Mật khẩu").fill("Sundial Maple Crane 7429");
  await page.getByRole("button", { name: "Đăng nhập và mở kho local", exact: true }).click();
  await expect.poll(async () => (await readOwnerMeta(page))?.locked).toBe(false);

  await page.goto("/work?date=2026-11-03");
  await page.getByRole("button", { name: "Mở hoặc đóng điều hướng lịch" }).click();
  await page.getByRole("button", { name: "Quản lý kế hoạch", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Kế hoạch" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Tạo kế hoạch", exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Tạo kế hoạch", exact: true }).click();
  await dialog.getByLabel("Tên kế hoạch").fill("Ôn thi giữa kỳ");
  await dialog.getByRole("radio", { name: "Xanh lá" }).check();
  await dialog.getByRole("button", { name: "Lưu kế hoạch", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole("status")).toContainText("Đã lưu kế hoạch trên thiết bị");

  await page.getByRole("button", { name: "Mở hoặc đóng điều hướng lịch" }).click();
  await page.getByRole("button", { name: "Quản lý kế hoạch", exact: true }).click();
  const updatedDialog = page.getByRole("dialog", { name: "Kế hoạch" });
  await expect(updatedDialog.getByRole("list", { name: "Kế hoạch đã lưu" })).toContainText("Ôn thi giữa kỳ");
  await updatedDialog.getByRole("button", { name: "Sửa Ôn thi giữa kỳ" }).click();
  await updatedDialog.getByLabel("Tên kế hoạch").fill("Ôn thi cuối kỳ");
  await updatedDialog.getByRole("button", { name: "Lưu kế hoạch", exact: true }).click();
  await expect(updatedDialog).toBeHidden();

  await page.getByRole("button", { name: "Mở hoặc đóng điều hướng lịch" }).click();
  await page.getByRole("button", { name: "Quản lý kế hoạch", exact: true }).click();
  const draftDialog = page.getByRole("dialog", { name: "Kế hoạch" });
  await draftDialog.getByRole("button", { name: "Tạo kế hoạch", exact: true }).click();
  await draftDialog.getByLabel("Tên kế hoạch").fill("Bản nháp chưa lưu");
  await draftDialog.getByRole("button", { name: "Đóng kế hoạch" }).click();
  const discardDialog = page.getByRole("alertdialog", { name: "Bỏ thay đổi chưa lưu?" });
  await expect(discardDialog).toBeVisible();
  await discardDialog.getByRole("button", { name: "Tiếp tục sửa", exact: true }).click();
  await expect(draftDialog.getByLabel("Tên kế hoạch")).toHaveValue("Bản nháp chưa lưu");
  await draftDialog.getByRole("button", { name: "Đóng kế hoạch" }).click();
  await page.getByRole("alertdialog", { name: "Bỏ thay đổi chưa lưu?" }).getByRole("button", { name: "Bỏ thay đổi", exact: true }).click();
  await expect(draftDialog).toBeHidden();

  const outbox = await readEncryptedOutbox(page);
  expect(outbox).toHaveLength(2);
});

test("loginRecoversFromExpiredCsrfByRefreshingAndRetryingOnce", async ({ page }) => {
  const api = await mockAuthApi(page);
  await page.goto("/account");
  const refreshedToken = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
  api.csrfFailures.push({ path: "/api/v1/auth/login", remaining: 1, refreshedToken });

  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Mật khẩu").fill("Sundial Maple Crane 7429");
  await page.getByRole("button", { name: "Đăng nhập và mở kho local", exact: true }).click();

  await expect.poll(() => api.requests.filter(request => request.path === "/api/v1/auth/login").length).toBe(2);
  const loginRequests = api.requests.filter(request => request.path === "/api/v1/auth/login");
  expect(loginRequests).toHaveLength(2);
  expect(loginRequests[0].headers["x-csrf-token"]).toBe(CSRF_TOKEN);
  expect(loginRequests[1].headers["x-csrf-token"]).toBe(refreshedToken);
  await expect(page.locator("p[role='status']")).toContainText("Đã mở kho local");
});

test("emailRequestRecoversFromExpiredCsrfByRefreshingAndRetryingOnce", async ({ page }) => {
  const api = await mockAuthApi(page);
  await page.goto("/account");
  const refreshedToken = "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI";
  api.csrfFailures.push({ path: "/api/v1/auth/register", remaining: 1, refreshedToken });

  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByRole("button", { name: "Tạo tài khoản", exact: true }).click();
  await page.getByRole("button", { name: "Gửi liên kết xác minh", exact: true }).click();

  await expect.poll(() => api.requests.filter(request => request.path === "/api/v1/auth/register").length).toBe(2);
  const registerRequests = api.requests.filter(request => request.path === "/api/v1/auth/register");
  expect(registerRequests).toHaveLength(2);
  expect(registerRequests[0].headers["x-csrf-token"]).toBe(CSRF_TOKEN);
  expect(registerRequests[1].headers["x-csrf-token"]).toBe(refreshedToken);
  await expect(page.locator("p[role='status']")).toContainText("Nếu địa chỉ email đủ điều kiện");
});

test("pendingLogoutTicketSurvivesReloadAndIsReplayedBeforeLogin", async ({ page }) => {
  const api = await prepareUnlockedOwnerWithPendingOperation(page);
  await seedLegacyPendingLogoutTicket(page);

  await page.reload();
  await expect.poll(async () => (await readOwnerMeta(page))?.locked).toBe(true);
  expect(await readPendingLogoutRows(page)).toEqual([{ owner_id: OWNER_ID, logout_ticket: LOGOUT_TICKET }]);

  api.failLogout = true;
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Mật khẩu").fill("Sundial Maple Crane 7429");
  await page.getByRole("button", { name: "Đăng nhập và mở kho local", exact: true }).click();
  await expect(page.locator(".account-error")).toBeVisible();
  expect(api.requests.filter(request => request.path === "/api/v1/auth/login")).toHaveLength(1);
  expect(await readPendingLogoutRows(page)).toEqual([{ owner_id: OWNER_ID, logout_ticket: LOGOUT_TICKET }]);

  api.failLogout = false;
  await page.getByRole("button", { name: "Đăng nhập và mở kho local", exact: true }).click();
  await expect.poll(async () => readPendingLogoutRows(page)).toEqual([]);
  await expect.poll(() => api.requests.filter(request => request.path === "/api/v1/auth/login").length).toBe(2);
  await expect.poll(async () => (await readOwnerMeta(page))?.locked).toBe(false);
});

test("unicodeEmailReachesServerCanonicalization", async ({ page }) => {
  const api = await mockAuthApi(page);
  await page.goto("/account");
  await page.getByRole("button", { name: "Quên mật khẩu" }).click();
  await page.getByLabel("Email").fill("chủ@BÜCHER.example");
  await page.getByRole("button", { name: "Gửi hướng dẫn đặt lại" }).click();
  await expect(page.locator("p[role='status']")).toContainText("Nếu tài khoản tồn tại");
  const request = api.requests.find(item => item.path === "/api/v1/auth/password/forgot");
  expect(request?.method).toBe("POST");
  expect(JSON.parse(request?.body ?? "null")).toEqual({ email: "chủ@BÜCHER.example" });
});

test("verifyCallbackPostsOnlyAfterConfirmationAndScrubsFragment", async ({ page }) => {
  const api = await mockAuthApi(page);
  await page.goto(`/verify-email#token=${CALLBACK_TOKEN}`);
  await expect(page).toHaveURL("/verify-email");
  await expect(page.getByLabel("Tạo mật khẩu")).toBeVisible();
  expect(api.requests.filter((request) => request.method === "POST")).toEqual([]);
  await page.getByLabel("Tạo mật khẩu").fill("Sundial Maple Crane 7429");
  await page.getByLabel("Nhập lại mật khẩu").fill("Sundial Maple Crane 7429");
  await page.getByRole("button", { name: "Xác minh và tạo tài khoản" }).click();
  await expect(page.locator("p[role='status']")).toContainText("được xác minh");
  const confirmation = api.requests.find((request) => request.path.endsWith("/verification/confirm"));
  expect(confirmation?.body).toContain(CALLBACK_TOKEN);
  expect(confirmation?.path).toBe("/api/v1/auth/verification/confirm");
  expect(confirmation?.path).not.toContain(CALLBACK_TOKEN);
  expect(confirmation?.headers["x-csrf-token"]).toBe(CSRF_TOKEN);
  expect(page.url()).not.toContain(CALLBACK_TOKEN);
});

test("resetCallbackRequiresMatchingPasswords", async ({ page }) => {
  const api = await mockAuthApi(page);
  await page.goto(`/reset-password#token=${CALLBACK_TOKEN}`);
  await expect(page).toHaveURL("/reset-password");
  await page.getByLabel("Mật khẩu mới", { exact: true }).fill("Sundial Maple Crane 7429");
  await page.getByLabel("Nhập lại mật khẩu", { exact: true }).fill("Sundial Cedar Harbor 8153");
  await page.getByRole("button", { name: "Đặt lại mật khẩu" }).click();
  await expect(page.locator(".account-error")).toContainText("khớp");
  expect(api.requests.some((request) => request.path.endsWith("/password/reset"))).toBe(false);
});

test("logoutLocksOtherTabsAndPreservesEncryptedPendingData", async ({ page, context }) => {
  const api = await prepareUnlockedOwnerWithPendingOperation(page);
  const otherTab = await context.newPage();
  await mockAuthApi(otherTab);
  await otherTab.goto("/account");
  await expect(otherTab.locator("div.account-status")).toContainText("Kho local đang mở");

  const pendingBefore = await readEncryptedOutbox(page);
  expect(pendingBefore).toHaveLength(1);
  api.failLogout = true;
  await page.getByRole("button", { name: "Đăng xuất và khóa kho local" }).click();

  await expect(page.locator("p[role='status']")).toContainText("được gửi trước lần đăng nhập");
  await expect.poll(async () => (await readOwnerMeta(page))?.locked).toBe(true);
  await expect.poll(async () => (await readOwnerMeta(otherTab))?.locked).toBe(true);
  await expect(otherTab.locator("div.account-status")).toContainText("Kho local đang khóa");
  expect(await readEncryptedOutbox(page)).toEqual(pendingBefore);
  expect(await readPendingLogoutRows(page)).toEqual([{ owner_id: OWNER_ID, logout_ticket: LOGOUT_TICKET }]);
});

test("delayedLocalKeyResponseCannotUndoCrossTabLogout", async ({ page, context }) => {
  await prepareUnlockedOwnerWithPendingOperation(page);
  const loginTab = await context.newPage();
  await mockAuthApi(loginTab);
  await loginTab.goto("/account");
  await expect(loginTab.getByRole("button", { name: "Đăng nhập và mở kho local", exact: true })).toBeVisible();

  let releaseLocalKey!: () => void;
  let signalLocalKeyStarted!: () => void;
  const localKeyGate = new Promise<void>(resolve => { releaseLocalKey = resolve; });
  const localKeyStarted = new Promise<void>(resolve => { signalLocalKeyStarted = resolve; });
  await loginTab.route("**/api/v1/auth/local-key", async route => {
    signalLocalKeyStarted();
    await localKeyGate;
    await route.fulfill({
      headers: { "cache-control": "no-store" },
      json: {
        owner_id: OWNER_ID,
        key_id: KEY_ID,
        algorithm: "A256GCM",
        key_base64url: LOCAL_KEY,
      },
    });
  });

  await loginTab.getByLabel("Email").fill("owner@example.test");
  await loginTab.getByLabel("Mật khẩu").fill("Sundial Maple Crane 7429");
  await loginTab.getByRole("button", { name: "Đăng nhập và mở kho local", exact: true }).click();
  await localKeyStarted;

  try {
    await page.getByRole("button", { name: "Đăng xuất và khóa kho local" }).click();
    await expect.poll(async () => (await readOwnerMeta(page))?.locked).toBe(true);
    releaseLocalKey();

    await expect(loginTab.locator(".account-error")).toContainText("locked while local authentication was in progress");
    await expect.poll(async () => (await readOwnerMeta(loginTab))?.locked).toBe(true);
  } finally {
    releaseLocalKey();
  }
});

test("loginDoesNotAutoUnlockFromRestoredCookie", async ({ page }) => {
  const api = await mockAuthApi(page, sessionView(true));
  await page.goto("/account");
  await expect(page.locator("div.account-status[role='status']")).toContainText("Kho local đang khóa");
  expect(api.localKeyRequests).toBe(0);
  expect(await readOwnerMeta(page)).toBeNull();
});

test("reloadRestoresUnlockedOwnerWhenSessionApiIsUnavailable", async ({ page }) => {
  const api = await mockAuthApi(page);
  await page.goto("/account");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Mật khẩu").fill("Sundial Maple Crane 7429");
  await page.getByRole("button", { name: "Đăng nhập và mở kho local", exact: true }).click();
  await expect.poll(async () => (await readOwnerMeta(page))?.locked).toBe(false);
  await page.getByRole("link", { name: "Quay lại lịch công việc" }).click();
  await expect(page.locator(".widget-summary span[role='status']")).toContainText("Đã mở kho local");

  await page.goto("/account");
  api.failSession = true;
  await page.reload();
  await expect(page.locator("div.account-status")).toContainText("Kho local đang mở");
  await expect.poll(async () => (await readOwnerMeta(page))?.locked).toBe(false);
  expect(api.localKeyRequests).toBe(1);
});

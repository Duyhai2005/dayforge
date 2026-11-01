import { expect, test, type Page } from "@playwright/test";

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const KEY_ID = "22222222-2222-4222-8222-222222222222";
const SESSION_ID = "33333333-3333-4333-8333-333333333333";
const DEVICE_ID = "44444444-4444-4444-8444-444444444444";
const OPERATION_ID = "55555555-5555-4555-8555-555555555555";
const CSRF_TOKEN = "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE";
const LOCAL_KEY = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const CALLBACK_TOKEN = "A".repeat(43);
const APP_DB = "dayforge";

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
    logout_ticket: authenticated ? "test-logout-ticket" : null,
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
  };
  await page.route("**/api/v1/auth/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    state.requests.push({
      path,
      method,
      body: request.postData(),
      headers: request.headers(),
    });
    if (path === "/api/v1/auth/session" && method === "GET") {
      if (state.failSession) {
        await route.abort();
        return;
      }
      await route.fulfill({ json: state.currentSession });
      return;
    }
    if (path === "/api/v1/auth/login" && method === "POST") {
      state.loginBody = request.postDataJSON() as Record<string, unknown>;
      state.currentSession = sessionView(true);
      await route.fulfill({ json: state.currentSession });
      return;
    }
    if (path === "/api/v1/auth/local-key" && method === "GET") {
      state.localKeyRequests += 1;
      await route.fulfill({
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
      await route.fulfill({ status: 204, body: "" });
      return;
    }
    if (path === "/api/v1/auth/verification/confirm" && method === "POST") {
      await route.fulfill({ json: { status: "verified" } });
      return;
    }
    if (path === "/api/v1/auth/password/reset" && method === "POST") {
      await route.fulfill({ json: { status: "password_reset" } });
      return;
    }
    if (["/api/v1/auth/register", "/api/v1/auth/verification/resend", "/api/v1/auth/password/forgot"].includes(path)) {
      await route.fulfill({ status: 202, json: { status: "accepted", resend_after_seconds: 60 } });
      return;
    }
    await route.fulfill({ status: 404, json: { code: "not_found" } });
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
      const tx = db.transaction(["owner_meta"], "readonly");
      const get = tx.objectStore("owner_meta").get("11111111-1111-4111-8111-111111111111");
      get.onsuccess = () => {
        const value = (get.result ?? null) as Record<string, unknown> | null;
        db.close();
        resolve(value);
      };
      get.onerror = () => {
        db.close();
        resolve(null);
      };
    };
  }), APP_DB);
}

export async function readEncryptedOutbox(page: Page): Promise<unknown[]> {
  return await page.evaluate((dbName) => new Promise((resolve) => {
    const request = indexedDB.open(dbName);
    request.onerror = () => resolve([]);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("operations")) {
        db.close();
        resolve([]);
        return;
      }
      const tx = db.transaction(["operations"], "readonly");
      const range = IDBKeyRange.bound(
        ["11111111-1111-4111-8111-111111111111", ""],
        ["11111111-1111-4111-8111-111111111111", "\uffff"]
      );
      const get = tx.objectStore("operations").getAll(range);
      get.onsuccess = () => {
        const entries = (get.result as Array<Record<string, unknown>>).map((entry) => {
          const envelope = entry.encrypted_envelope as Record<string, unknown>;
          return {
            operation_id: entry.operation_id,
            status: entry.status,
            encrypted_envelope: {
              iv: Array.from(new Uint8Array(envelope.iv as ArrayBuffer)),
              ciphertext: Array.from(new Uint8Array(envelope.ciphertext as ArrayBuffer)),
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

export async function prepareUnlockedOwnerWithPendingOperation(page: Page): Promise<ApiMockState> {
  const api = await mockAuthApi(page);
  await page.goto("/account");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Mật khẩu").fill("Sundial Maple Crane 7429");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect.poll(async () => (await readOwnerMeta(page))?.locked).toBe(false);
  const seeded = await page.evaluate(async ({ ownerId, keyId, deviceId, operationId, dbName }) => {
    const dbRequest = indexedDB.open(dbName);
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      dbRequest.onsuccess = () => resolve(dbRequest.result);
      dbRequest.onerror = () => reject(dbRequest.error);
    });
    const cryptoKey = await new Promise<CryptoKey>((resolve, reject) => {
      const tx = db.transaction(["crypto_keys"], "readonly");
      const request = tx.objectStore("crypto_keys").get([ownerId, keyId]);
      request.onsuccess = () => {
        const row = request.result as { key?: CryptoKey } | undefined;
        if (row?.key) resolve(row.key);
        else reject(new Error("local key missing"));
      };
      request.onerror = () => reject(request.error);
    });
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode(`${ownerId}:${keyId}:operations:${operationId}`);
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
    const canonicalEnvelope = canonicalize(envelopePayload);
    const requestHashBytes = new Uint8Array(await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(canonicalEnvelope)
    ));
    const requestHash = Array.from(requestHashBytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
    const ciphertext = new Uint8Array(await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad, tagLength: 128 },
      cryptoKey,
      new TextEncoder().encode(canonicalEnvelope)
    ));
    const transaction = db.transaction(["operations", "drafts"], "readwrite");
    transaction.objectStore("operations").put({
      owner_id: ownerId,
      operation_id: operationId,
      device_sequence: "1",
      status: "pending",
      request_hash: requestHash,
      encrypted_envelope: {
        owner_id: ownerId,
        store: "operations",
        record_id: operationId,
        key_id: keyId,
        iv,
        ciphertext,
      },
      created_at: "2026-11-01T00:00:00.000Z",
    });
    transaction.objectStore("drafts").put({
      owner_id: ownerId,
      draft_id: "draft-test-1",
      iv: new Uint8Array(12),
      ciphertext: new Uint8Array([1, 2, 3]),
      updated_at: "2026-11-01T00:00:00.000Z",
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
  await expect(page.getByLabel("Ghi nhớ đăng nhập")).toBeChecked();
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Mật khẩu").fill("Sundial Maple Crane 7429");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page.getByRole("status")).toContainText("đã mở khóa");
  expect(api.loginBody).toMatchObject({ email: "owner@example.test", remember_me: true });
  expect(api.localKeyRequests).toBe(1);
  await expect.poll(async () => readOwnerMeta(page)).toMatchObject({
    owner_id: OWNER_ID,
    active_key_id: KEY_ID,
    locked: false,
  });
});

test("unicodeEmailReachesServerCanonicalization", async ({ page }) => {
  const api = await mockAuthApi(page);
  await page.goto("/account");
  await page.getByRole("button", { name: "Quên mật khẩu" }).click();
  await page.getByLabel("Email").fill("chủ@BÜCHER.example");
  await page.getByRole("button", { name: "Gửi hướng dẫn đặt lại" }).click();
  await expect(page.getByRole("status")).toContainText("Nếu email phù hợp");
  const request = api.requests.find(item => item.path === "/api/v1/auth/password/forgot");
  expect(request?.method).toBe("POST");
  expect(JSON.parse(request?.body ?? "null")).toEqual({ email: "chủ@BÜCHER.example" });
});

test("verifyCallbackPostsOnlyAfterConfirmationAndScrubsFragment", async ({ page }) => {
  const api = await mockAuthApi(page);
  await page.goto(`/verify-email#token=${CALLBACK_TOKEN}`);
  await expect(page).toHaveURL("/verify-email");
  await expect(page.getByLabel("Mật khẩu")).toBeVisible();
  expect(api.requests.filter((request) => request.method === "POST")).toEqual([]);
  await page.getByLabel("Mật khẩu").fill("Sundial Maple Crane 7429");
  await page.getByRole("button", { name: "Xác nhận email" }).click();
  await expect(page.getByRole("status")).toContainText("đã xác minh");
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
  await page.getByLabel("Nhập lại mật khẩu mới", { exact: true }).fill("Sundial Cedar Harbor 8153");
  await page.getByRole("button", { name: "Đặt lại mật khẩu" }).click();
  await expect(page.locator(".account-error")).toContainText("khớp");
  expect(api.requests.some((request) => request.path.endsWith("/password/reset"))).toBe(false);
});

test("delayedLocalKeyCannotReopenOwnerAfterRemoteLogout", async ({ page, context }) => {
  await mockAuthApi(page);
  await page.goto("/account");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Mật khẩu").fill("Sundial Maple Crane 7429");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect(page.getByRole("status")).toContainText("đã mở khóa");

  const otherTab = await context.newPage();
  await mockAuthApi(otherTab, sessionView(true));
  await otherTab.goto("/work");
  await expect(otherTab.getByRole("button", { name: "Đăng xuất" })).toBeVisible();

  let releaseLocalKey!: () => void;
  let signalLocalKeyStarted!: () => void;
  const localKeyGate = new Promise<void>(resolve => { releaseLocalKey = resolve; });
  const localKeyStarted = new Promise<void>(resolve => { signalLocalKeyStarted = resolve; });
  await page.route("**/api/v1/auth/local-key", async route => {
    signalLocalKeyStarted();
    await localKeyGate;
    await route.fulfill({
      json: {
        owner_id: OWNER_ID,
        key_id: KEY_ID,
        algorithm: "A256GCM",
        key_base64url: LOCAL_KEY,
      },
    });
  });

  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Mật khẩu").fill("Sundial Maple Crane 7429");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await localKeyStarted;

  await otherTab.getByRole("button", { name: "Đăng xuất" }).click();
  await expect(otherTab.getByRole("status")).toContainText("Đã đăng xuất");
  await expect.poll(async () => (await readOwnerMeta(page))?.locked).toBe(true);

  releaseLocalKey();
  await expect(page.getByRole("button", { name: "Đăng nhập" })).toBeEnabled();
  await expect.poll(async () => (await readOwnerMeta(page))?.locked).toBe(true);
});
test("expiredSessionKeepsLocalVaultAvailable", async ({ page }) => {
  const api = await prepareUnlockedOwnerWithPendingOperation(page);
  api.currentSession = sessionView();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("status")).toContainText("Phiên đã hết hạn");
  await expect.poll(async () => (await readOwnerMeta(page))?.locked).toBe(false);
});

test("expiredSessionStillAllowsManualLocalLock", async ({ page }) => {
  const api = await prepareUnlockedOwnerWithPendingOperation(page);
  await page.getByRole("link", { name: "Quay lại lịch công việc" }).click();
  await expect(page.getByRole("heading", { name: "Lịch công việc" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Đăng xuất" })).toBeVisible();
  api.currentSession = sessionView();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await expect(page.getByRole("status")).toContainText("Phiên đã hết hạn");
  await expect(page.getByRole("button", { name: "Khóa dữ liệu" })).toBeVisible();
  await page.getByRole("button", { name: "Khóa dữ liệu" }).click();
  await expect(page.getByRole("dialog")).toContainText("đang chờ đồng bộ");
  await page.getByRole("button", { name: "Vẫn đăng xuất" }).click();
  await expect.poll(async () => (await readOwnerMeta(page))?.locked).toBe(true);
  expect(api.requests.some(request => request.path === "/api/v1/auth/logout" && request.method === "POST")).toBe(false);
});

test("logoutOfflineLocksAllTabsAndPreservesPendingData", async ({ page, context }) => {
  const api = await prepareUnlockedOwnerWithPendingOperation(page);
  const otherTab = await context.newPage();
  await otherTab.goto("/work");
  await expect(otherTab.getByRole("heading", { name: "Lịch công việc" })).toBeVisible();
  await otherTab.evaluate(() => {
    const target = window as Window & { __ownerLockNotices?: string[] };
    target.__ownerLockNotices = [];
    window.addEventListener("dayforge:owner-locked", event => {
      const detail = (event as CustomEvent<{ ownerId: string }>).detail;
      target.__ownerLockNotices?.push(detail.ownerId);
    });
  });
  await page.goto("/work");
  await expect(page.getByRole("button", { name: "Đăng xuất" })).toBeVisible();
  const pendingBefore = await readEncryptedOutbox(page);
  expect(pendingBefore).toHaveLength(1);
  api.failLogout = true;
  await context.setOffline(true);
  await page.getByRole("button", { name: "Đăng xuất" }).click();
  await expect(page.getByRole("dialog")).toContainText("đang chờ đồng bộ");
  await page.getByRole("button", { name: "Vẫn đăng xuất" }).click();
  await expect(page.getByRole("status")).toContainText("chưa thu hồi trên máy chủ");
  await expect.poll(async () => (await readOwnerMeta(page))?.locked).toBe(true);
  await expect.poll(async () => (await readOwnerMeta(otherTab))?.locked).toBe(true);
  await expect.poll(async () => otherTab.evaluate(() => (window as Window & { __ownerLockNotices?: string[] }).__ownerLockNotices ?? [])).toEqual([OWNER_ID]);
  expect(await readEncryptedOutbox(page)).toEqual(pendingBefore);
  const authState = await page.evaluate((dbName) => new Promise<unknown[]>((resolve) => {
    const request = indexedDB.open(dbName);
    request.onerror = () => resolve([]);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("auth_state")) {
        db.close();
        resolve([]);
        return;
      }
      const tx = db.transaction(["auth_state"], "readonly");
      const get = tx.objectStore("auth_state").getAll();
      get.onsuccess = () => { const rows = get.result; db.close(); resolve(rows); };
      get.onerror = () => { db.close(); resolve([]); };
    };
  }), APP_DB);
  expect(authState).toHaveLength(1);
  expect(JSON.stringify(authState)).toContain("test-logout-ticket");
});

test("loginDoesNotAutoUnlockFromRestoredCookie", async ({ page }) => {
  const api = await mockAuthApi(page, sessionView(true));
  await page.goto("/account");
  await expect(page.getByRole("status")).toContainText("dữ liệu cục bộ vẫn khóa");
  expect(api.localKeyRequests).toBe(0);
  expect(await readOwnerMeta(page)).toBeNull();
});

test("reloadRestoresUnlockedOwnerWhenSessionApiIsUnavailable", async ({ page }) => {
  const api = await mockAuthApi(page);
  await page.goto("/account");
  await page.getByLabel("Email").fill("owner@example.test");
  await page.getByLabel("Mật khẩu").fill("Sundial Maple Crane 7429");
  await page.getByRole("button", { name: "Đăng nhập" }).click();
  await expect.poll(async () => (await readOwnerMeta(page))?.locked).toBe(false);
  await page.getByRole("link", { name: "Quay lại lịch công việc" }).click();
  await expect(page.getByRole("status")).toContainText("Dữ liệu cục bộ đã mở khóa");

  api.failSession = true;
  await page.reload();
  await expect(page.getByRole("status")).toContainText("Dữ liệu cục bộ đã mở khóa");
  await expect.poll(async () => (await readOwnerMeta(page))?.locked).toBe(false);
  expect(api.localKeyRequests).toBe(1);
});

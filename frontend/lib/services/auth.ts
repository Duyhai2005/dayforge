import { importRawKey } from "../storage/crypto";
import { storageErr, storageOk, type StorageResult } from "../storage/errors";

export type AuthOwner = Readonly<{
  id: string;
  email: string;
  email_verified_at: string;
}>;

export type AuthSessionInfo = Readonly<{
  id: string;
  remember_me: boolean;
  idle_expires_at: string;
  absolute_expires_at: string;
  password_authenticated_at: string | null;
}>;

export type SessionView = Readonly<{
  authenticated: boolean;
  owner: AuthOwner | null;
  session: AuthSessionInfo | null;
  csrf_token: string;
  server_time: string;
  logout_ticket: string | null;
}>;

export type AcceptedEmailRequest = Readonly<{
  status: "accepted";
  resend_after_seconds: number;
}>;

export type LocalKeyResponse = Readonly<{
  owner_id: string;
  key_id: string;
  algorithm: "A256GCM";
  key_base64url: string;
}>;

export class AuthApiError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(status: number, code: string) {
    super(code);
    this.name = "AuthApiError";
    this.status = status;
    this.code = code;
  }
}

async function problemCode(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { code?: unknown };
    if (typeof body.code === "string" && /^[a-z0-9_]{1,64}$/.test(body.code)) {
      return body.code;
    }
  } catch {
    // Do not surface an untrusted response body to the user.
  }
  return "service_unavailable";
}

async function expectSuccess(response: Response): Promise<void> {
  if (!response.ok) {
    throw new AuthApiError(response.status, await problemCode(response));
  }
}

export async function getSession(): Promise<SessionView> {
  let response: Response;
  try {
    response = await fetch("/api/v1/auth/session", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new AuthApiError(503, "service_unavailable");
  }
  await expectSuccess(response);
  return (await response.json()) as SessionView;
}

export async function postAuth<T>(
  path: string,
  body: unknown,
  csrfToken?: string
): Promise<T> {
  if (!/^[a-z]+(?:\/[a-z]+)*$/.test(path)) {
    throw new AuthApiError(400, "malformed_request");
  }
  let csrf = csrfToken;
  if (!csrf) csrf = (await getSession()).csrf_token;
  if (!csrf || csrf.length > 128) throw new AuthApiError(503, "service_unavailable");
  let response: Response;
  try {
    response = await fetch(`/api/v1/auth/${path}`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        "X-CSRF-Token": csrf,
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new AuthApiError(503, "service_unavailable");
  }
  await expectSuccess(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function getLocalKey(): Promise<LocalKeyResponse> {
  let response: Response;
  try {
    response = await fetch("/api/v1/auth/local-key", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch {
    throw new AuthApiError(503, "service_unavailable");
  }
  await expectSuccess(response);
  const value = (await response.json()) as LocalKeyResponse;
  if (value.algorithm !== "A256GCM") throw new AuthApiError(503, "service_unavailable");
  return value;
}

function decodeKey(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) {
    throw new AuthApiError(503, "service_unavailable");
  }
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=");
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 32) throw new AuthApiError(503, "service_unavailable");
  return bytes;
}

export async function importLocalKey(keyBase64url: string): Promise<StorageResult<CryptoKey>> {
  let raw: Uint8Array;
  try {
    raw = decodeKey(keyBase64url);
  } catch {
    return storageErr("invalid_data", "Invalid local key response");
  }
  try {
    return storageOk(await importRawKey(raw));
  } catch {
    return storageErr("unavailable", "Unable to import local key");
  } finally {
    raw.fill(0);
  }
}

export function authErrorText(error: unknown): string {
  const code = error instanceof AuthApiError ? error.code : "service_unavailable";
  switch (code) {
    case "invalid_credentials": return "Email hoặc mật khẩu chưa đúng.";
    case "email_token_invalid": return "Liên kết không hợp lệ hoặc không còn dùng được.";
    case "email_token_used": return "Liên kết này đã được sử dụng.";
    case "email_token_expired": return "Liên kết đã hết hạn. Hãy yêu cầu email mới.";
    case "password_policy_violation": return "Mật khẩu cần dài từ 15 đến 128 ký tự.";
    case "password_blocklisted": return "Hãy chọn mật khẩu ít phổ biến hơn.";
    case "reauthentication_required": return "Hãy đăng nhập lại để mở khóa dữ liệu.";
    case "rate_limited": return "Bạn đã thử quá nhiều lần. Hãy đợi rồi thử lại.";
    default: return "Không thể kết nối tài khoản lúc này. Hãy thử lại.";
  }
}

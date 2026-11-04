import { expect, type APIRequestContext, type Locator, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

export type StagingRelease = Readonly<{
  release_id: string;
  build_id: string;
  git_sha: string;
  web_image: string;
  api_image: string;
}>;

export type OwnerCredentials = Readonly<{
  owner_email: string;
  owner_password: string;
}>;

export type PendingMetadata = Readonly<{
  operationIds: string[];
  ciphertextHashes: string[];
}>;

export function stagingUrl(pathname: string): string {
  const origin = process.env.DAYFORGE_STAGING_ORIGIN;
  if (!origin) throw new Error("DAYFORGE_STAGING_ORIGIN_missing");
  return new URL(pathname, origin).toString();
}

export function nextStagingDate(): string {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const field = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return `${field("year")}-${field("month")}-${field("day")}`;
}

function readJsonFile<T>(environmentName: string): T {
  const filePath = process.env[environmentName];
  if (!filePath) throw new Error(`${environmentName}_missing`);
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as T;
  } catch {
    throw new Error(`${environmentName}_invalid`);
  }
}

export function readStagingRelease(): StagingRelease {
  const release = readJsonFile<StagingRelease>("DAYFORGE_STAGING_RELEASE_FILE");
  if (!release.release_id || !release.build_id || !release.git_sha || !release.web_image || !release.api_image) {
    throw new Error("DAYFORGE_STAGING_RELEASE_FILE_schema_invalid");
  }
  return release;
}

export function readOwnerCredentials(): OwnerCredentials {
  const credentials = readJsonFile<OwnerCredentials>("DAYFORGE_STAGING_CREDENTIALS_FILE");
  if (!credentials.owner_email || !credentials.owner_password) {
    throw new Error("DAYFORGE_STAGING_CREDENTIALS_FILE_schema_invalid");
  }
  return credentials;
}

export async function loginOwner(page: Page, credentials: OwnerCredentials): Promise<void> {
  await page.goto(stagingUrl("/account"));
  await page.getByLabel("Email").fill(credentials.owner_email);
  await page.getByLabel("Mật khẩu").fill(credentials.owner_password);
  await page.getByRole("button", { name: "Đăng nhập và mở kho local" }).click();
  await expect(page.getByRole("button", { name: "Đăng xuất và khóa kho local" })).toBeVisible();
}

export async function expectVerifiedSession(request: APIRequestContext): Promise<string> {
  const response = await request.get(stagingUrl("/api/v1/auth/session"));
  if (response.status() !== 200) throw new Error("staging_session_http_failed");
  const session = await response.json() as {
    authenticated?: boolean;
    owner?: { id?: string; email_verified_at?: string } | null;
  };
  if (!session.authenticated || !session.owner?.id || !session.owner.email_verified_at) {
    throw new Error("staging_verified_session_required");
  }
  return session.owner.id;
}

export async function createTaskThroughUi(
  page: Page,
  date: string,
  title: string,
): Promise<Locator> {
  await page.goto(stagingUrl(`/work?date=${encodeURIComponent(date)}&scale=week`));
  const bucket = page.locator(`.work-week-bucket[data-work-date="${date}"][data-period="afternoon"]`);
  await expect(bucket).toBeVisible();
  await bucket.locator(".work-week-add").click();
  const dialog = page.getByRole("dialog", { name: "Thêm công việc" });
  await dialog.getByLabel("Tên công việc").fill(title);
  await dialog.getByLabel("Buổi").selectOption("afternoon");
  await dialog.getByRole("button", { name: "Lưu công việc", exact: true }).click();
  await expect(dialog).toBeHidden();
  const card = bucket.locator(".work-task-card").filter({ hasText: title });
  await expect(card).toBeVisible();
  return card;
}

export async function capturePendingMetadata(
  page: Page,
  ownerId: string,
): Promise<PendingMetadata> {
  return page.evaluate(async ({ ownerId }) => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open("dayforge-local");
      request.onerror = () => reject(new Error("staging_indexeddb_unavailable"));
      request.onsuccess = () => resolve(request.result);
    });
    try {
      if (!database.objectStoreNames.contains("outbox")) {
        throw new Error("staging_outbox_unavailable");
      }
      const rows = await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const transaction = database.transaction(["outbox"], "readonly");
        const request = transaction.objectStore("outbox").index("by-owner").getAll(IDBKeyRange.only(ownerId));
        request.onsuccess = () => resolve(request.result as Array<Record<string, unknown>>);
        request.onerror = () => reject(new Error("staging_outbox_read_failed"));
      });
      const entries = await Promise.all(rows.map(async (row) => {
        const ciphertext = row.ciphertext;
        if (!(ciphertext instanceof ArrayBuffer)) throw new Error("staging_ciphertext_metadata_invalid");
        const hash = await crypto.subtle.digest("SHA-256", ciphertext);
        const hashHex = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
        return { id: String(row.record_id ?? row.id), hash: hashHex };
      }));
      return {
        operationIds: entries.map((entry) => entry.id).sort(),
        ciphertextHashes: entries.map((entry) => entry.hash).sort(),
      };
    } finally {
      database.close();
    }
  }, { ownerId });
}

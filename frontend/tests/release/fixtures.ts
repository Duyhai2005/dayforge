import { chromium, expect, type APIRequestContext, type BrowserContext, type Page, type Route } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export type ReleaseManifest = Readonly<{
  format_version: 1;
  release_id: string;
  git_sha: string;
  build_id: string;
  platform: string;
  web_image: string;
  api_image: string;
  mysql_image: string;
  required_db_revision: string;
  supported_db_revisions: string[];
  indexeddb_schema_version: number;
  supported_indexeddb_schema_versions: number[];
  protocol_versions: number[];
  reducer_versions: number[];
  created_at: string;
  test_harness: false;
}>;

export type PendingMetadata = Readonly<{
  operationIds: string[];
  ciphertextHashes: string[];
  shadowOperationIds: string[];
  shadowCiphertextHashes: string[];
  draftIds: string[];
  draftCiphertextHashes: string[];
}>;

type Credentials = Readonly<{ owner_email: string; owner_password: string }>;
type CaseId = "UP-01" | "UP-02" | "UP-03" | "UP-04" | "UP-05" | "UP-06" | "RB-01" | "RB-02" | "RF-01" | "DR-01";
type CaseRow = Record<string, unknown> & { case_id: CaseId };
type RehearsalResults = { format_version: 1; from_release_id: string; to_release_id: string; cases: CaseRow[] };

const releaseOrigin = required("DAYFORGE_RELEASE_ORIGIN");
const outputRoot = resolve(required("DAYFORGE_RELEASE_EVIDENCE_ROOT"));
const resultsPath = resolve(required("DAYFORGE_RELEASE_RESULTS_FILE"));

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name}_missing`);
  return value;
}

function readJson<T>(name: string): T {
  const file = required(name);
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    throw new Error(`${name}_invalid`);
  }
}

function writePrivateFile(path: string, content: string): void {
  if (existsSync(path)) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("release_private_file_invalid");
  }
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
  renameSync(temporary, path);
}

export function releaseFor(name: "A" | "B"): ReleaseManifest {
  return readJson<ReleaseManifest>(name === "A" ? "DAYFORGE_RELEASE_FROM_FILE" : "DAYFORGE_RELEASE_TO_FILE");
}

function credentials(): Credentials {
  const value = readJson<Credentials>("DAYFORGE_RELEASE_CREDENTIALS_FILE");
  if (!value.owner_email || !value.owner_password) throw new Error("owner_credentials_invalid");
  return value;
}

export function releaseUrl(pathname: string): string {
  return new URL(pathname, releaseOrigin).toString();
}

export async function loginOwner(page: Page): Promise<string> {
  await page.goto(releaseUrl("/account"));
  const logout = page.getByRole("button", { name: "Đăng xuất và khóa kho local" });
  if (!(await logout.isVisible().catch(() => false))) {
    const owner = credentials();
    await page.getByLabel("Email").fill(owner.owner_email);
    await page.getByLabel("Mật khẩu").fill(owner.owner_password);
    await page.getByRole("button", { name: "Đăng nhập và mở kho local" }).click();
    await expect(logout).toBeVisible({ timeout: 60_000 });
  }
  const session = await page.request.get(releaseUrl("/api/v1/auth/session"));
  if (session.status() !== 200) throw new Error("release_session_http_failed");
  const value = await session.json() as { authenticated?: boolean; owner?: { id?: string; email_verified_at?: string } | null };
  if (!value.authenticated || !value.owner?.id || !value.owner.email_verified_at) {
    throw new Error("release_verified_owner_required");
  }
  await page.evaluate(async () => { await navigator.serviceWorker.ready; });
  return value.owner.id;
}

export async function readBuildGate(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate(async () => {
    const request = indexedDB.open("dayforge-local");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("release_indexeddb_unavailable"));
    });
    try {
      if (!database.objectStoreNames.contains("build_gate")) throw new Error("release_build_gate_missing");
      const transaction = database.transaction(["build_gate"], "readonly");
      const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const get = transaction.objectStore("build_gate").get("build_gate");
        get.onsuccess = () => resolve(get.result as Record<string, unknown>);
        get.onerror = () => reject(new Error("release_build_gate_read_failed"));
      });
      return result;
    } finally {
      database.close();
    }
  });
}

export async function currentApprovedBuild(page: Page): Promise<string | null> {
  return String((await readBuildGate(page)).approved_build ?? "") || null;
}

export async function readGatePhase(page: Page): Promise<string | null> {
  return String((await readBuildGate(page)).phase ?? "") || null;
}

export async function announceBuildUpdate(page: Page, name: "A" | "B"): Promise<void> {
  const release = releaseFor(name);
  await page.evaluate(async ({ buildId, schemaVersion }) => {
    const registration = await navigator.serviceWorker.register(
      `/sw.js?build=${encodeURIComponent(buildId)}&schema=${schemaVersion}`,
      { scope: "/", updateViaCache: "none" },
    );
    await registration.update();
  }, { buildId: release.build_id, schemaVersion: release.indexeddb_schema_version });
}

export async function waitForApprovedBuild(page: Page, buildId: string): Promise<void> {
  await expect.poll(() => currentApprovedBuild(page), { timeout: 90_000, intervals: [250, 500, 1_000, 2_000] }).toBe(buildId);
}

export async function capturePendingMetadata(page: Page, ownerId: string): Promise<PendingMetadata> {
  return page.evaluate(async ({ ownerId }) => {
    const request = indexedDB.open("dayforge-local");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("release_indexeddb_unavailable"));
    });
    try {
      for (const name of ["outbox", "shadow", "drafts"]) {
        if (!database.objectStoreNames.contains(name)) throw new Error("release_local_store_missing");
      }
      const tx = database.transaction(["outbox", "shadow", "drafts"], "readonly");
      const read = (name: string) => new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
        const get = tx.objectStore(name).index("by-owner").getAll(IDBKeyRange.only(ownerId));
        get.onsuccess = () => resolve(get.result as Array<Record<string, unknown>>);
        get.onerror = () => reject(new Error("release_local_metadata_read_failed"));
      });
      const [outbox, shadow, drafts] = await Promise.all([read("outbox"), read("shadow"), read("drafts")]);
      const pending = outbox.filter((row) => !row.superseded_by && row.state !== "ack_waiting_pull");
      const hash = async (row: Record<string, unknown>) => {
        const value = row.ciphertext;
        const bytes = value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : ArrayBuffer.isView(value)
            ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
            : null;
        if (!bytes) throw new Error("release_ciphertext_metadata_invalid");
        const digest = await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
        return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      };
      const recordId = (row: Record<string, unknown>) => String(row.record_id ?? row.id ?? "");
      return {
        operationIds: pending.map(recordId).sort(),
        ciphertextHashes: await Promise.all(pending.map(hash)).then((items) => items.sort()),
        shadowOperationIds: shadow.map(recordId).sort(),
        shadowCiphertextHashes: await Promise.all(shadow.map(hash)).then((items) => items.sort()),
        draftIds: drafts.map(recordId).sort(),
        draftCiphertextHashes: await Promise.all(drafts.map(hash)).then((items) => items.sort()),
      };
    } finally {
      database.close();
    }
  }, { ownerId });
}

export async function switchRelease(name: "A" | "B"): Promise<void> {
  const result = invokeReleaseSwitch(name, required("DAYFORGE_RELEASE_RUNTIME_FILE"));
  if (result !== 0) throw new Error(`release_switch_failed:${name}:${result}`);
}

export function invokeReleaseSwitch(name: "A" | "B", runtimeFile: string): number {
  const command = process.env.DAYFORGE_RELEASE_PYTHON;
  const runner = required("DAYFORGE_RELEASE_RUNNER_FILE");
  if (!command) throw new Error("DAYFORGE_RELEASE_PYTHON_missing");
  const args = [
    runner,
    "--config", required("DAYFORGE_RELEASE_CONFIG_FILE"),
    "--from", required("DAYFORGE_RELEASE_FROM_FILE"),
    "--to", required("DAYFORGE_RELEASE_TO_FILE"),
    "--scenario", required("DAYFORGE_RELEASE_SCENARIO"),
    "--output", required("DAYFORGE_RELEASE_OUTPUT_ROOT"),
    "--credentials", required("DAYFORGE_RELEASE_CREDENTIALS_FILE"),
    "--runtime", runtimeFile,
    "--switch-to", name,
  ];
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: 4 * 60 * 60 * 1000 });
  if (result.error) throw new Error(`release_switch_failed:${name}:spawn`);
  return result.status ?? 2;
}

export function profileDirectory(name: "A" | "B"): string {
  return resolve(required(name === "A" ? "DAYFORGE_RELEASE_PROFILE_A_DIR" : "DAYFORGE_RELEASE_PROFILE_B_DIR"));
}

export function profileBindingSha256(name: "A" | "B"): string {
  const directory = profileDirectory(name);
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("release_profile_directory_invalid");
  return createHash("sha256").update(directory).digest("hex");
}

export function originBindingSha256(): string {
  return createHash("sha256").update(releaseOrigin).digest("hex");
}

export async function launchReleaseProfile(name: "A" | "B"): Promise<BrowserContext> {
  const directory = profileDirectory(name);
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("release_profile_directory_invalid");
  return chromium.launchPersistentContext(directory, {
    headless: true,
    baseURL: releaseOrigin,
    serviceWorkers: "allow",
    ignoreHTTPSErrors: false,
  });
}

export async function readServerOperationIds(page: Page): Promise<string[]> {
  const operationIds = new Set<string>();
  let pageToken: string | null = null;
  const tokens = new Set<string>();
  do {
    const query = pageToken ? `?page_token=${encodeURIComponent(pageToken)}` : "";
    const response = await page.request.get(releaseUrl(`/api/v1/sync/bootstrap${query}`), { failOnStatusCode: false });
    if (response.status() !== 200) throw new Error("release_sync_bootstrap_http_failed");
    const body = await response.json() as {
      groups?: Array<{ operation?: { operation_id?: string } }>;
      has_more?: boolean;
      next_page_token?: string | null;
    };
    if (!Array.isArray(body.groups) || typeof body.has_more !== "boolean") throw new Error("release_sync_bootstrap_shape_invalid");
    for (const group of body.groups) {
      const operationId = group.operation?.operation_id;
      if (typeof operationId !== "string" || !/^[0-9a-f-]{36}$/.test(operationId)) throw new Error("release_sync_operation_id_invalid");
      operationIds.add(operationId);
    }
    pageToken = body.has_more ? body.next_page_token ?? null : null;
    if (body.has_more && (!pageToken || tokens.has(pageToken))) throw new Error("release_sync_page_token_invalid");
    if (pageToken) tokens.add(pageToken);
  } while (pageToken);
  return [...operationIds].sort();
}

export async function readOwnerRecoveryState(page: Page, ownerId: string): Promise<{
  serverEpoch: string | null;
  journalCount: number;
}> {
  return page.evaluate(async ({ ownerId }) => {
    const request = indexedDB.open("dayforge-local");
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error("release_indexeddb_unavailable"));
    });
    try {
      if (!database.objectStoreNames.contains("owner_meta") || !database.objectStoreNames.contains("journal")) {
        throw new Error("release_recovery_stores_missing");
      }
      const transaction = database.transaction(["owner_meta", "journal"], "readonly");
      const metadataRequest = transaction.objectStore("owner_meta").get(ownerId);
      const journalRequest = transaction.objectStore("journal").index("by-owner").count(IDBKeyRange.only(ownerId));
      const [metadata, journalCount] = await Promise.all([
        new Promise<Record<string, unknown> | undefined>((resolve, reject) => {
          metadataRequest.onsuccess = () => resolve(metadataRequest.result as Record<string, unknown> | undefined);
          metadataRequest.onerror = () => reject(new Error("release_owner_meta_read_failed"));
        }),
        new Promise<number>((resolve, reject) => {
          journalRequest.onsuccess = () => resolve(journalRequest.result);
          journalRequest.onerror = () => reject(new Error("release_journal_read_failed"));
        }),
      ]);
      if (!metadata || !(metadata.server_epoch === null || typeof metadata.server_epoch === "string")) {
        throw new Error("release_owner_meta_invalid");
      }
      return { serverEpoch: metadata.server_epoch, journalCount };
    } finally {
      database.close();
    }
  }, { ownerId });
}

export function readRestoreSession(): Record<string, unknown> {
  const path = resolve(required("DAYFORGE_RELEASE_RESTORE_STATE_FILE"));
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("release_restore_state_invalid");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch {
    throw new Error("release_restore_state_invalid");
  }
}

export function writeRestoreSession(patch: Record<string, unknown>): void {
  const path = resolve(required("DAYFORGE_RELEASE_RESTORE_STATE_FILE"));
  const current = readRestoreSession();
  writePrivateFile(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
}

export function readCurrentReleaseRecord(): Record<string, unknown> {
  const target = readJson<Record<string, unknown>>("DAYFORGE_RELEASE_CONFIG_FILE");
  const stateDir = target.state_dir;
  if (typeof stateDir !== "string" || !stateDir) throw new Error("release_state_directory_invalid");
  return JSON.parse(readFileSync(resolve(stateDir, "current-release.json"), "utf8")) as Record<string, unknown>;
}

export async function holdNextPushResponse(context: BrowserContext): Promise<{
  requestBytes: Promise<Buffer>;
  retryBytes: Promise<Buffer>;
  committed: Promise<void>;
  release(): void;
}> {
  let releaseResponse!: () => void;
  let resolveBytes!: (value: Buffer) => void;
  let resolveRetry!: (value: Buffer) => void;
  let resolveCommitted!: () => void;
  const requestBytes = new Promise<Buffer>((resolve) => { resolveBytes = resolve; });
  const retryBytes = new Promise<Buffer>((resolve) => { resolveRetry = resolve; });
  const committed = new Promise<void>((resolve) => { resolveCommitted = resolve; });
  const released = new Promise<void>((resolve) => { releaseResponse = resolve; });
  let intercepted = false;
  await context.route("**/api/v1/sync/push**", async (route: Route) => {
    if (intercepted) {
      resolveRetry(route.request().postDataBuffer() ?? Buffer.alloc(0));
      return route.continue();
    }
    intercepted = true;
    const bytes = route.request().postDataBuffer() ?? Buffer.alloc(0);
    resolveBytes(bytes);
    const response = await route.fetch();
    if (!response.ok()) throw new Error("release_push_commit_failed");
    resolveCommitted();
    await released;
    await route.abort("failed");
  });
  return { requestBytes, retryBytes, committed, release: releaseResponse };
}

function releaseFingerprint(name: "A" | "B"): string {
  const value = releaseFor(name);
  const identity = {
    api_digest: value.api_image.split("@").at(-1),
    build_id: value.build_id,
    git_sha: value.git_sha,
    indexeddb_schema_version: value.indexeddb_schema_version,
    mysql_digest: value.mysql_image.split("@").at(-1),
    platform: value.platform,
    protocol_versions: [...value.protocol_versions].sort((a, b) => a - b),
    reducer_versions: [...value.reducer_versions].sort((a, b) => a - b),
    release_id: value.release_id,
    required_db_revision: value.required_db_revision,
    supported_db_revisions: [...value.supported_db_revisions].sort(),
    supported_indexeddb_schema_versions: [...value.supported_indexeddb_schema_versions].sort((a, b) => a - b),
    web_digest: value.web_image.split("@").at(-1),
  };
  const canonicalIdentity = Object.fromEntries(
    Object.entries(identity).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
  );
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalIdentity)).digest("hex")}`;
}

function readResults(): RehearsalResults {
  if (existsSync(resultsPath)) {
    const info = lstatSync(resultsPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("release_results_file_invalid");
  }
  if (!existsSync(resultsPath)) {
    return {
      format_version: 1,
      from_release_id: releaseFor("A").release_id,
      to_release_id: releaseFor("B").release_id,
      cases: [],
    };
  }
  let result: RehearsalResults;
  try {
    result = JSON.parse(readFileSync(resultsPath, "utf8")) as RehearsalResults;
  } catch {
    throw new Error("release_results_file_invalid");
  }
  if (result.format_version !== 1 || result.from_release_id !== releaseFor("A").release_id ||
      result.to_release_id !== releaseFor("B").release_id || !Array.isArray(result.cases)) {
    throw new Error("release_results_candidate_mismatch");
  }
  return result;
}

function writeResults(results: RehearsalResults): void {
  mkdirSync(dirname(resultsPath), { recursive: true, mode: 0o700 });
  writePrivateFile(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
}

export function beginCaseAttempt(
  caseId: CaseId,
  expectedAction: string,
  options: {
    caseVariant?: string;
    snapshotId?: string | null;
    originBindingSha256?: string | null;
    profileABindingSha256?: string | null;
    profileBBindingSha256?: string | null;
  } = {},
): void {
  const results = readResults();
  const variant = options.caseVariant ?? "default";
  const previous = results.cases.find((item) => item.case_id === caseId);
  if (previous && previous.expected_action !== expectedAction) throw new Error("release_case_action_mismatch");
  const row: CaseRow = {
    case_id: caseId,
    status: "RUNNING",
    case_variants: [...new Set([
      ...(Array.isArray(previous?.case_variants) ? previous.case_variants.filter((item): item is string => typeof item === "string") : []),
      variant,
    ])],
    expected_action: expectedAction,
    actual_status: `started ${variant}`,
    evidence_paths: Array.isArray(previous?.evidence_paths) ? previous.evidence_paths : [],
    from_digest: releaseFingerprint("A"),
    to_digest: releaseFingerprint("B"),
    same_origin: caseId === "RF-01" ? null : true,
    same_profile: caseId === "RF-01" ? null : true,
    origin_sha256: options.originBindingSha256 ?? null,
    profile_a_sha256: options.profileABindingSha256 ?? null,
    profile_b_sha256: options.profileBBindingSha256 ?? null,
    snapshot_id: caseId === "DR-01" ? options.snapshotId ?? null : null,
  };
  results.cases = results.cases.filter((item) => item.case_id !== caseId);
  results.cases.push(row);
  writeResults(results);
}

export function recordCaseEvidence(
  caseId: CaseId,
  expectedAction: string,
  actualStatus: string,
  options: {
    snapshotId?: string | null;
    caseVariant?: string;
    sameOrigin?: boolean | null;
    sameProfile?: boolean | null;
    originBindingSha256?: string | null;
    profileABindingSha256?: string | null;
    profileBBindingSha256?: string | null;
  } = {},
): void {
  const from = releaseFor("A");
  const to = releaseFor("B");
  const testedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const evidenceDirectory = resolve(outputRoot, "evidence");
  mkdirSync(evidenceDirectory, { recursive: true, mode: 0o700 });
  const evidenceName = options.caseVariant ? `${caseId}-${options.caseVariant}` : caseId;
  const jsonFile = resolve(evidenceDirectory, `${evidenceName}.json`);
  const textFile = resolve(evidenceDirectory, `${evidenceName}.txt`);
  const manifest = {
    artifact_type: "dayforge-release-rehearsal-evidence",
    format_version: 1,
    case_id: caseId,
    tested_at: testedAt,
    from_release_id: from.release_id,
    from_git_sha: from.git_sha,
    from_build_id: from.build_id,
    from_web_digest: from.web_image.split("@").at(-1),
    from_api_digest: from.api_image.split("@").at(-1),
    from_mysql_digest: from.mysql_image.split("@").at(-1),
    to_release_id: to.release_id,
    to_git_sha: to.git_sha,
    to_build_id: to.build_id,
    to_web_digest: to.web_image.split("@").at(-1),
    to_api_digest: to.api_image.split("@").at(-1),
    to_mysql_digest: to.mysql_image.split("@").at(-1),
    same_origin: options.sameOrigin ?? (caseId === "RF-01" ? null : true),
    same_profile: options.sameProfile ?? (caseId === "RF-01" ? null : true),
    origin_sha256: options.originBindingSha256 ?? null,
    profile_a_sha256: options.profileABindingSha256 ?? null,
    profile_b_sha256: options.profileBBindingSha256 ?? null,
    snapshot_id: caseId === "DR-01" ? options.snapshotId ?? null : null,
  };
  writePrivateFile(jsonFile, `${JSON.stringify(manifest, null, 2)}\n`);
  writePrivateFile(textFile, `Case: ${caseId}\nExpected: ${expectedAction}\nObserved: ${actualStatus}\n`);

  const results = readResults();
  const relativePath = (file: string) => relative(outputRoot, file).split(sep).join("/");
  const previous = results.cases.find((item) => item.case_id === caseId);
  if (previous && previous.expected_action !== expectedAction) throw new Error("release_case_action_mismatch");
  const variant = options.caseVariant ?? "default";
  const row = {
    case_id: caseId,
    status: "PASS",
    expected_action: previous?.expected_action ?? expectedAction,
    actual_status: previous && previous.status === "PASS" ? `${String(previous.actual_status)}; ${actualStatus}` : actualStatus,
    case_variants: [...new Set([
      ...(Array.isArray(previous?.case_variants) ? previous.case_variants.filter((item): item is string => typeof item === "string") : []),
      variant,
    ])],
    evidence_paths: [...new Set([
      ...(Array.isArray(previous?.evidence_paths) ? previous.evidence_paths.filter((item): item is string => typeof item === "string") : []),
      relativePath(jsonFile),
      relativePath(textFile),
    ])],
    from_digest: releaseFingerprint("A"),
    to_digest: releaseFingerprint("B"),
    same_origin: options.sameOrigin ?? (caseId === "RF-01" ? null : true),
    same_profile: options.sameProfile ?? (caseId === "RF-01" ? null : true),
    origin_sha256: options.originBindingSha256 ?? null,
    profile_a_sha256: options.profileABindingSha256 ?? null,
    profile_b_sha256: options.profileBBindingSha256 ?? null,
    snapshot_id: caseId === "DR-01" ? options.snapshotId ?? null : null,
  };
  results.from_release_id = from.release_id;
  results.to_release_id = to.release_id;
  results.cases = results.cases.filter((item) => item.case_id !== caseId);
  results.cases.push(row);
  writeResults(results);
}

export function assertSameReleaseOrigin(context: BrowserContext): void {
  const base = new URL(releaseOrigin);
  if (base.protocol !== "https:" || base.origin !== releaseOrigin) throw new Error("release_origin_invalid");
  void context;
}

export async function createTaskThroughUi(page: Page, title: string): Promise<void> {
  const date = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(Date.now() + 86_400_000));
  await page.goto(releaseUrl(`/work?date=${date}&scale=week`));
  const bucket = page.locator(`.work-week-bucket[data-work-date="${date}"][data-period="afternoon"]`);
  await expect(bucket).toBeVisible();
  await bucket.locator(".work-week-add").click();
  const dialog = page.getByRole("dialog", { name: "Thêm công việc" });
  await dialog.getByLabel("Tên công việc").fill(title);
  await dialog.getByLabel("Buổi").selectOption("afternoon");
  await dialog.getByRole("button", { name: "Lưu công việc", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(bucket.locator(".work-task-card").filter({ hasText: title })).toBeVisible();
}

export async function expectVerifiedSession(request: APIRequestContext): Promise<string> {
  const response = await request.get(releaseUrl("/api/v1/auth/session"));
  if (response.status() !== 200) throw new Error("release_session_http_failed");
  const session = await response.json() as { authenticated?: boolean; owner?: { id?: string; email_verified_at?: string } | null };
  if (!session.authenticated || !session.owner?.id || !session.owner.email_verified_at) {
    throw new Error("release_verified_owner_required");
  }
  return session.owner.id;
}

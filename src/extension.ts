import * as vscode from "vscode";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { spawnSync } from "child_process";
import { URL } from "url";

const PERIOD_USAGE_URL =
  "https://cursor.com/api/dashboard/get-current-period-usage";
const USAGE_SUMMARY_URL = "https://cursor.com/api/usage-summary";
const AGGREGATED_USAGE_URL =
  "https://cursor.com/api/dashboard/get-aggregated-usage-events";
const DASHBOARD_URL = "https://cursor.com/dashboard/usage";
const DASHBOARD_REFERER = "https://cursor.com/dashboard?tab=usage";
const ARC_SETTINGS_URL = "https://arc.trimble.com";
const DEFAULT_ARC_BASE_URL = "https://arc.trimble.com/api/v1";
const SESSION_TOKEN_SECRET_KEY = "cursorSpending.sessionToken";
const ARC_API_KEY_SECRET_KEY = "cursorSpending.arcApiKey";
/** Removed Admin API key path — deleted from SecretStorage on activation. */
const LEGACY_ADMIN_API_KEY_SECRET_KEY = "cursorSpending.adminApiKey";
const ARC_SKILL_ID_STATE_KEY = "cursorSpending.arcSkillId";
const ARC_PAUSE_STATE_KEY = "cursorSpending.arcPause";
/** Credential failures will not fix themselves quickly; avoid a billed failing task every refresh. */
const ARC_CREDENTIAL_PAUSE_MS = 24 * 60 * 60 * 1000;
/** Legacy settings key — migrated once into SecretStorage then cleared. */
const LEGACY_SESSION_TOKEN_SETTING = "sessionToken";
const FETCH_TIMEOUT_MS = 15_000;
/** Arc tasks run an LLM plus skill calls; the socket may idle between events. */
const ARC_TASK_IDLE_TIMEOUT_MS = 120_000;

let outputChannel: vscode.OutputChannel | undefined;

function log(message: string): void {
  const line = `[${new Date().toISOString()}] ${message}`;
  outputChannel?.appendLine(line);
}

interface PlanUsage {
  autoPercentUsed?: number;
  apiPercentUsed?: number;
  limit?: number;
  totalSpend?: number;
  includedSpend?: number;
  remaining?: number;
  bonusTooltip?: string;
  /** Personal plans use Auto/API; enterprise uses Indiv/Team. */
  leftLabel?: string;
  rightLabel?: string;
  source?: "period-usage" | "usage-summary" | "arc";
  /** Set when Arc was configured but failed and the cookie path was used. */
  arcFailure?: string;
  cookieOrigin?: CookieOrigin;
  membershipType?: string;
  leftUsed?: number;
  leftLimit?: number;
  rightUsed?: number;
  rightLimit?: number;
  /** Which teamUsage bucket backs the right meter (enterprise usage-summary). */
  rightKind?: "pooled" | "onDemand";
  /** Secondary team bucket when both pooled and on-demand are present. */
  secondaryRightUsed?: number;
  secondaryRightLimit?: number;
  secondaryRightKind?: "pooled" | "onDemand";
  billingCycleStart?: string;
  billingCycleEnd?: string;
  /** Actual spend today from get-aggregated-usage-events (cents). */
  dailySpendCents?: number;
}

interface UsageBucket {
  enabled?: boolean;
  used?: number;
  limit?: number;
  remaining?: number;
}

interface UsageSummaryResponse {
  membershipType?: string;
  limitType?: string;
  isUnlimited?: boolean;
  billingCycleStart?: string;
  billingCycleEnd?: string;
  individualUsage?: { overall?: UsageBucket };
  teamUsage?: { onDemand?: UsageBucket; pooled?: UsageBucket };
  autoModelSelectedDisplayMessage?: string;
  namedModelSelectedDisplayMessage?: string;
}

interface AggregatedUsageResponse {
  aggregations?: Array<{ totalCents?: number | null }>;
  totalCostCents?: number | null;
}

interface PeriodUsageResponse {
  planUsage?: PlanUsage | null;
  enabled?: boolean;
  displayMessage?: string;
  error?: string;
  description?: string;
  billingCycleStart?: string;
  billingCycleEnd?: string;
}

interface ArcSkill {
  skill_id?: string;
  display_name?: string;
  name?: string;
  status?: string;
}

interface ArcPause {
  until: number;
  reason: string;
}

interface ArcSseEvent {
  event: string;
  data: Record<string, unknown>;
}

let extensionContext: vscode.ExtensionContext;
let statusBarItem: vscode.StatusBarItem;
let refreshIntervalId: ReturnType<typeof setInterval> | undefined;
let cycleIntervalId: ReturnType<typeof setInterval> | undefined;
let latestUsage: PlanUsage | undefined;
/** Each Arc refresh is a billed task, so concurrent refreshes share one run. */
let refreshInFlight: Promise<void> | undefined;
/** 0 = spend vs budget, 1 = daily spend, 2 = budget warning (when at threshold) */
let statusBarView: 0 | 1 | 2 = 0;

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  outputChannel = vscode.window.createOutputChannel("Cursor Spending");
  context.subscriptions.push(outputChannel);
  log("Activating…");

  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );

  context.subscriptions.push(statusBarItem);

  const refreshCommand = vscode.commands.registerCommand(
    "cursorSpending.refresh",
    () => {
      void fetchAndUpdateStatusBar();
    }
  );
  context.subscriptions.push(refreshCommand);

  const openTokenSetupCommand = vscode.commands.registerCommand(
    "cursorSpending.openTokenSetup",
    () => {
      openTokenSetupPanel(context);
    }
  );
  context.subscriptions.push(openTokenSetupCommand);

  const openArcSetupCommand = vscode.commands.registerCommand(
    "cursorSpending.openArcSetup",
    () => {
      openArcSetupPanel(context);
    }
  );
  context.subscriptions.push(openArcSetupCommand);

  const resumeArcCommand = vscode.commands.registerCommand(
    "cursorSpending.resumeArc",
    async () => {
      await clearArcPause();
      log("Arc pause cleared by user.");
      void fetchAndUpdateStatusBar();
    }
  );
  context.subscriptions.push(resumeArcCommand);

  const clearArcKeyCommand = vscode.commands.registerCommand(
    "cursorSpending.clearArcKey",
    async () => {
      await context.secrets.delete(ARC_API_KEY_SECRET_KEY);
      await context.globalState.update(ARC_SKILL_ID_STATE_KEY, undefined);
      await clearArcPause();
      log("Arc API key removed by user.");
      vscode.window.showInformationMessage(
        "Cursor Spending: Arc API key removed. Using your Cursor sign-in as the fallback."
      );
      void fetchAndUpdateStatusBar();
    }
  );
  context.subscriptions.push(clearArcKeyCommand);

  const showLogCommand = vscode.commands.registerCommand(
    "cursorSpending.showLog",
    () => {
      outputChannel?.show(true);
    }
  );
  context.subscriptions.push(showLogCommand);

  void (async () => {
    await context.secrets.delete(LEGACY_ADMIN_API_KEY_SECRET_KEY);
    await migrateLegacySessionToken(context);
    await fetchAndUpdateStatusBar();
    startRefreshTimer();
    startCycleTimer();
  })();
}

export function deactivate(): void {
  if (refreshIntervalId !== undefined) {
    clearInterval(refreshIntervalId);
  }
  if (cycleIntervalId !== undefined) {
    clearInterval(cycleIntervalId);
  }
}

async function migrateLegacySessionToken(
  context: vscode.ExtensionContext
): Promise<void> {
  const existing = (await context.secrets.get(SESSION_TOKEN_SECRET_KEY))?.trim();
  if (existing) {
    return;
  }

  const config = vscode.workspace.getConfiguration("cursorSpending");
  const fromSettings = config
    .get<string>(LEGACY_SESSION_TOKEN_SETTING, "")
    .trim();
  if (!fromSettings) {
    return;
  }

  await context.secrets.store(SESSION_TOKEN_SECRET_KEY, fromSettings);
  await config.update(
    LEGACY_SESSION_TOKEN_SETTING,
    undefined,
    vscode.ConfigurationTarget.Global
  );
}

type CookieOrigin = "cursor-sign-in" | "pasted";

interface SessionCookie {
  token: string;
  origin: CookieOrigin;
}

/** Minimal shape of node:sqlite (Node 22.5+); @types/node 20 does not declare it. */
interface SqliteDatabase {
  prepare(sql: string): { get(...params: unknown[]): unknown };
  close(): void;
}

/**
 * Cursor stores its own sign-in in the shared VS Code state DB, one level above
 * this extension's global storage folder. The dashboard cookie is
 * `<userId>::<accessToken>`, where userId is the part of the JWT `sub` after "|".
 *
 * Cursor 3.x encrypts accessToken at rest as `cursor-safe-storage:v1:` + Electron
 * safeStorage (Chromium OSCrypt). On Windows that is AES-256-GCM with a DPAPI
 * key from `%APPDATA%\Cursor\Local State`.
 */
const CURSOR_SAFE_STORAGE_PREFIX = "cursor-safe-storage:v1:";
const WIN_OSCRYPT_VERSION = "v10";
const WIN_OSCRYPT_NONCE_LEN = 12;
const WIN_OSCRYPT_TAG_LEN = 16;
const WIN_OSCRYPT_KEY_LEN = 32;

/** Process-lifetime cache of Cursor's Windows OSCrypt key. */
let cachedWindowsOsCryptKey: Buffer | undefined;

function cursorStateDbPaths(): string[] {
  const extStorageParent = path.dirname(extensionContext.globalStorageUri.fsPath);
  const candidates = [path.join(extStorageParent, "state.vscdb")];
  // Non-default profiles keep extension storage under User/profiles/<id>/; sign-in stays in User/globalStorage.
  const userDirIndex = extStorageParent.lastIndexOf(`${path.sep}User${path.sep}`);
  if (userDirIndex >= 0) {
    candidates.push(
      path.join(
        extStorageParent.slice(0, userDirIndex + `${path.sep}User`.length),
        "globalStorage",
        "state.vscdb"
      )
    );
  }
  return [...new Set(candidates)].filter((p) => fs.existsSync(p));
}

function cursorLocalStatePath(): string | undefined {
  // Prefer sibling of User/globalStorage: …/Cursor/Local State
  for (const dbPath of cursorStateDbPaths()) {
    const userDir = path.dirname(path.dirname(dbPath)); // …/User
    const candidate = path.join(path.dirname(userDir), "Local State");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  const fallback = path.join(process.env.APPDATA ?? "", "Cursor", "Local State");
  return fs.existsSync(fallback) ? fallback : undefined;
}

function openCursorStateDb(dbPath: string): SqliteDatabase {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { DatabaseSync } = require("node:sqlite") as {
    DatabaseSync: new (file: string, options?: { readOnly?: boolean }) => SqliteDatabase;
  };
  return new DatabaseSync(dbPath, { readOnly: true });
}

function readCursorDbString(dbPath: string, key: string): string {
  const db = openCursorStateDb(dbPath);
  try {
    const row = db
      .prepare("SELECT value FROM ItemTable WHERE key = ?")
      .get(key) as { value?: unknown } | undefined;
    return typeof row?.value === "string" ? row.value.trim() : "";
  } finally {
    db.close();
  }
}

function windowsDpapiUnprotect(blob: Buffer): Buffer {
  const b64 = blob.toString("base64");
  const script = [
    "$ErrorActionPreference='Stop'",
    "Add-Type -AssemblyName System.Security",
    `$bytes=[Convert]::FromBase64String('${b64}')`,
    "$dec=[System.Security.Cryptography.ProtectedData]::Unprotect($bytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
    "[Convert]::ToBase64String($dec)",
  ].join(";");
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true }
  );
  if (result.status !== 0) {
    throw new Error(
      `DPAPI unprotect failed: ${(result.stderr || result.stdout || "").trim().slice(0, 200)}`
    );
  }
  const out = (result.stdout || "").trim();
  if (!out) {
    throw new Error("DPAPI unprotect returned empty key");
  }
  return Buffer.from(out, "base64");
}

function loadWindowsOsCryptKey(): Buffer {
  if (cachedWindowsOsCryptKey) {
    return cachedWindowsOsCryptKey;
  }
  const localStatePath = cursorLocalStatePath();
  if (!localStatePath) {
    throw new Error('Cursor "Local State" file not found (needed to decrypt sign-in).');
  }
  const parsed = JSON.parse(fs.readFileSync(localStatePath, "utf8")) as {
    os_crypt?: { encrypted_key?: string };
  };
  const encKeyB64 = parsed.os_crypt?.encrypted_key;
  if (!encKeyB64) {
    throw new Error('Cursor "Local State" has no os_crypt.encrypted_key.');
  }
  const encKey = Buffer.from(encKeyB64, "base64");
  if (encKey.subarray(0, 5).toString("latin1") !== "DPAPI") {
    throw new Error(
      `Unsupported OSCrypt key prefix "${encKey.subarray(0, 5).toString("latin1")}" (expected DPAPI).`
    );
  }
  const key = windowsDpapiUnprotect(encKey.subarray(5));
  if (key.length !== WIN_OSCRYPT_KEY_LEN) {
    throw new Error(
      `OSCrypt key length ${key.length}, expected ${WIN_OSCRYPT_KEY_LEN}.`
    );
  }
  cachedWindowsOsCryptKey = key;
  return key;
}

function decryptWindowsOsCryptBlob(blob: Buffer, key32: Buffer): string {
  if (blob.subarray(0, 3).toString("latin1") !== WIN_OSCRYPT_VERSION) {
    throw new Error(
      `Unsupported safeStorage version "${blob.subarray(0, 3).toString("latin1")}" (expected v10).`
    );
  }
  const nonce = blob.subarray(3, 3 + WIN_OSCRYPT_NONCE_LEN);
  const tag = blob.subarray(blob.length - WIN_OSCRYPT_TAG_LEN);
  const ciphertext = blob.subarray(
    3 + WIN_OSCRYPT_NONCE_LEN,
    blob.length - WIN_OSCRYPT_TAG_LEN
  );
  const decipher = crypto.createDecipheriv("aes-256-gcm", key32, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString(
    "utf8"
  );
}

/** Decrypt Cursor 3.x `cursor-safe-storage:v1:` values; pass through plain JWTs. */
function unwrapCursorAccessToken(raw: string): string {
  const value = raw.trim();
  if (!value.startsWith(CURSOR_SAFE_STORAGE_PREFIX)) {
    return value;
  }
  if (process.platform !== "win32") {
    throw new Error(
      `Encrypted Cursor token found, but decrypt is only implemented on Windows (got ${process.platform}).`
    );
  }
  const blob = Buffer.from(value.slice(CURSOR_SAFE_STORAGE_PREFIX.length), "base64");
  const plaintext = decryptWindowsOsCryptBlob(blob, loadWindowsOsCryptKey());
  log("Cursor sign-in: decrypted cursor-safe-storage token.");
  return plaintext;
}

function userIdFromAuthSubject(subject: string | undefined): string | undefined {
  if (!subject) {
    return undefined;
  }
  const parts = subject.split("|");
  const id = parts.length > 1 ? parts[parts.length - 1] : subject;
  return id.trim() || undefined;
}

function readCursorCachedUserId(dbPath: string): string | undefined {
  for (const key of [
    "cursorAuth/cachedScopedProfile",
    "cursorAuth/stripeMembershipAuthId",
  ]) {
    const raw = readCursorDbString(dbPath, key);
    if (!raw) {
      continue;
    }
    if (raw.startsWith("{")) {
      try {
        const parsed = JSON.parse(raw) as { authId?: string };
        const id = userIdFromAuthSubject(parsed.authId);
        if (id) {
          return id;
        }
      } catch {
        /* ignore */
      }
    } else {
      const id = userIdFromAuthSubject(raw);
      if (id) {
        return id;
      }
    }
  }
  return undefined;
}

function readCursorAccessToken(dbPath: string): string {
  const raw = readCursorDbString(dbPath, "cursorAuth/accessToken");
  return raw ? unwrapCursorAccessToken(raw) : "";
}

function readCursorSignInCookie(): string | undefined {
  const dbPaths = cursorStateDbPaths();
  if (dbPaths.length === 0) {
    log("Cursor sign-in: state DB not found.");
    return undefined;
  }

  try {
    let accessToken = "";
    let dbPathUsed = "";
    for (const dbPath of dbPaths) {
      try {
        accessToken = readCursorAccessToken(dbPath);
      } catch (err) {
        log(
          `Cursor sign-in: token unwrap failed for ${dbPath}: ${
            err instanceof Error ? err.message : String(err)
          }`
        );
        continue;
      }
      if (accessToken) {
        dbPathUsed = dbPath;
        break;
      }
    }
    if (!accessToken) {
      log("Cursor sign-in: no access token (signed out of Cursor?).");
      return undefined;
    }

    const claims = decodeJwtClaims(accessToken);
    let userId = userIdFromAuthSubject(
      typeof claims?.sub === "string" ? claims.sub : undefined
    );
    if (!userId && dbPathUsed) {
      userId = readCursorCachedUserId(dbPathUsed);
      if (userId) {
        log(`Cursor sign-in: using cached profile user id ${userId}.`);
      }
    }
    if (!userId) {
      log("Cursor sign-in: access token has no usable user ID.");
      return undefined;
    }
    if (typeof claims?.exp === "number" && claims.exp * 1000 <= Date.now()) {
      log("Cursor sign-in: access token expired; Cursor will refresh it on next use.");
      return undefined;
    }
    return `${userId}::${accessToken}`;
  } catch (err) {
    log(
      `Cursor sign-in: could not read state DB: ${err instanceof Error ? err.message : String(err)}`
    );
    return undefined;
  }
}

function decodeJwtClaims(jwt: string): Record<string, unknown> | undefined {
  const payload = jwt.split(".")[1];
  if (!payload) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return undefined;
  }
}

async function getSessionCookie(): Promise<SessionCookie | undefined> {
  const useSignIn = vscode.workspace
    .getConfiguration("cursorSpending")
    .get<boolean>("useCursorSignIn", true);
  if (useSignIn) {
    const fromSignIn = readCursorSignInCookie();
    if (fromSignIn) {
      return { token: fromSignIn, origin: "cursor-sign-in" };
    }
  }
  const pasted = normalizeSessionToken(
    (await extensionContext.secrets.get(SESSION_TOKEN_SECRET_KEY)) ?? ""
  );
  return pasted ? { token: pasted, origin: "pasted" } : undefined;
}

/** Clean pasted cookie values (quotes, prefix, URL-encoding). */
function normalizeSessionToken(token: string): string {
  let t = token.replace(/[\r\n\t]/g, "").trim();
  if (
    (t.startsWith('"') && t.endsWith('"')) ||
    (t.startsWith("'") && t.endsWith("'"))
  ) {
    t = t.slice(1, -1);
  }
  const prefix = "WorkosCursorSessionToken=";
  if (t.toLowerCase().startsWith(prefix.toLowerCase())) {
    t = t.slice(prefix.length);
  }
  try {
    if (/%3a%3a/i.test(t)) {
      t = decodeURIComponent(t);
    }
  } catch {
    // keep raw
  }
  return t.trim();
}

async function storeSessionToken(token: string): Promise<void> {
  await extensionContext.secrets.store(
    SESSION_TOKEN_SECRET_KEY,
    normalizeSessionToken(token)
  );
}

async function getArcApiKey(): Promise<string> {
  return (
    (await extensionContext.secrets.get(ARC_API_KEY_SECRET_KEY))?.trim() ?? ""
  );
}

async function storeArcApiKey(key: string): Promise<void> {
  let k = key.replace(/[\r\n\t]/g, "").trim();
  if (
    (k.startsWith('"') && k.endsWith('"')) ||
    (k.startsWith("'") && k.endsWith("'"))
  ) {
    k = k.slice(1, -1);
  }
  if (k.toLowerCase().startsWith("bearer ")) {
    k = k.slice(7);
  }
  await extensionContext.secrets.store(ARC_API_KEY_SECRET_KEY, k.trim());
}

function getLookupEmail(): string {
  return vscode.workspace
    .getConfiguration("cursorSpending")
    .get<string>("lookupEmail", "")
    .trim();
}

function getArcBaseUrl(): string {
  const configured = vscode.workspace
    .getConfiguration("cursorSpending")
    .get<string>("arcBaseUrl", DEFAULT_ARC_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  return configured || DEFAULT_ARC_BASE_URL;
}

function startRefreshTimer(): void {
  const config = vscode.workspace.getConfiguration("cursorSpending");
  const intervalMinutes = config.get<number>("refreshInterval", 60);
  const intervalMs = intervalMinutes * 60 * 1000;

  if (refreshIntervalId !== undefined) {
    clearInterval(refreshIntervalId);
  }
  refreshIntervalId = setInterval(() => {
    void fetchAndUpdateStatusBar();
  }, intervalMs);
}

function startCycleTimer(): void {
  const config = vscode.workspace.getConfiguration("cursorSpending");
  const seconds = config.get<number>("statusBarCycleSeconds", 5);
  const intervalMs = Math.max(2, seconds) * 1000;

  if (cycleIntervalId !== undefined) {
    clearInterval(cycleIntervalId);
  }
  cycleIntervalId = setInterval(() => {
    if (!latestUsage) {
      return;
    }
    statusBarView = nextStatusBarView(latestUsage, statusBarView);
    setStatusBarUsage(statusBarItem, latestUsage);
  }, intervalMs);
}

interface HttpResult {
  status: number;
  statusText: string;
  body: string;
}

function httpsJsonRequest(
  method: "GET" | "POST",
  urlString: string,
  headers: Record<string, string>,
  body?: string
): Promise<HttpResult> {
  const url = new URL(urlString);
  const reqHeaders: Record<string, string> = { ...headers };
  if (body !== undefined) {
    reqHeaders["Content-Type"] =
      reqHeaders["Content-Type"] ?? "application/json";
    reqHeaders["Content-Length"] = String(Buffer.byteLength(body));
  }

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname + url.search,
        method,
        headers: reqHeaders,
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(
        Object.assign(
          new Error(
            `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s. Check network/proxy, or re-paste your credentials.`
          ),
          { name: "TimeoutError" }
        )
      );
    });
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

function cursorApiRequest(
  method: "GET" | "POST",
  urlString: string,
  token: string,
  body?: string
): Promise<HttpResult> {
  return httpsJsonRequest(
    method,
    urlString,
    {
      Accept: "application/json",
      "Accept-Language": "en-US,en;q=0.9",
      "Cache-Control": "no-cache",
      Pragma: "no-cache",
      Origin: "https://cursor.com",
      Referer: DASHBOARD_REFERER,
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.2 Safari/605.1.15",
      Cookie: `WorkosCursorSessionToken=${token}`,
    },
    body
  );
}

function arcRequest(
  method: "GET" | "POST",
  path: string,
  apiKey: string,
  body?: string
): Promise<HttpResult> {
  return httpsJsonRequest(
    method,
    `${getArcBaseUrl()}${path}`,
    {
      Accept: "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "cursor-spending-extension",
    },
    body
  );
}

function arcAuthError(status: number): Error {
  return new Error(
    `Arc rejected the API key (${status}). It may be invalid, expired (max 365 days), or revoked. ` +
      `Create a new User key at arc.trimble.com → Settings → API Keys.`
  );
}

/** POST /tasks/ with stream:true and collect SSE events until the stream ends. */
function arcStreamTask(apiKey: string, body: string): Promise<ArcSseEvent[]> {
  const url = new URL(`${getArcBaseUrl()}/tasks/`);
  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: "POST",
        headers: {
          Accept: "text/event-stream",
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
          "User-Agent": "cursor-spending-extension",
        },
        timeout: ARC_TASK_IDLE_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          const chunks: Buffer[] = [];
          res.on("data", (c: Buffer) => chunks.push(c));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            if (status === 401 || status === 403) {
              reject(arcAuthError(status));
              return;
            }
            reject(
              new Error(`Arc task returned ${status}: ${text.slice(0, 300)}`)
            );
          });
          return;
        }

        const events: ArcSseEvent[] = [];
        let buffer = "";
        let settled = false;
        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(events);
        };
        const flush = (block: string): void => {
          let eventName = "";
          const dataLines: string[] = [];
          for (const line of block.split(/\r?\n/)) {
            if (line.startsWith("event:")) {
              eventName = line.slice(6).trim();
            } else if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trimStart());
            }
          }
          if (dataLines.length === 0) {
            return;
          }
          const raw = dataLines.join("\n");
          let data: Record<string, unknown>;
          try {
            const parsed: unknown = JSON.parse(raw);
            data =
              parsed && typeof parsed === "object"
                ? (parsed as Record<string, unknown>)
                : { value: parsed };
          } catch {
            data = { value: raw };
          }
          const name =
            eventName || (typeof data.event === "string" ? data.event : "");
          events.push({ event: name, data });
          if (name === "tool.call" || name === "tool.result" || name === "task.failed") {
            const detail = textOf(
              name === "tool.call"
                ? { tool: data.tool, arguments: data.arguments }
                : (data.result ?? data.error ?? data)
            );
            log(`Arc event: ${name} ${detail.replace(/\s+/g, " ").slice(0, 300)}`);
          } else {
            log(`Arc event: ${name || "(unnamed)"}`);
          }
          // Arc may keep the SSE connection open after the terminal event.
          if (name === "task.completed" || name === "task.failed") {
            finish();
            req.destroy();
          }
        };

        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          if (settled) {
            return;
          }
          buffer += chunk;
          const parts = buffer.split(/\r?\n\r?\n/);
          buffer = parts.pop() ?? "";
          for (const part of parts) {
            flush(part);
            if (settled) {
              return;
            }
          }
        });
        res.on("end", () => {
          if (!settled && buffer.trim()) {
            flush(buffer);
          }
          finish();
        });
        res.on("error", reject);
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(
        Object.assign(
          new Error(
            `Arc task stalled for ${ARC_TASK_IDLE_TIMEOUT_MS / 1000}s without data.`
          ),
          { name: "TimeoutError" }
        )
      );
    });
    req.write(body);
    req.end();
  });
}

function percentUsed(used?: number, limit?: number): number | undefined {
  if (typeof used !== "number" || typeof limit !== "number" || limit <= 0) {
    return undefined;
  }
  return (used / limit) * 100;
}

function planUsageFromPeriod(data: PeriodUsageResponse): PlanUsage | undefined {
  if (!data?.planUsage || typeof data.planUsage !== "object") {
    return undefined;
  }
  return {
    ...data.planUsage,
    leftLabel: "Auto",
    rightLabel: "API",
    source: "period-usage",
    billingCycleStart: data.billingCycleStart ?? data.planUsage.billingCycleStart,
    billingCycleEnd: data.billingCycleEnd ?? data.planUsage.billingCycleEnd,
  };
}

function bucketHasMeter(bucket?: UsageBucket): boolean {
  return (
    typeof bucket?.used === "number" ||
    (typeof bucket?.limit === "number" && bucket.limit > 0)
  );
}

/**
 * Prefer teamUsage.pooled when present (org included pool); onDemand is often
 * $0 until the pool is exhausted. Keep the other bucket as secondary.
 */
function pickTeamMeters(teamUsage?: UsageSummaryResponse["teamUsage"]): {
  primary?: UsageBucket;
  primaryKind?: "pooled" | "onDemand";
  secondary?: UsageBucket;
  secondaryKind?: "pooled" | "onDemand";
} {
  const pooled = teamUsage?.pooled;
  const onDemand = teamUsage?.onDemand;
  const hasPooled = bucketHasMeter(pooled);
  const hasOnDemand = bucketHasMeter(onDemand);

  if (hasPooled && hasOnDemand) {
    return {
      primary: pooled,
      primaryKind: "pooled",
      secondary: onDemand,
      secondaryKind: "onDemand",
    };
  }
  if (hasPooled) {
    return { primary: pooled, primaryKind: "pooled" };
  }
  if (hasOnDemand) {
    return { primary: onDemand, primaryKind: "onDemand" };
  }
  return {};
}

function planUsageFromSummary(data: UsageSummaryResponse): PlanUsage | undefined {
  const overall = data.individualUsage?.overall;
  const team = pickTeamMeters(data.teamUsage);
  const leftPct = percentUsed(overall?.used, overall?.limit);
  const rightPct = percentUsed(team.primary?.used, team.primary?.limit);

  if (leftPct === undefined && rightPct === undefined) {
    return undefined;
  }

  const isEnterprise =
    (data.membershipType ?? "").toLowerCase() === "enterprise" ||
    (data.limitType ?? "").toLowerCase() === "team";

  if (team.primaryKind) {
    log(
      `usage-summary team meters: primary=${team.primaryKind} ` +
        `used=${team.primary?.used ?? "n/a"} limit=${team.primary?.limit ?? "n/a"}` +
        (team.secondaryKind
          ? `; secondary=${team.secondaryKind} used=${team.secondary?.used ?? "n/a"} limit=${team.secondary?.limit ?? "n/a"}`
          : "")
    );
  }

  return {
    autoPercentUsed: leftPct,
    apiPercentUsed: rightPct,
    leftLabel: isEnterprise ? "Indiv" : "Auto",
    rightLabel: isEnterprise
      ? team.primaryKind === "pooled"
        ? "Team pooled"
        : "Team"
      : "API",
    source: "usage-summary",
    membershipType: data.membershipType,
    leftUsed: overall?.used,
    leftLimit: overall?.limit,
    rightUsed: team.primary?.used,
    rightLimit: team.primary?.limit,
    rightKind: team.primaryKind,
    secondaryRightUsed: team.secondary?.used,
    secondaryRightLimit: team.secondary?.limit,
    secondaryRightKind: team.secondaryKind,
    // usage-summary buckets are in cents (same as period-usage spend fields).
    totalSpend: overall?.used,
    includedSpend: overall?.limit,
    remaining: overall?.remaining,
    limit: overall?.limit,
    billingCycleStart: data.billingCycleStart,
    billingCycleEnd: data.billingCycleEnd,
    // Do not surface autoModelSelectedDisplayMessage / namedModelSelectedDisplayMessage.
    // On enterprise they often say "0% of included total usage" while individualUsage.overall
    // already carries the real Indiv used/limit percent shown above.
  };
}

function parseJsonBody<T>(body: string, label: string): T {
  try {
    return JSON.parse(body) as T;
  } catch {
    log(`Non-JSON body from ${label}: ${body.slice(0, 300)}`);
    throw new Error(
      `${label} returned non-JSON (session cookie may be invalid or expired).`
    );
  }
}

function startOfLocalDayMs(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function totalCentsFromAggregated(data: AggregatedUsageResponse): number | undefined {
  if (typeof data.totalCostCents === "number") {
    return data.totalCostCents;
  }
  let sum = 0;
  let sawAny = false;
  for (const row of data.aggregations ?? []) {
    if (typeof row.totalCents === "number") {
      sum += row.totalCents;
      sawAny = true;
    }
  }
  if (sawAny) {
    return sum;
  }
  // Explicit null total with empty aggregations means $0 for the range.
  if (data.totalCostCents === null || Array.isArray(data.aggregations)) {
    return 0;
  }
  return undefined;
}

/** Today's spend from the same API that powers cursor.com/dashboard/usage. */
async function fetchTodaySpendCents(token: string): Promise<number | undefined> {
  const body = JSON.stringify({
    teamId: -1,
    startDate: startOfLocalDayMs(),
    endDate: Date.now(),
  });
  log(`Fetching ${AGGREGATED_USAGE_URL} (today)…`);
  const res = await cursorApiRequest("POST", AGGREGATED_USAGE_URL, token, body);
  log(`Aggregated-usage status ${res.status}`);
  if (res.status < 200 || res.status >= 300) {
    log(`Aggregated-usage failed: ${res.body.slice(0, 200)}`);
    return undefined;
  }
  const data = parseJsonBody<AggregatedUsageResponse>(res.body, "aggregated-usage");
  const cents = totalCentsFromAggregated(data);
  log(
    `Today spend cents: ${cents ?? "n/a"} (keys: ${Object.keys(data).join(", ") || "(none)"})`
  );
  return cents;
}

async function attachDailySpend(
  token: string,
  usage: PlanUsage
): Promise<PlanUsage> {
  try {
    const todayCents = await fetchTodaySpendCents(token);
    if (todayCents !== undefined) {
      return { ...usage, dailySpendCents: todayCents };
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log(`Today spend fetch failed: ${message}`);
  }
  return usage;
}

function isoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function arcSkillMatches(skill: ArcSkill): boolean {
  const names = [skill.display_name, skill.name, skill.skill_id]
    .filter((s): s is string => typeof s === "string")
    .map((s) => s.toLowerCase().replace(/[\s_]+/g, "-"));
  return names.some((n) => n.includes("cursor-insights"));
}

async function resolveArcSkillId(apiKey: string): Promise<string> {
  const override = vscode.workspace
    .getConfiguration("cursorSpending")
    .get<string>("arcSkillId", "")
    .trim();
  if (override) {
    return override;
  }
  const cached = extensionContext.globalState.get<string>(ARC_SKILL_ID_STATE_KEY);
  if (cached) {
    return cached;
  }

  log("Discovering Cursor Insights skill via GET /skills/…");
  const res = await arcRequest("GET", "/skills/", apiKey);
  log(`Arc skills status ${res.status}`);
  if (res.status === 401 || res.status === 403) {
    throw arcAuthError(res.status);
  }
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Arc /skills/ returned ${res.status}: ${res.body.slice(0, 200)}`);
  }
  const parsed = parseJsonBody<{ data?: ArcSkill[] } | ArcSkill[]>(
    res.body,
    "arc-skills"
  );
  const skills = Array.isArray(parsed) ? parsed : (parsed.data ?? []);
  const match = skills.find(arcSkillMatches);
  if (!match?.skill_id) {
    log(
      `Arc skills visible to this key: ${skills
        .map((s) => s.display_name ?? s.name ?? s.skill_id)
        .join(", ") || "(none)"}`
    );
    throw new Error(
      "Cursor Insights skill is not available to this Arc key. Enable it in Arc, or set cursorSpending.arcSkillId."
    );
  }
  log(`Using Cursor Insights skill ${match.skill_id} (${match.display_name ?? match.name ?? ""})`);
  await extensionContext.globalState.update(ARC_SKILL_ID_STATE_KEY, match.skill_id);
  return match.skill_id;
}

function textOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === undefined || value === null) {
    return "";
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function parseMoney(raw: string): number | undefined {
  const n = Number(raw.replace(/,/g, ""));
  return Number.isFinite(n) ? n : undefined;
}

interface ArcSpendResult {
  cycleCents?: number;
  todayCents?: number;
  limitCents?: number;
  teamSpendCents?: number;
}

/**
 * Extract values from raw Cursor Insights tool output (not LLM prose).
 * Filtered-usage-events results are told apart by the start_date in the preceding tool.call.
 */
function parseArcToolResults(
  events: ArcSseEvent[],
  email: string,
  today: string,
  cycleStart: string
): ArcSpendResult {
  const result: ArcSpendResult = {};
  const emailLower = email.toLowerCase();
  let lastCallArgs = "";
  let filteredSeen = 0;

  for (const ev of events) {
    if (ev.event === "tool.call") {
      lastCallArgs = textOf(ev.data.arguments ?? ev.data);
      continue;
    }
    if (ev.event !== "tool.result") {
      continue;
    }
    const text = textOf(ev.data.result ?? ev.data.output ?? ev.data);
    if (/little busy right now/i.test(text)) {
      throw new Error("Cursor's API is rate limited right now; try again in a minute.");
    }

    const chargedMatch = /Total chargedCents \(raw\):\s*([\d.,]+)/.exec(text);
    if (chargedMatch) {
      if (!text.toLowerCase().includes(emailLower)) {
        log("Ignoring usage-events result that does not reference the configured email.");
        continue;
      }
      const cents = parseMoney(chargedMatch[1]);
      filteredSeen++;
      const isToday = lastCallArgs.includes(today) && !lastCallArgs.includes(cycleStart);
      const isCycle = lastCallArgs.includes(cycleStart);
      if (cycleStart === today && (isToday || isCycle)) {
        result.todayCents = cents;
        result.cycleCents = cents;
      } else if (isCycle) {
        result.cycleCents = cents;
      } else if (isToday) {
        result.todayCents = cents;
      } else if (filteredSeen === 1) {
        result.todayCents = cents;
      } else {
        result.cycleCents = cents;
      }
      continue;
    }

    if (/Spend data \(showing/.test(text)) {
      const countMatch = /showing\s+(\d+)\s+of\s+(\d+)\s+member/.exec(text);
      const total = countMatch ? Number(countMatch[2]) : NaN;
      if (total !== 1) {
        log(`get_team_spend matched ${countMatch?.[2] ?? "?"} members; ignoring limit.`);
        continue;
      }
      const limitMatch = /Limit:\s*\$([\d.,]+)/.exec(text);
      if (limitMatch) {
        const dollars = parseMoney(limitMatch[1]);
        if (dollars !== undefined && dollars > 0) {
          result.limitCents = Math.round(dollars * 100);
        }
      }
      const costMatch = /Dashboard Cost \(USD\):\s*\$([\d.,]+)/.exec(text);
      if (costMatch) {
        const dollars = parseMoney(costMatch[1]);
        if (dollars !== undefined) {
          result.teamSpendCents = Math.round(dollars * 100);
        }
      }
    }
  }
  return result;
}

/** Logs which skill credentials Arc considers provided (names only, never values). */
async function logSkillTokenReadiness(apiKey: string, skillId: string): Promise<void> {
  try {
    const res = await arcRequest("GET", `/skills/${encodeURIComponent(skillId)}/tokens`, apiKey);
    log(`Arc skill token readiness status ${res.status}: ${res.body.slice(0, 500)}`);
  } catch (err) {
    log(`Arc skill token readiness check failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function resolveUsageViaArc(apiKey: string): Promise<PlanUsage> {
  const email = getLookupEmail();
  if (!email || !email.includes("@")) {
    throw new Error(
      "Set your full Cursor account email (Cursor Spending: Set up Arc API key)."
    );
  }
  const skillId = await resolveArcSkillId(apiKey);

  const now = new Date();
  const today = isoDate(now);
  const tomorrow = isoDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
  const cycleStart = isoDate(new Date(now.getFullYear(), now.getMonth(), 1));

  const prompt = [
    `Using the Cursor Insights skill only, make exactly these three tool calls for the single user ${email}:`,
    `1. get_filtered_usage_events with email="${email}", start_date="${today}", end_date="${tomorrow}", max_results=1`,
    `2. get_filtered_usage_events with email="${email}", start_date="${cycleStart}", end_date="${tomorrow}", max_results=1`,
    `3. get_team_spend with search_term="${email}", max_results=1`,
    "Do not query any other user. After the calls, reply with one short line only.",
  ].join("\n");

  const body = JSON.stringify({
    prompt,
    skills: { mode: "explicit", enabled: [skillId] },
    config: { stream: true, max_turns: 8, timeout_seconds: 120 },
  });

  log(`Running Arc task for ${email} (skill ${skillId})…`);
  const events = await arcStreamTask(apiKey, body);
  log(
    `Arc task finished with ${events.length} event(s): ${[
      ...new Set(events.map((e) => e.event || "(unnamed)")),
    ].join(", ")}`
  );

  const failed = events.find((e) => e.event === "task.failed");
  if (failed) {
    const reason = textOf(failed.data.error ?? failed.data);
    if (/credential|token/i.test(reason)) {
      await logSkillTokenReadiness(apiKey, skillId);
      await extensionContext.globalState.update(ARC_SKILL_ID_STATE_KEY, undefined);
      await pauseArc(`Cursor Insights credentials missing in Arc: ${reason.slice(0, 200)}`);
    }
    throw new Error(`Arc task failed: ${reason.slice(0, 300)}`);
  }

  const parsed = parseArcToolResults(events, email, today, cycleStart);
  log(
    `Arc parsed: cycle=${parsed.cycleCents ?? "n/a"}c today=${parsed.todayCents ?? "n/a"}c ` +
      `limit=${parsed.limitCents ?? "n/a"}c teamSpend=${parsed.teamSpendCents ?? "n/a"}c`
  );
  if (parsed.cycleCents === undefined && parsed.todayCents === undefined) {
    const sample = events
      .filter((e) => e.event === "tool.result")
      .map((e) => textOf(e.data.result ?? e.data).slice(0, 300))
      .join(" | ");
    log(`Arc tool results sample: ${sample || "(no tool.result events)"}`);
    throw new Error("Arc task returned no spend values for your email (see Output log).");
  }

  const spend = parsed.cycleCents ?? parsed.teamSpendCents;
  const limit = parsed.limitCents;
  return {
    source: "arc",
    leftLabel: "Spend",
    rightLabel: "On-demand",
    leftUsed: spend,
    totalSpend: spend,
    leftLimit: limit,
    limit,
    includedSpend: limit,
    remaining:
      typeof spend === "number" && typeof limit === "number"
        ? Math.max(0, limit - spend)
        : undefined,
    autoPercentUsed: percentUsed(spend, limit),
    billingCycleStart: `${cycleStart}T00:00:00`,
    dailySpendCents: parsed.todayCents,
    bonusTooltip: email,
  };
}

async function pauseArc(reason: string): Promise<void> {
  const pause: ArcPause = { until: Date.now() + ARC_CREDENTIAL_PAUSE_MS, reason };
  await extensionContext.globalState.update(ARC_PAUSE_STATE_KEY, pause);
  log(`Arc paused until ${new Date(pause.until).toLocaleString()}: ${reason}`);
}

async function clearArcPause(): Promise<void> {
  await extensionContext.globalState.update(ARC_PAUSE_STATE_KEY, undefined);
}

function activeArcPause(): ArcPause | undefined {
  const pause = extensionContext.globalState.get<ArcPause>(ARC_PAUSE_STATE_KEY);
  return pause && pause.until > Date.now() ? pause : undefined;
}

async function resolveUsagePrimaryThenFallback(): Promise<PlanUsage> {
  const arcKey = await getArcApiKey();
  const cookie = await getSessionCookie();
  let arcFailure: string | undefined;

  const pause = arcKey ? activeArcPause() : undefined;
  if (pause) {
    arcFailure =
      `Arc paused until ${new Date(pause.until).toLocaleString()} (${pause.reason}). ` +
      `Run "Cursor Spending: Resume Arc" to retry now.`;
    log(arcFailure);
    if (!cookie) {
      throw new Error(arcFailure);
    }
    return { ...(await resolveUsageViaCookie(cookie)), arcFailure };
  }

  if (arcKey) {
    try {
      return await resolveUsageViaArc(arcKey);
    } catch (err) {
      arcFailure = err instanceof Error ? err.message : String(err);
      log(`Arc primary failed: ${arcFailure}`);
      if (/MISSING_SUBJECT/.test(arcFailure)) {
        arcFailure =
          "This is an Arc Application key. Only User keys are supported; " +
          'create one at arc.trimble.com → Settings → API Keys and run "Cursor Spending: Set up Arc API key".';
        await pauseArc("Application key is not supported");
      }
      if (!cookie) {
        throw err instanceof Error ? err : new Error(arcFailure);
      }
      log("Falling back to session cookie…");
    }
  }

  if (!cookie) {
    throw new Error(
      "Sign in to Cursor, set up an Arc API key, or paste a session cookie."
    );
  }
  const usage = await resolveUsageViaCookie(cookie);
  return arcFailure ? { ...usage, arcFailure } : usage;
}

async function resolveUsageViaCookie(cookie: SessionCookie): Promise<PlanUsage> {
  log(
    `Using session cookie from ${cookie.origin === "cursor-sign-in" ? "Cursor sign-in" : "pasted value"}.`
  );
  try {
    return { ...(await resolveUsageViaCookieToken(cookie.token)), cookieOrigin: cookie.origin };
  } catch (err) {
    if (cookie.origin !== "cursor-sign-in") {
      throw err;
    }
    const pasted = normalizeSessionToken(
      (await extensionContext.secrets.get(SESSION_TOKEN_SECRET_KEY)) ?? ""
    );
    if (!pasted) {
      throw err;
    }
    log(
      `Cursor sign-in cookie failed (${err instanceof Error ? err.message : String(err)}); trying pasted cookie…`
    );
    return { ...(await resolveUsageViaCookieToken(pasted)), cookieOrigin: "pasted" };
  }
}

async function resolveUsageViaCookieToken(token: string): Promise<PlanUsage> {
  log(`Fetching ${PERIOD_USAGE_URL}…`);
  const periodRes = await cursorApiRequest("POST", PERIOD_USAGE_URL, token, "{}");
  log(`Period-usage status ${periodRes.status}`);
  if (periodRes.status >= 200 && periodRes.status < 300) {
    const periodData = parseJsonBody<PeriodUsageResponse>(
      periodRes.body,
      "period-usage"
    );
    log(`Period-usage keys: ${Object.keys(periodData).join(", ") || "(none)"}`);
    const fromPeriod = planUsageFromPeriod(periodData);
    if (fromPeriod) {
      return attachDailySpend(token, fromPeriod);
    }
    log(
      "No planUsage in period-usage (common for Enterprise); trying usage-summary…"
    );
  } else {
    log(
      `Period-usage failed (${periodRes.status}); trying usage-summary… ${periodRes.body.slice(0, 200)}`
    );
  }

  log(`Fetching ${USAGE_SUMMARY_URL}…`);
  const summaryRes = await cursorApiRequest("GET", USAGE_SUMMARY_URL, token);
  log(`Usage-summary status ${summaryRes.status}`);
  if (summaryRes.status < 200 || summaryRes.status >= 300) {
    throw new Error(
      `usage-summary returned ${summaryRes.status}: ${summaryRes.statusText}` +
        (summaryRes.body ? ` — ${summaryRes.body.slice(0, 200)}` : "")
    );
  }

  const summaryData = parseJsonBody<UsageSummaryResponse>(
    summaryRes.body,
    "usage-summary"
  );
  log(`Usage-summary snippet: ${summaryRes.body.slice(0, 400)}`);
  try {
    const team = summaryData.teamUsage ?? {};
    log(
      `usage-summary teamUsage keys: ${Object.keys(team).join(", ") || "(none)"}; ` +
        `pooled=${JSON.stringify((team as { pooled?: unknown }).pooled ?? null)}; ` +
        `onDemand=${JSON.stringify((team as { onDemand?: unknown }).onDemand ?? null)}`
    );
  } catch {
    /* ignore */
  }
  const fromSummary = planUsageFromSummary(summaryData);
  if (!fromSummary) {
    throw new Error(
      "No usage data in period-usage or usage-summary for this account."
    );
  }
  return attachDailySpend(token, fromSummary);
}

function fetchAndUpdateStatusBar(): Promise<void> {
  if (refreshInFlight) {
    log("Refresh already in progress; skipping duplicate request.");
    return refreshInFlight;
  }
  refreshInFlight = doFetchAndUpdateStatusBar().finally(() => {
    refreshInFlight = undefined;
  });
  return refreshInFlight;
}

async function doFetchAndUpdateStatusBar(): Promise<void> {
  const arcKey = await getArcApiKey();
  const cookie = await getSessionCookie();

  if (!arcKey && !cookie) {
    log("No Arc API key, Cursor sign-in, or pasted session cookie available.");
    latestUsage = undefined;
    setStatusBarNoToken(
      statusBarItem,
      "$(credit-card) Spend: —",
      "Sign in to Cursor, or set up your Arc API key. Click to set up."
    );
    statusBarItem.show();
    return;
  }

  if (cookie?.origin === "pasted" && !cookie.token.includes("::")) {
    log(
      "Session token does not contain '::' (expected userId::accessToken). Cookie fallback may fail auth."
    );
  }

  statusBarItem.text = arcKey
    ? "$(sync~spin) Asking Arc..."
    : "$(sync~spin) Refreshing...";
  statusBarItem.tooltip = arcKey
    ? "Running Cursor Insights task in Arc (can take ~30s)…"
    : "Fetching usage…";
  clearStatusBarColors(statusBarItem);
  statusBarItem.show();

  try {
    const planUsage = await resolveUsagePrimaryThenFallback();
    latestUsage = planUsage;
    setStatusBarUsage(statusBarItem, planUsage);
    log(`Usage updated from ${planUsage.source}.`);
    statusBarItem.show();
  } catch (err) {
    latestUsage = undefined;
    const message =
      err instanceof Error
        ? err.name === "TimeoutError" || err.name === "AbortError"
          ? `Request timed out after ${FETCH_TIMEOUT_MS / 1000}s. Check network/proxy or credentials.`
          : err.message
        : String(err);
    log(`Fetch failed: ${message}`);
    setStatusBarError(
      statusBarItem,
      "$(credit-card) Spend: $(error)",
      `Failed to fetch usage: ${message}`
    );
    statusBarItem.show();
  }
}

function formatCentsAsUsd(cents: number): string {
  return (cents / 100).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function formatUsdFromCents(cents: number): string {
  return `$${formatCentsAsUsd(cents)}`;
}

function parseCycleDate(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** Days elapsed in the billing cycle so far (at least 1). */
function daysElapsedInCycle(usage: PlanUsage): number {
  const startMs = parseCycleDate(usage.billingCycleStart);
  if (startMs === undefined) {
    return 1;
  }
  const endMs = parseCycleDate(usage.billingCycleEnd);
  const now = Date.now();
  const until = endMs !== undefined ? Math.min(now, endMs) : now;
  const days = Math.ceil((until - startMs) / 86_400_000);
  return Math.max(1, days);
}

function averageDailySpendCents(usage: PlanUsage): number | undefined {
  const spend = usage.leftUsed ?? usage.totalSpend;
  if (typeof spend !== "number") {
    return undefined;
  }
  return spend / daysElapsedInCycle(usage);
}

function spendBudgetText(usage: PlanUsage): string | undefined {
  const spendCents = usage.leftUsed ?? usage.totalSpend;
  const budgetCents = usage.leftLimit ?? usage.includedSpend ?? usage.limit;
  if (typeof spendCents === "number" && typeof budgetCents === "number") {
    return `$(credit-card) ${formatUsdFromCents(spendCents)} / ${formatUsdFromCents(budgetCents)}`;
  }
  if (typeof spendCents === "number") {
    return `$(credit-card) ${formatUsdFromCents(spendCents)} used`;
  }
  return undefined;
}

function dailySpendText(usage: PlanUsage): string | undefined {
  if (typeof usage.dailySpendCents === "number") {
    return `$(calendar) ${formatUsdFromCents(usage.dailySpendCents)} today`;
  }
  const avg = averageDailySpendCents(usage);
  if (avg === undefined) {
    return undefined;
  }
  return `$(calendar) ${formatUsdFromCents(avg)}/day avg`;
}

function getWarnPercent(): number {
  return vscode.workspace
    .getConfiguration("cursorSpending")
    .get<number>("warnPercent", 85);
}

function getIncreaseLimitUrl(): string {
  const configured = vscode.workspace
    .getConfiguration("cursorSpending")
    .get<string>("increaseLimitUrl", "")
    .trim();
  if (configured && isAllowedExternalUrl(configured)) {
    return configured;
  }
  return DASHBOARD_URL;
}

function budgetPercentUsed(usage: PlanUsage): number | undefined {
  const spendCents = usage.leftUsed ?? usage.totalSpend;
  const budgetCents = usage.leftLimit ?? usage.includedSpend ?? usage.limit;
  if (
    typeof spendCents !== "number" ||
    typeof budgetCents !== "number" ||
    budgetCents <= 0
  ) {
    return undefined;
  }
  return (spendCents / budgetCents) * 100;
}

function isBudgetWarningActive(usage: PlanUsage): boolean {
  const pct = budgetPercentUsed(usage);
  return pct !== undefined && pct >= getWarnPercent();
}

function budgetWarningText(usage: PlanUsage): string | undefined {
  const pct = budgetPercentUsed(usage);
  if (pct === undefined || pct < getWarnPercent()) {
    return undefined;
  }
  if (pct >= 100) {
    return "$(warning) Budget reached — request increase";
  }
  return `$(warning) ${pct.toFixed(0)}% of budget — request increase`;
}

function nextStatusBarView(
  usage: PlanUsage,
  current: 0 | 1 | 2
): 0 | 1 | 2 {
  const hasDaily = !!dailySpendText(usage);
  const hasWarning = isBudgetWarningActive(usage);
  const order: Array<0 | 1 | 2> = [0];
  if (hasDaily) {
    order.push(1);
  }
  if (hasWarning) {
    order.push(2);
  }
  const idx = order.indexOf(current);
  return order[(idx >= 0 ? idx + 1 : 0) % order.length];
}

function clearStatusBarColors(item: vscode.StatusBarItem): void {
  item.color = undefined;
  item.backgroundColor = undefined;
}

function applyStatusBarAppearance(usage: PlanUsage, view: 0 | 1 | 2): void {
  const spendText = spendBudgetText(usage);
  const dailyText = dailySpendText(usage);
  const warningText = budgetWarningText(usage);

  if (view === 2 && warningText) {
    statusBarItem.text = warningText;
    const pct = budgetPercentUsed(usage) ?? 0;
    statusBarItem.color = undefined;
    statusBarItem.backgroundColor = new vscode.ThemeColor(
      pct >= 100
        ? "statusBarItem.errorBackground"
        : "statusBarItem.warningBackground"
    );
    return;
  }

  clearStatusBarColors(statusBarItem);
  if (view === 1 && dailyText) {
    statusBarItem.text = dailyText;
  } else if (spendText) {
    statusBarItem.text = spendText;
  } else if (dailyText) {
    statusBarItem.text = dailyText;
  } else {
    statusBarItem.text = "$(credit-card) Spend: —";
  }
}

/** Escape untrusted text so it cannot inject markdown links or command URIs. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|]/g, "\\$&");
}

function isAllowedExternalUrl(url: string): boolean {
  try {
    const uri = vscode.Uri.parse(url);
    if (uri.scheme !== "https") {
      return false;
    }
    const host = uri.authority.toLowerCase();
    return (
      host === "cursor.com" ||
      host.endsWith(".cursor.com") ||
      host === "arc.trimble.com"
    );
  } catch {
    return false;
  }
}

const PROGRESS_BAR_WIDTH = 24;
const PROGRESS_FILL = "█";
const PROGRESS_EMPTY = "░";

function progressBar(percent: number, width: number = PROGRESS_BAR_WIDTH): string {
  const filled = Math.min(width, Math.round((percent / 100) * width));
  const empty = width - filled;
  return PROGRESS_FILL.repeat(filled) + PROGRESS_EMPTY.repeat(empty);
}

function buildUsageTooltip(planUsage: PlanUsage): vscode.MarkdownString {
  const leftLabel = planUsage.leftLabel ?? "Auto";
  const rightLabel = planUsage.rightLabel ?? "API";
  const isCentsBuckets =
    planUsage.source === "usage-summary" || planUsage.source === "arc";
  const isArc = planUsage.source === "arc";

  const leftSpendCents = planUsage.leftUsed ?? planUsage.totalSpend;
  const leftBudgetCents = planUsage.leftLimit ?? planUsage.includedSpend ?? planUsage.limit;
  const leftPercentNum =
    typeof planUsage.autoPercentUsed === "number"
      ? planUsage.autoPercentUsed
      : typeof leftSpendCents === "number" &&
          typeof leftBudgetCents === "number" &&
          leftBudgetCents > 0
        ? (leftSpendCents / leftBudgetCents) * 100
        : 0;
  const rightPercentNum =
    typeof planUsage.apiPercentUsed === "number"
      ? planUsage.apiPercentUsed
      : typeof planUsage.rightUsed === "number" &&
          typeof planUsage.rightLimit === "number" &&
          planUsage.rightLimit > 0
        ? (planUsage.rightUsed / planUsage.rightLimit) * 100
        : 0;

  const leftHeading =
    typeof leftSpendCents === "number" && typeof leftBudgetCents === "number"
      ? `${leftLabel}: ${formatUsdFromCents(leftSpendCents)} / ${formatUsdFromCents(leftBudgetCents)} (${leftPercentNum.toFixed(1)}%)`
      : `${leftLabel}: ${leftPercentNum.toFixed(1)}%`;

  const rightHeading =
    typeof planUsage.rightUsed === "number" &&
    typeof planUsage.rightLimit === "number"
      ? `${rightLabel}: ${formatUsdFromCents(planUsage.rightUsed)} / ${formatUsdFromCents(planUsage.rightLimit)} (${rightPercentNum.toFixed(1)}%)`
      : `${rightLabel}: ${rightPercentNum.toFixed(1)}%`;

  const lines: string[] = [];

  if (isArc) {
    lines.push("**Source:** Arc · Cursor Insights skill");
  } else {
    lines.push(
      planUsage.cookieOrigin === "cursor-sign-in"
        ? "**Source:** Cursor sign-in (fallback)"
        : "**Source:** pasted session cookie (fallback)"
    );
    if (planUsage.arcFailure) {
      lines.push("");
      lines.push(`*Arc failed:* ${escapeMarkdown(planUsage.arcFailure)}`);
    }
  }
  lines.push("");

  if (planUsage.membershipType) {
    lines.push(`**Plan:** ${escapeMarkdown(planUsage.membershipType)}`);
    lines.push("");
  }

  lines.push(`### ${leftHeading}`);
  lines.push("");
  lines.push("```");
  lines.push(progressBar(leftPercentNum));
  lines.push("```");
  lines.push("");
  if (isCentsBuckets) {
    const remainingText =
      typeof planUsage.remaining === "number"
        ? ` ${formatUsdFromCents(planUsage.remaining)} remaining.`
        : "";
    lines.push(
      isArc
        ? `Month-to-date Dashboard Cost from Cursor Insights.${remainingText} May differ slightly from invoices.`
        : `Individual included spend.${remainingText}`
    );
  } else {
    lines.push(
      "Consumed by Auto and Composer models. Additional usage consumes API quota."
    );
  }

  const avgDaily = averageDailySpendCents(planUsage);
  if (typeof planUsage.dailySpendCents === "number") {
    lines.push("");
    lines.push(
      isArc
        ? `**Today:** ${formatUsdFromCents(planUsage.dailySpendCents)} (Cursor Insights usage events).`
        : `**Today:** ${formatUsdFromCents(planUsage.dailySpendCents)} (from [Usage dashboard](${DASHBOARD_URL})).`
    );
  } else if (avgDaily !== undefined) {
    lines.push("");
    lines.push(
      `**Avg daily:** ${formatUsdFromCents(avgDaily)}/day over ${daysElapsedInCycle(planUsage)} day(s) in this billing cycle.`
    );
  }
  lines.push("");

  if (!isArc) {
    lines.push(`### ${rightHeading}`);
    lines.push("");
    lines.push("```");
    lines.push(progressBar(rightPercentNum));
    lines.push("```");
    lines.push("");
  }
  if (isArc) {
    // Cursor Insights exposes no separate on-demand bucket.
  } else if (isCentsBuckets) {
    lines.push(
      planUsage.rightKind === "pooled"
        ? "Team pooled spend (org included usage)."
        : "Team on-demand spend."
    );
    if (
      planUsage.secondaryRightKind &&
      typeof planUsage.secondaryRightUsed === "number" &&
      typeof planUsage.secondaryRightLimit === "number"
    ) {
      const secPct = percentUsed(
        planUsage.secondaryRightUsed,
        planUsage.secondaryRightLimit
      );
      const secLabel =
        planUsage.secondaryRightKind === "pooled" ? "Team pooled" : "Team on-demand";
      const secHeading = `${secLabel}: ${formatUsdFromCents(planUsage.secondaryRightUsed)} / ${formatUsdFromCents(planUsage.secondaryRightLimit)}${
        secPct !== undefined ? ` (${secPct.toFixed(1)}%)` : ""
      }`;
      lines.push("");
      lines.push(`### ${secHeading}`);
      lines.push("");
      lines.push("```");
      lines.push(progressBar(secPct ?? 0));
      lines.push("```");
      lines.push("");
      lines.push(
        planUsage.secondaryRightKind === "pooled"
          ? "Team pooled spend (org included usage)."
          : "Team on-demand spend."
      );
    }
  } else {
    const apiUsageUSD =
      typeof planUsage.limit === "number" ? planUsage.limit / 100 : null;
    lines.push(
      apiUsageUSD
        ? `Consumed by other models. Your plan includes at least $${apiUsageUSD.toFixed(2)} of API usage.`
        : "Consumed by other models."
    );
  }

  if (!isCentsBuckets) {
    const hasSpend =
      typeof planUsage.totalSpend === "number" ||
      typeof planUsage.includedSpend === "number" ||
      typeof planUsage.remaining === "number";
    if (hasSpend) {
      lines.push("");
      const parts: string[] = [];
      if (typeof planUsage.totalSpend === "number") {
        parts.push(`${formatUsdFromCents(planUsage.totalSpend)} used`);
      }
      if (typeof planUsage.includedSpend === "number") {
        parts.push(`${formatUsdFromCents(planUsage.includedSpend)} included`);
      }
      if (typeof planUsage.remaining === "number") {
        parts.push(`${formatUsdFromCents(planUsage.remaining)} remaining`);
      }
      lines.push("Spend: " + parts.join(", ") + ".");
    }
  }

  if (planUsage.bonusTooltip && planUsage.bonusTooltip.trim()) {
    lines.push("");
    lines.push(`*${escapeMarkdown(planUsage.bonusTooltip.trim())}*`);
  }

  if (isBudgetWarningActive(planUsage)) {
    const pct = budgetPercentUsed(planUsage) ?? 0;
    lines.push("");
    lines.push(
      pct >= 100
        ? "**Budget reached** — request a limit increase."
        : `**Budget warning:** ${pct.toFixed(0)}% of limit — request a limit increase.`
    );
    const increaseUrl = getIncreaseLimitUrl();
    if (isAllowedExternalUrl(increaseUrl)) {
      lines.push(`[Request limit increase](${increaseUrl})`);
    }
  }

  lines.push("");
  lines.push("[Refresh now](command:cursorSpending.refresh)");

  const md = new vscode.MarkdownString(lines.join("\n"));
  md.supportHtml = false;
  // Trusted only for the hardcoded Refresh command link; API text is escaped above.
  md.isTrusted = true;
  return md;
}

function setStatusBarUsage(
  item: vscode.StatusBarItem,
  planUsage: PlanUsage
): void {
  latestUsage = planUsage;
  if (statusBarView === 2 && !isBudgetWarningActive(planUsage)) {
    statusBarView = 0;
  }
  applyStatusBarAppearance(planUsage, statusBarView);
  item.tooltip = buildUsageTooltip(planUsage);
  item.command =
    statusBarView === 2 && isBudgetWarningActive(planUsage)
      ? {
          title: "Request limit increase",
          command: "vscode.open",
          arguments: [vscode.Uri.parse(getIncreaseLimitUrl())],
        }
      : {
          title: "Open Cursor Dashboard",
          command: "vscode.open",
          arguments: [vscode.Uri.parse(DASHBOARD_URL)],
        };
}

function setStatusBarNoToken(
  item: vscode.StatusBarItem,
  displayText: string,
  tooltip: string
): void {
  item.text = displayText;
  item.tooltip = tooltip;
  clearStatusBarColors(item);
  item.command = {
    title: "Set up Arc API key",
    command: "cursorSpending.openArcSetup",
  };
}

function setStatusBarError(
  item: vscode.StatusBarItem,
  text: string,
  tooltip: string
): void {
  item.text = text;
  item.tooltip = tooltip;
  item.color = undefined;
  item.backgroundColor = new vscode.ThemeColor("statusBarItem.errorBackground");
  item.command = {
    title: "Open Cursor Dashboard",
    command: "vscode.open",
    arguments: [vscode.Uri.parse(DASHBOARD_URL)],
  };
}

function openTokenSetupPanel(context: vscode.ExtensionContext): void {
  const panel = vscode.window.createWebviewPanel(
    "cursorSpendingTokenSetup",
    "Cursor Spending – Session Token",
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  const dashboardLink = DASHBOARD_URL;
  const nonce = getNonce();

  panel.webview.html = getTokenSetupWebviewContent(dashboardLink, nonce);

  panel.webview.onDidReceiveMessage(
    async (message: { type: string; token?: string; url?: string }) => {
      if (message.type === "save" && typeof message.token === "string") {
        const trimmed = message.token.trim();
        if (!trimmed) {
          return;
        }
        await storeSessionToken(trimmed);
        // Clear any leftover plaintext setting from older versions.
        await vscode.workspace
          .getConfiguration("cursorSpending")
          .update(
            LEGACY_SESSION_TOKEN_SETTING,
            undefined,
            vscode.ConfigurationTarget.Global
          );
        panel.dispose();
        vscode.window.showInformationMessage(
          "Cursor Spending: Session token saved. Fetching usage…"
        );
        void fetchAndUpdateStatusBar();
      } else if (message.type === "openLink" && typeof message.url === "string") {
        if (!isAllowedExternalUrl(message.url)) {
          return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(message.url));
      }
    }
  );
}

function openArcSetupPanel(context: vscode.ExtensionContext): void {
  const panel = vscode.window.createWebviewPanel(
    "cursorSpendingArcSetup",
    "Cursor Spending – Arc API Key",
    vscode.ViewColumn.One,
    { enableScripts: true }
  );

  const keysLink = ARC_SETTINGS_URL;
  const nonce = getNonce();
  const existingEmail = getLookupEmail();

  panel.webview.html = getArcSetupWebviewContent(
    keysLink,
    nonce,
    existingEmail
  );

  panel.webview.onDidReceiveMessage(
    async (message: {
      type: string;
      apiKey?: string;
      email?: string;
      url?: string;
    }) => {
      if (message.type === "save") {
        const apiKey =
          typeof message.apiKey === "string" ? message.apiKey.trim() : "";
        const email =
          typeof message.email === "string" ? message.email.trim() : "";
        if (!apiKey || !email) {
          return;
        }
        await storeArcApiKey(apiKey);
        await extensionContext.globalState.update(ARC_SKILL_ID_STATE_KEY, undefined);
        await clearArcPause();
        await vscode.workspace
          .getConfiguration("cursorSpending")
          .update("lookupEmail", email, vscode.ConfigurationTarget.Global);
        panel.dispose();
        vscode.window.showInformationMessage(
          "Cursor Spending: Arc API key saved. Fetching usage via Arc (can take ~30s)…"
        );
        void fetchAndUpdateStatusBar();
      } else if (message.type === "openLink" && typeof message.url === "string") {
        if (!isAllowedExternalUrl(message.url)) {
          return;
        }
        await vscode.env.openExternal(vscode.Uri.parse(message.url));
      }
    }
  );
}

function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

function getTokenSetupWebviewContent(dashboardLink: string, nonce: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cursor Spending – Session Token</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 1rem 1.5rem;
      box-sizing: border-box;
    }
    p {
      margin: 0 0 1rem 0;
      line-height: 1.5;
    }
    label {
      display: block;
      margin-bottom: 0.25rem;
      font-weight: 500;
    }
    input[type="password"] {
      width: 100%;
      padding: 0.5rem;
      margin-bottom: 1rem;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: inherit;
      font-size: inherit;
      box-sizing: border-box;
    }
    input[type="password"]:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }
    a {
      color: var(--vscode-textLink-foreground);
    }
    a:hover {
      color: var(--vscode-textLink-activeForeground);
    }
    .button-row {
      margin-top: 1.25rem;
    }
    button {
      padding: 0.5rem 1rem;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      font-family: inherit;
      font-size: inherit;
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
  </style>
</head>
<body>
  <p><strong>Fallback only.</strong> Prefer an Arc API key (Cursor Spending: Set up Arc API key). Paste your <strong>WorkosCursorSessionToken</strong> cookie value below:</p>
  <ol style="margin: 0.5rem 0 1rem 1.25rem;">
    <li>Open the <a href="${dashboardLink}" id="dashboard-link">Cursor dashboard</a> and log in.</li>
    <li>Open DevTools (F12 or Cmd+Option+I) → Application → Cookies → cursor.com.</li>
    <li>Copy the value of <strong>WorkosCursorSessionToken</strong>.</li>
  </ol>
  <label for="token-input">Session token</label>
  <input type="password" id="token-input" placeholder="Paste token here..." autocomplete="off" />
  <div class="button-row">
    <button id="save-btn">Save</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const input = document.getElementById('token-input');
    const saveBtn = document.getElementById('save-btn');
    const dashboardLink = document.getElementById('dashboard-link');

    dashboardLink.addEventListener('click', function(e) {
      e.preventDefault();
      vscode.postMessage({ type: 'openLink', url: '${dashboardLink}' });
    });

    saveBtn.addEventListener('click', function() {
      const token = input.value.trim();
      if (token) {
        vscode.postMessage({ type: 'save', token: token });
      }
    });

    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') {
        saveBtn.click();
      }
    });
  </script>
</body>
</html>`;
}

function getArcSetupWebviewContent(
  keysLink: string,
  nonce: string,
  existingEmail: string
): string {
  const emailValue = existingEmail
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Cursor Spending – Arc API Key</title>
  <style>
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      padding: 1rem 1.5rem;
      box-sizing: border-box;
    }
    p { margin: 0 0 1rem 0; line-height: 1.5; }
    label { display: block; margin-bottom: 0.25rem; font-weight: 500; }
    input[type="password"], input[type="email"], input[type="text"] {
      width: 100%;
      padding: 0.5rem;
      margin-bottom: 1rem;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: inherit;
      font-size: inherit;
      box-sizing: border-box;
    }
    input:focus { outline: 1px solid var(--vscode-focusBorder); }
    a { color: var(--vscode-textLink-foreground); }
    button {
      padding: 0.5rem 1rem;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      font-family: inherit;
      font-size: inherit;
      cursor: pointer;
    }
    button:hover { background: var(--vscode-button-hoverBackground); }
  </style>
</head>
<body>
  <p><strong>Preferred.</strong> Paste your own <strong>Arc User API key</strong>. The extension asks Arc's Cursor Insights skill for your spend only. Your key is stored in the editor's secret storage.</p>
  <ol style="margin: 0.5rem 0 1rem 1.25rem;">
    <li>Open <a href="${keysLink}" id="keys-link">arc.trimble.com</a> and sign in with Trimble ID.</li>
    <li>Profile → <strong>Settings</strong> → <strong>API Keys</strong> → create a key of type <strong>User</strong> (not Application). Copy it once.</li>
    <li>Make sure the <strong>Cursor Insights</strong> skill is enabled for your account.</li>
    <li>Enter your full Cursor account email (must match the Cursor dashboard).</li>
  </ol>
  <label for="email-input">Cursor account email</label>
  <input type="email" id="email-input" value="${emailValue}" placeholder="you@trimble.com" autocomplete="off" />
  <label for="key-input">Arc User API key</label>
  <input type="password" id="key-input" placeholder="arc_sk_…" autocomplete="off" />
  <div>
    <button id="save-btn">Save</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const emailInput = document.getElementById('email-input');
    const keyInput = document.getElementById('key-input');
    const saveBtn = document.getElementById('save-btn');
    const keysLink = document.getElementById('keys-link');

    keysLink.addEventListener('click', function(e) {
      e.preventDefault();
      vscode.postMessage({ type: 'openLink', url: '${keysLink}' });
    });

    function save() {
      const apiKey = keyInput.value.trim();
      const email = emailInput.value.trim();
      if (apiKey && email) {
        vscode.postMessage({ type: 'save', apiKey: apiKey, email: email });
      }
    }

    saveBtn.addEventListener('click', save);
    keyInput.addEventListener('keydown', function(e) {
      if (e.key === 'Enter') save();
    });
  </script>
</body>
</html>`;
}

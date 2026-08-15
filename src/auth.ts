import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
interface Auth {
  token?: string;
  apiKey?: string;
  credsPath?: string;
}

const TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";

interface Creds {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number | null;
}

function cfgDir() {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

function user() {
  try { return process.env.USER || userInfo().username; }
  catch { return "claude-code-user"; }
}

function keychainService() {
  const d = cfgDir();
  // non-default config dirs get a hash suffix to avoid colliding with the default entry
  const h = process.env.CLAUDE_CONFIG_DIR
    ? `-${createHash("sha256").update(d).digest("hex").substring(0, 8)}`
    : "";
  return `Claude Code-credentials${h}`;
}

function fromKeychain(): Creds | null {
  if (process.platform !== "darwin") return null;
  try {
    const r = execFileSync(
      "security",
      ["find-generic-password", "-a", user(), "-w", "-s", keychainService()],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] },
    );
    const d = JSON.parse(r.trim());
    return d?.claudeAiOauth?.accessToken ? d.claudeAiOauth : null;
  } catch { return null; }
}

function fromFile(path?: string): Creds | null {
  try {
    const d = JSON.parse(readFileSync(path ?? join(cfgDir(), ".credentials.json"), "utf-8"));
    return d?.claudeAiOauth?.accessToken ? d.claudeAiOauth : null;
  } catch { return null; }
}

export function readCreds(path?: string): Creds | null {
  return fromKeychain() ?? fromFile(path);
}

function expired(c: Creds): boolean {
  if (!c.expiresAt) return false;
  // CC stores expiresAt in ms sometimes, seconds other times
  const s = c.expiresAt > 1e12 ? c.expiresAt / 1000 : c.expiresAt;
  return Date.now() / 1000 > s - 60;
}

async function doRefresh(rt: string): Promise<Creds> {
  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: rt, client_id: CLIENT_ID }).toString(),
  });
  if (!r.ok) throw new Error(`refresh failed: ${r.status}`);
  const d = await r.json() as { access_token: string; refresh_token?: string; expires_in?: number };
  return {
    accessToken: d.access_token,
    refreshToken: d.refresh_token ?? rt,
    expiresAt: d.expires_in ? Math.floor(Date.now() / 1000) + d.expires_in : null,
  };
}

export class AuthProvider {
  private creds: Creds | null = null;
  private apiKey: string | undefined;
  private path: string | undefined;
  private pending: Promise<boolean> | null = null;

  constructor(cfg: Auth = {}) {
    this.apiKey = cfg.apiKey ?? process.env.ANTHROPIC_API_KEY;
    this.path = cfg.credsPath;
    if (cfg.token) this.creds = { accessToken: cfg.token };
    else if (process.env.CLAUDE_CODE_OAUTH_TOKEN) this.creds = { accessToken: process.env.CLAUDE_CODE_OAUTH_TOKEN };
  }

  get oauth(): boolean { return this.getCreds() !== null; }

  getCreds(): Creds | null {
    if (this.creds) return this.creds;
    this.creds = readCreds(this.path);
    return this.creds;
  }

  private reread(): Creds | null {
    this.creds = null;
    return this.getCreds();
  }

  async refresh(): Promise<void> {
    if (this.pending) { await this.pending; return; }
    const c = this.getCreds();
    if (!c || !expired(c) || !c.refreshToken) return;
    this.pending = doRefresh(c.refreshToken).then(n => { this.creds = n; return true; }).catch(() => false).finally(() => { this.pending = null; });
    await this.pending;
  }

  async onAuthError(failed: string): Promise<boolean> {
    // re-read from keychain — another CC instance may have already refreshed
    const c = this.reread();
    if (!c?.refreshToken) return false;
    if (c.accessToken !== failed) return true;
    try { this.creds = await doRefresh(c.refreshToken); return true; }
    catch { return false; }
  }

  async token(): Promise<string | null> {
    await this.refresh();
    return this.getCreds()?.accessToken ?? null;
  }

  key(): string | undefined { return this.apiKey; }
}

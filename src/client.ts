import Anthropic from "@anthropic-ai/sdk";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AuthProvider } from "./auth.js";

export type Msg = Anthropic.Messages.MessageParam;
export type Tool = Anthropic.Messages.Tool;
export type Response = Anthropic.Messages.Message;
export type StreamEvent = Anthropic.Messages.RawMessageStreamEvent;

export interface Opts {
  auth?: { token?: string; apiKey?: string; credsPath?: string };
  model?: string;
  maxRetries?: number;
  baseURL?: string;
  betas?: string[];
  // Match the interactive `claude` entrypoint by default. Set false for `--print`/sdk-cli.
  interactive?: boolean;
}

export interface Send {
  model?: string;
  system?: string | Anthropic.Messages.TextBlockParam[];
  messages: Msg[];
  maxTokens?: number;
  thinking?: boolean | "adaptive" | { type: "enabled"; budget_tokens: number };
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  tools?: Tool[];
  toolChoice?: Anthropic.Messages.ToolChoice;
  temperature?: number;
  stop?: string[];
  speed?: "fast";
  ctx1m?: boolean;
  redact?: boolean;
  cache?: boolean;
  betas?: string[];
  signal?: AbortSignal;
  timeout?: number;
}

// Keep these values aligned with the installed Claude Code binary.
const VER = "2.1.261";
const B = {
  cc: "claude-code-20250219",     oauth: "oauth-2025-04-20",
  isp: "interleaved-thinking-2025-05-14", redact: "redact-thinking-2026-02-12",
  ttc: "thinking-token-count-2026-05-13", ctx: "context-management-2025-06-27",
  cache: "prompt-caching-scope-2026-01-05", midSys: "mid-conversation-system-2026-04-07",
  advisor: "advisor-tool-2026-03-01", effort: "effort-2025-11-24",
  extTtl: "extended-cache-ttl-2025-04-11",
  fast: "fast-mode-2026-02-01",   ctx1m: "context-1m-2025-08-07",
} as const;

interface CcConfig {
  userID?: string;
  oauthAccount?: { accountUuid?: string };
}

function readCcConfig(): CcConfig {
  const customDir = process.env.CLAUDE_CONFIG_DIR;
  const paths = [
    ...(customDir ? [join(customDir, ".claude.json")] : []),
    join(homedir(), ".claude.json"),
  ];
  for (const path of [...new Set(paths)]) {
    try {
      const value: unknown = JSON.parse(readFileSync(path, "utf-8"));
      if (value && typeof value === "object") return value as CcConfig;
    } catch { /* try the next Claude Code state location */ }
  }
  return {};
}

// CC reads ANTHROPIC_CUSTOM_HEADERS as "key:val,key:val"
function envHeaders(): Record<string, string> {
  const raw = process.env.ANTHROPIC_CUSTOM_HEADERS;
  if (!raw) return {};
  const h: Record<string, string> = {};
  for (const p of raw.split(",")) { const i = p.indexOf(":"); if (i > 0) h[p.slice(0, i).trim()] = p.slice(i + 1).trim(); }
  return h;
}

// CC adds a one-hour ephemeral cache breakpoint to system + last user content.
const EPHEMERAL = { type: "ephemeral" as const, ttl: "1h" as const };

function cacheSystem(sys: any) {
  if (!sys) return undefined;
  if (typeof sys === "string") return [{ type: "text", text: sys, cache_control: EPHEMERAL }];
  const a = [...sys];
  if (a.length) a[a.length - 1] = { ...a[a.length - 1], cache_control: EPHEMERAL };
  return a;
}

function cacheLastUser(msgs: Msg[]): Msg[] {
  const out = [...msgs];
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== "user") continue;
    const m = out[i];
    if (typeof m.content === "string") {
      out[i] = { role: "user", content: [{ type: "text", text: m.content, cache_control: EPHEMERAL }] } as any;
    } else if (Array.isArray(m.content) && m.content.length) {
      const c = [...m.content];
      c[c.length - 1] = { ...c[c.length - 1], cache_control: EPHEMERAL } as any;
      out[i] = { role: "user", content: c };
    }
    break;
  }
  return out;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const block = content.find(
    (candidate): candidate is { type: "text"; text?: string } =>
      Boolean(candidate && typeof candidate === "object" && (candidate as any).type === "text"),
  );
  return typeof block?.text === "string" ? block.text : "";
}

// The binary derives a short billing suffix from the first non-meta user text.
function firstUserText(msgs: Msg[]): string {
  const candidate = msgs.find(message => {
    const value = message as Msg & { isMeta?: boolean };
    return value.role === "user" && value.isMeta !== true;
  });
  return candidate ? contentText(candidate.content) : "";
}

function billingSuffix(messages: Msg[]): string {
  const prompt = firstUserText(messages);
  const selected = [4, 7, 20].map(index => prompt[index] || "0").join("");
  return createHash("sha256")
    .update(`59cf53e54c78${selected}${VER}`)
    .digest("hex")
    .slice(0, 3);
}

function systemBlocks(sys: string | Anthropic.Messages.TextBlockParam[]): any[] {
  return typeof sys === "string" ? [{ type: "text", text: sys }] : [...sys];
}

function resolveThinking(t: Send["thinking"], interactive: boolean): { on: boolean; param: any } {
  if (!t) return { on: false, param: undefined };
  if (t === true || t === "adaptive") {
    return { on: true, param: { type: "adaptive", ...(interactive ? {} : { display: "omitted" }) } };
  }
  return { on: true, param: t };
}

let generatedDeviceId: string | undefined;

function deviceId(config: CcConfig): string {
  if (typeof config.userID === "string" && /^[0-9a-f]{64}$/i.test(config.userID)) return config.userID;
  return generatedDeviceId ??= randomBytes(32).toString("hex");
}

export class Claude {
  private auth: AuthProvider;
  private model: string;
  private xbetas: string[];
  private retries: number;
  private base: string | undefined;
  private sid = randomUUID();
  private did: string;
  private ccCfg: CcConfig;
  private interactive: boolean;

  constructor(o: Opts = {}) {
    this.auth = new AuthProvider(o.auth ?? {});
    this.model = o.model ?? "claude-sonnet-5";
    this.xbetas = o.betas ?? [];
    this.retries = o.maxRetries ?? 2;
    this.base = o.baseURL;
    this.interactive = o.interactive ?? true;
    this.ccCfg = readCcConfig();
    this.did = deviceId(this.ccCfg);
  }

  // CC sends metadata.user_id as JSON with device/account/session for rate limit routing
  private meta() {
    return { user_id: JSON.stringify({ device_id: this.did, account_uuid: this.ccCfg.oauthAccount?.accountUuid ?? "", session_id: this.sid }) };
  }

  private betas(o: Send, think: boolean) {
    const b: string[] = [B.cc];
    if (this.auth.oauth) b.push(B.oauth);
    if (think) {
      b.push(B.isp);
      // Interactive CC sends this beta by default; sdk-cli only does so when requested.
      if (o.redact ?? this.interactive) b.push(B.redact);
      b.push(B.ttc);
    }
    b.push(B.ctx, B.cache, B.midSys, B.advisor, B.effort, B.extTtl);
    if (o.ctx1m) b.push(B.ctx1m);
    if (o.speed === "fast") b.push(B.fast);
    for (const x of [...this.xbetas, ...(o.betas ?? [])]) if (!b.includes(x)) b.push(x);
    return b;
  }

  private params(o: Send, stream = false) {
    const { on: think, param: thinkParam } = resolveThinking(o.thinking, this.interactive);
    const useCache = o.cache !== false;
    const oc: Record<string, unknown> = {};
    if (o.effort) oc.effort = o.effort;

    return {
      model: o.model ?? this.model,
      messages: useCache ? cacheLastUser(o.messages) : o.messages,
      max_tokens: o.maxTokens ?? (think ? 64000 : 16000),
      metadata: this.meta(),
      betas: this.betas(o, think),
      stream,
      ...(this.auth.oauth ? { system: this.firstPartySystem(o, useCache) } :
        o.system !== undefined ? { system: useCache ? cacheSystem(o.system) : o.system } : {}),
      ...(o.tools && { tools: o.tools }),
      ...(o.toolChoice && { tool_choice: o.toolChoice }),
      ...(o.stop && { stop_sequences: o.stop }),
      // API rejects temperature != 1 when thinking is on
      ...(!think && { temperature: o.temperature ?? 1 }),
      ...(think && { thinking: thinkParam }),
      ...(think && { context_management: { edits: [{ type: "clear_thinking_20251015", keep: "all" }] } }),
      ...(Object.keys(oc).length && { output_config: oc }),
      ...(o.speed && { speed: o.speed }),
    };
  }

  private firstPartySystem(o: Send, useCache: boolean): any[] {
    const entrypoint = process.env.CLAUDE_CODE_ENTRYPOINT ?? (this.interactive ? "cli" : "sdk-cli");
    const blocks: any[] = [
      {
        type: "text",
        text: `x-anthropic-billing-header: cc_version=${VER}.${billingSuffix(o.messages)}; cc_entrypoint=${entrypoint};`,
      },
      {
        type: "text",
        text: this.interactive
          ? "You are Claude Code, Anthropic's official CLI for Claude."
          : "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
        ...(useCache ? { cache_control: EPHEMERAL } : {}),
      },
    ];
    if (o.system !== undefined) {
      const supplied = systemBlocks(o.system);
      if (useCache && supplied.length) {
        supplied[supplied.length - 1] = { ...supplied[supplied.length - 1], cache_control: EPHEMERAL };
      }
      blocks.push(...supplied);
    }
    return blocks;
  }

  // new Anthropic client per request — auth token may change between calls
  private async sdk(timeout: number): Promise<Anthropic> {
    await this.auth.refresh();
    const h: Record<string, string> = {
      "x-app": "cli",
      "User-Agent": `claude-cli/${VER} (external, ${this.interactive ? "cli" : "sdk-cli"})`,
      "X-Claude-Code-Session-Id": this.sid,
      ...(this.auth.oauth ? { "anthropic-dangerous-direct-browser-access": "true" } : {}),
      ...envHeaders(),
    };
    const c: ConstructorParameters<typeof Anthropic>[0] = {
      maxRetries: this.retries,
      timeout,
      defaultHeaders: h,
    };
    if (this.base) c.baseURL = this.base;
    if (this.auth.oauth) {
      const t = await this.auth.token();
      if (!t) throw new Error(
        "OAuth token not found. Run `claude /login` first, or pass auth.token directly.",
      );
      c.apiKey = null; c.authToken = t;
    } else {
      const k = this.auth.key();
      if (!k) throw new Error(
        "No authentication found. Either:\n" +
        "  1. Run `claude /login` to set up OAuth\n" +
        "  2. Set ANTHROPIC_API_KEY environment variable\n" +
        "  3. Pass auth: { apiKey: '...' } to constructor",
      );
      c.apiKey = k;
    }
    return new Anthropic(c);
  }

  private norm(o: string | Send): Send {
    return typeof o === "string" ? { messages: [{ role: "user", content: o }] } : o;
  }

  private reqOpts(o: Send, stream: boolean) {
    return {
      ...(o.signal && { signal: o.signal }),
      timeout: o.timeout ?? (stream ? 600_000 : 300_000),
    };
  }

  async send(o: string | Send): Promise<Response> {
    const s = this.norm(o);
    // capture token before request — if 401, re-read from keychain (another CC may have refreshed)
    let failed: string | undefined;
    try {
      failed = (await this.auth.token()) ?? undefined;
      const c = await this.sdk(s.timeout ?? 300_000);
      return await c.beta.messages.create(this.params(s) as any, this.reqOpts(s, false)) as Response;
    } catch (e: any) {
      if (e.status === 401 && this.auth.oauth && failed && await this.auth.onAuthError(failed)) {
        const c = await this.sdk(s.timeout ?? 300_000);
        return await c.beta.messages.create(this.params(s) as any, this.reqOpts(s, false)) as Response;
      }
      throw e;
    }
  }

  async ask(o: string | Send): Promise<string> {
    const r = await this.send(o);
    return r.content.filter((b): b is Anthropic.Messages.TextBlock => b.type === "text").map(b => b.text).join("");
  }

  async *stream(o: string | Send): AsyncGenerator<StreamEvent> {
    const s = this.norm(o);
    let failed: string | undefined;
    try {
      failed = (await this.auth.token()) ?? undefined;
      const c = await this.sdk(s.timeout ?? 600_000);
      const st = c.beta.messages.stream(this.params(s, true) as any, this.reqOpts(s, true));
      for await (const e of st) yield e as unknown as StreamEvent;
    } catch (e: any) {
      if (e.status === 401 && this.auth.oauth && failed && await this.auth.onAuthError(failed)) {
        const c = await this.sdk(s.timeout ?? 600_000);
        const st = c.beta.messages.stream(this.params(s, true) as any, this.reqOpts(s, true));
        for await (const e2 of st) yield e2 as unknown as StreamEvent;
        return;
      }
      throw e;
    }
  }

  async *streamText(o: string | Send): AsyncGenerator<string> {
    for await (const e of this.stream(o)) {
      if (e.type === "content_block_delta" && "delta" in e && (e.delta as any).type === "text_delta") {
        yield (e.delta as any).text;
      }
    }
  }
}

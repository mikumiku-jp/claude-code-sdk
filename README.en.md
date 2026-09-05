# claude-cc-sdk

[![npm](https://img.shields.io/npm/v/claude-cc-sdk)](https://www.npmjs.com/package/claude-cc-sdk)
[![license](https://img.shields.io/npm/l/claude-cc-sdk)](LICENSE)

An SDK that talks to the Claude API using Claude Code's subscription auth.

If you're logged in to Claude Code, it works without an API key.
System prompts, thinking, effort, tools, streaming — all under your control.

## Why this exists

Claude Code subscriptions (Pro/Max/Team) use OAuth and send specific headers and metadata with every request.
Without those, the same OAuth token hits rate limits or loses access to certain features.

This SDK reproduces the request format of the official Claude Code binary's interactive `cli` path by default.
Set `interactive: false` to use the non-interactive `sdk-cli` (`--print`) path.
Auth credentials are read automatically from the macOS Keychain or `~/.claude/.credentials.json`.

There's another reason this SDK is useful.
The interactive Claude Code path returns native thinking as `redacted_thinking` — encrypted, unreadable.
This SDK also targets the interactive path by default, so `redact` defaults to `true`.
Set `redact: false` to omit the `redact-thinking` beta header and expose the thinking content in plain text.

## Install

```bash
npm install claude-cc-sdk
```

## Prerequisites

You need to be logged in to Claude Code.

```bash
claude /login
```

To use an API key instead, set the `ANTHROPIC_API_KEY` environment variable.

## Usage

### Get text

```ts
import { Claude } from "claude-cc-sdk";

const c = new Claude();

const answer = await c.ask("What is the capital of France?");
console.log(answer);
```

### Full response

```ts
const r = await c.send("What is 2+2?");
console.log(r.content);     // ContentBlock[]
console.log(r.usage);       // { input_tokens, output_tokens, ... }
console.log(r.stop_reason); // "end_turn" | "tool_use" | ...
```

`send` returns the raw Anthropic `Message` object.

### System prompt

With subscription auth, system prompts are limited to 5000 characters.

```ts
await c.send({
  system: "You are a helpful engineer. Be concise.",
  messages: [{ role: "user", content: "Hello" }],
});
```

### Options

```ts
const r = await c.send({
  system: "Be concise.",
  messages: [
    { role: "user", content: "What is quantum computing?" },
  ],
  thinking: true,          // adaptive thinking ON
  effort: "high",
  redact: false,           // omit the redact-thinking beta header
  maxTokens: 16000,
});

for (const b of r.content) {
  if (b.type === "thinking") console.log("[THINK]", (b as any).thinking);
  if (b.type === "text")     console.log("[OUT]", b.text);
}
```

### Streaming

```ts
// text only
for await (const chunk of c.streamText("Write a haiku")) {
  process.stdout.write(chunk);
}

// raw SSE events
for await (const event of c.stream("Write a haiku")) {
  console.log(event.type);
}
```

### Tools

```ts
const r = await c.send({
  messages: [{ role: "user", content: "Weather in Tokyo?" }],
  tools: [{
    name: "weather",
    description: "Get weather for a city",
    input_schema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  }],
});

for (const b of r.content) {
  if (b.type === "tool_use") {
    console.log(b.name, b.input); // "weather" { city: "Tokyo" }
  }
}
```

### Abort and timeout

```ts
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 5000);

const r = await c.send({
  messages: [{ role: "user", content: "Long task" }],
  signal: ctrl.signal,
  timeout: 10000,
});
```

## Constructor options

```ts
new Claude({
  model: "claude-sonnet-5",
  auth: {
    token: "...",               // direct OAuth token
    apiKey: "sk-ant-...",       // direct API key
    credsPath: "/path/to/creds" // custom credentials path
  },
  maxRetries: 2,
  baseURL: "https://...",
  betas: ["..."],               // additional beta headers
  interactive: true,             // interactive CC path (default; false = sdk-cli)
})
```

Auth priority:

1. `auth.token` or `CLAUDE_CODE_OAUTH_TOKEN` env var
2. macOS Keychain (Claude Code login session)
3. `~/.claude/.credentials.json`
4. `auth.apiKey` or `ANTHROPIC_API_KEY` env var

## Request options (`Send`)

| Option | Type | Description |
|--------|------|-------------|
| `model` | `string` | Model ID |
| `system` | `string \| TextBlockParam[]` | System prompt |
| `messages` | `MessageParam[]` | Message array |
| `maxTokens` | `number` | Max output tokens |
| `thinking` | `true \| "adaptive" \| {type:"enabled", budget_tokens}` | Native thinking |
| `effort` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | Output quality |
| `tools` | `Tool[]` | Tool definitions |
| `toolChoice` | `ToolChoice` | Tool selection |
| `temperature` | `number` | Sampling temperature |
| `stop` | `string[]` | Stop sequences |
| `speed` | `"fast"` | Fast mode |
| `ctx1m` | `boolean` | 1M context window |
| `redact` | `boolean` | Send the thinking-redaction beta (default: `true` in interactive mode) |
| `cache` | `boolean` | Prompt caching (default: `true`) |
| `signal` | `AbortSignal` | Cancellation |
| `timeout` | `number` | Timeout in ms |
| `betas` | `string[]` | Additional betas |

Pass a `string` as shorthand for `{ messages: [{ role: "user", content: "..." }] }`.

## Methods

| Method | Returns | Purpose |
|--------|---------|---------|
| `ask(o)` | `Promise<string>` | Get text |
| `send(o)` | `Promise<Response>` | Full response |
| `stream(o)` | `AsyncGenerator<StreamEvent>` | All SSE events |
| `streamText(o)` | `AsyncGenerator<string>` | Text chunks only |

## Raw thinking with `redact: false`

Claude Code encrypts thinking content into `redacted_thinking` blocks.
This behavior is controlled by the `redact-thinking` beta header included in requests.

Setting `redact: false` omits that header. With `interactive: false`, omitting `redact` also omits it.
The result: `thinking` blocks contain the raw reasoning text in plain text.

```ts
const r = await c.send({
  messages: [{ role: "user", content: "Factorize 15" }],
  thinking: { type: "enabled", budget_tokens: 5000 },
  redact: false,
  maxTokens: 8000,
});

for (const b of r.content) {
  if (b.type === "thinking") {
    console.log((b as any).thinking); // raw reasoning visible
  }
}
```

## License

GPL-3.0

## Disclaimer

This is an unofficial project created for educational and research purposes.
It is not affiliated with, endorsed by, or supported by Anthropic.
The author assumes no responsibility for any consequences arising from the use of this software.

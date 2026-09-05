# claude-cc-sdk

[![npm](https://img.shields.io/npm/v/claude-cc-sdk)](https://www.npmjs.com/package/claude-cc-sdk)
[![license](https://img.shields.io/npm/l/claude-cc-sdk)](LICENSE)

[English](README.en.md)

Claude Codeのサブスクリプション認証を使って、Claude APIを自由に叩くためのSDK。

Claude Codeでログイン済みなら、APIキー不要でそのまま動く。
システムプロンプト、thinking、effort、ツール、ストリーミングを全て制御できる。

## なぜこれが要るのか

Claude Codeのサブスクリプション（Pro/Max/Team）はOAuth認証を使い、リクエストごとに特定のヘッダとメタデータを送る。
これが欠けると、同じOAuthトークンでもレートリミットに当たったり、一部の機能が使えなかったりする。

このSDKは、Claude Code公式バイナリの対話型 `cli` 経路が送るリクエスト形式をデフォルトで再現する。
`interactive: false` を指定すると、非対話型 `sdk-cli`（`--print`）経路に切り替えられる。
認証情報はmacOSキーチェーン（または`~/.claude/.credentials.json`）から自動で読み取る。

もう一つの用途がある。
Claude Codeの対話型経路では、ネイティブthinkingは `redacted_thinking` として暗号化されて返る。
このSDKも対話型経路をデフォルトにしているため、`redact` のデフォルトは `true`。
`redact: false` を指定すると `redact-thinking` ベータヘッダを省略し、推論内容を平文で取得できる。

## インストール

```bash
npm install claude-cc-sdk
```

## 前提

Claude Codeでログイン済みであること。

```bash
claude /login
```

APIキーを使う場合は `ANTHROPIC_API_KEY` 環境変数を設定する。

## 使い方

### テキストを取得する

```ts
import { Claude } from "claude-cc-sdk";

const c = new Claude();

const answer = await c.ask("日本の首都は？");
console.log(answer);
```

`ask` は最も多い用途——質問してテキストだけ受け取る——を一行で書ける。

### レスポンス全体を扱う

```ts
const r = await c.send("2+2は？");
console.log(r.content);     // ContentBlock[]
console.log(r.usage);       // { input_tokens, output_tokens, ... }
console.log(r.stop_reason); // "end_turn" | "tool_use" | ...
```

`send` はAnthropicの `Message` オブジェクトをそのまま返す。
`content` の中身は `r.content.filter(b => b.type === "text")` のようにフィルタする。

### システムプロンプト

サブスクリプション認証では、システムプロンプトは5000文字までに制限されている。

```ts
await c.send({
  system: "あなたは優秀なエンジニアです。簡潔に回答してください。",
  messages: [{ role: "user", content: "Hello" }],
});
```

### オプションを渡す

```ts
const r = await c.send({
  system: "簡潔に回答してください。",
  messages: [
    { role: "user", content: "量子コンピュータとは何か" },
  ],
  thinking: true,          // adaptive thinking ON
  effort: "high",          // 出力品質レベル
  redact: false,           // redact-thinking ベータヘッダを送らない
  maxTokens: 16000,
});

for (const b of r.content) {
  if (b.type === "thinking") console.log("[思考]", (b as any).thinking);
  if (b.type === "text")     console.log("[回答]", b.text);
}
```

### ストリーミング

```ts
// テキストだけ
for await (const chunk of c.streamText("俳句を詠んで")) {
  process.stdout.write(chunk);
}

// 全イベント（message_start, content_block_delta, ...）
for await (const event of c.stream("俳句を詠んで")) {
  console.log(event.type);
}
```

### ツール

```ts
const r = await c.send({
  messages: [{ role: "user", content: "東京の天気は？" }],
  tools: [{
    name: "weather",
    description: "都市の天気を取得",
    input_schema: {
      type: "object",
      properties: { city: { type: "string" } },
      required: ["city"],
    },
  }],
});

for (const b of r.content) {
  if (b.type === "tool_use") {
    console.log(b.name, b.input); // "weather" { city: "東京" }
  }
}
```

### キャンセルとタイムアウト

```ts
const ctrl = new AbortController();
setTimeout(() => ctrl.abort(), 5000);

const r = await c.send({
  messages: [{ role: "user", content: "長い処理" }],
  signal: ctrl.signal,
  timeout: 10000,
});
```

## コンストラクタオプション

```ts
new Claude({
  model: "claude-sonnet-5",     // デフォルトモデル
  auth: {
    token: "...",               // OAuthトークン直指定
    apiKey: "sk-ant-...",       // APIキー直指定
    credsPath: "/path/to/creds" // 認証ファイルパス
  },
  maxRetries: 2,                // リトライ回数
  baseURL: "https://...",       // APIエンドポイント
  betas: ["..."],               // 追加ベータヘッダ
  interactive: true,             // CC対話型経路（デフォルト。falseでsdk-cli相当）
})
```

認証の優先順位は次の通り。

1. `auth.token` または `CLAUDE_CODE_OAUTH_TOKEN` 環境変数
2. macOSキーチェーン（Claude Codeのログインセッション）
3. `~/.claude/.credentials.json`
4. `auth.apiKey` または `ANTHROPIC_API_KEY` 環境変数

## リクエストオプション（`Send`）

| オプション | 型 | 説明 |
|-----------|-----|------|
| `model` | `string` | モデルID |
| `system` | `string \| TextBlockParam[]` | システムプロンプト |
| `messages` | `MessageParam[]` | メッセージ配列 |
| `maxTokens` | `number` | 最大出力トークン |
| `thinking` | `true \| "adaptive" \| {type:"enabled", budget_tokens}` | ネイティブthinking |
| `effort` | `"low" \| "medium" \| "high" \| "xhigh" \| "max"` | 出力品質 |
| `tools` | `Tool[]` | ツール定義 |
| `toolChoice` | `ToolChoice` | ツール選択制御 |
| `temperature` | `number` | サンプリング温度 |
| `stop` | `string[]` | 停止シーケンス |
| `speed` | `"fast"` | 高速モード |
| `ctx1m` | `boolean` | 1Mコンテキスト |
| `redact` | `boolean` | thinking暗号化ベータを送る（interactive時のデフォルト: `true`） |
| `cache` | `boolean` | プロンプトキャッシュ（デフォルト: `true`） |
| `signal` | `AbortSignal` | キャンセル |
| `timeout` | `number` | タイムアウト（ms） |
| `betas` | `string[]` | 追加ベータ |

`string` を渡すと `{ messages: [{ role: "user", content: "..." }] }` として扱われる。

## メソッド

| メソッド | 戻り値 | 用途 |
|---------|--------|------|
| `ask(o)` | `Promise<string>` | テキスト取得 |
| `send(o)` | `Promise<Response>` | 完全なレスポンス |
| `stream(o)` | `AsyncGenerator<StreamEvent>` | 全SSEイベント |
| `streamText(o)` | `AsyncGenerator<string>` | テキストチャンクのみ |

## `redact: false` で推論を平文取得する

Claude Codeは推論内容を `redacted_thinking` ブロックとして暗号化して返す。
この挙動はリクエストに含まれる `redact-thinking` ベータヘッダによって制御されている。

このSDKでは `redact: false` を指定すると、そのヘッダを送らない。`interactive: false` の場合も、`redact` 未指定ではヘッダを送らない。
結果として、`thinking` ブロックに推論テキストが平文で格納される。

```ts
const r = await c.send({
  messages: [{ role: "user", content: "15の素因数分解を説明して" }],
  thinking: { type: "enabled", budget_tokens: 5000 },
  redact: false,
  maxTokens: 8000,
});

for (const b of r.content) {
  if (b.type === "thinking") {
    console.log((b as any).thinking); // 推論の中身がそのまま見える
  }
}
```

## ライセンス

GPL-3.0

## 免責事項

このプロジェクトは教育・研究目的で作成された、非公式のソフトウェアである。
Anthropicおよびその関連サービスとは無関係であり、公式のサポートや推奨を受けていない。
このソフトウェアの使用によって生じた結果について、作者は一切の責任を負わない。

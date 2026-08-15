import { Claude } from "claude-cc-sdk";

const c = new Claude({ model: "claude-haiku-4-5-20251001" });

const r = await c.send({
  messages: [{ role: "user", content: "Factorize 15" }],
  thinking: { type: "enabled", budget_tokens: 5000 },
  redact: false,
  maxTokens: 8000,
});

for (const b of r.content) {
  if (b.type === "thinking") console.log("[THINK]", (b as any).thinking);
  if (b.type === "text") console.log("[OUT]", b.text);
}

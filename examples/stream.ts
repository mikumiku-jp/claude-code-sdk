import { Claude } from "../src/index.js";

const c = new Claude({ model: "claude-haiku-4-5-20251001" });

for await (const e of c.stream({ messages: [{ role: "user", content: "Hi" }], maxTokens: 50 })) {
  console.log(e.type);
}

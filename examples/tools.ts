import { Claude } from "claude-cc-sdk";

const c = new Claude({ model: "claude-haiku-4-5-20251001" });

const r = await c.send({
  messages: [{ role: "user", content: "Weather in Tokyo?" }],
  tools: [{
    name: "weather",
    description: "Get weather for a city",
    input_schema: { type: "object" as const, properties: { city: { type: "string" } }, required: ["city"] },
  }],
});

for (const b of r.content) {
  if (b.type === "text") console.log(b.text);
  if (b.type === "tool_use") console.log(`${b.name}(${JSON.stringify(b.input)})`);
}

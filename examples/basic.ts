import { Claude } from "../src/index.js";

const c = new Claude({ model: "claude-haiku-4-5-20251001" });

console.log(await c.ask("1+1=?"));

for await (const t of c.streamText("Count to 3")) process.stdout.write(t);
console.log();

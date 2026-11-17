import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { scriptJsonSchema } from "../src/schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../schema/script.schema.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(scriptJsonSchema(), null, 2) + "\n");
console.log(`wrote ${out}`);

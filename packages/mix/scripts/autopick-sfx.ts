/**
 * Choose foley takes automatically and assemble the sound library (no listening step).
 *
 *   pnpm --filter @midnight-radio/mix sfx:auto [--candidates <dir>]
 *
 * Writes assets/sfx/picks.json and assets/sfx/autopick.json (every take's measurements and why
 * each won or lost), then assembles assets/sfx/ as sfx:assemble does. Edit picks.json and run
 * sfx:assemble to override a choice. Needs ffmpeg.
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { AssembleError, assembleSfx } from "../src/assemble-sfx.js";
import { autopick } from "../src/autopick.js";
import { FfmpegError } from "../src/ffmpeg.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { values } = parseArgs({ options: { candidates: { type: "string" } } });
const sfxDir = resolve(root, "assets/sfx");
const candidatesDir = resolve(values.candidates ?? resolve(root, "services/local-audio/sfx-candidates"));

try {
  if (!existsSync(join(candidatesDir, "takes.json"))) {
    throw new AssembleError(`no generated takes in ${candidatesDir}; run services/local-audio/tools/generate_sfx.py against your sound-effect server first`);
  }
  const { picks, report } = await autopick(sfxDir, candidatesDir);
  await writeFile(join(sfxDir, "picks.json"), `${JSON.stringify({ version: 1, picks }, null, 2)}\n`);
  await writeFile(join(sfxDir, "autopick.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const c of report.cues) console.log(`${c.id.padEnd(20)} ${c.picked === null ? "—" : `take ${c.picked}`}  ${c.reason}`);
  const unpicked = report.cues.filter((c) => c.picked === null);
  const r = await assembleSfx({ sfxDir, candidatesDir, attribution: resolve(root, "ATTRIBUTION.md") });
  console.log(`\n${r.assembled.length} sound(s) assembled; catalogue ${r.catalogueId}.`);
  if (unpicked.length > 0) console.log(`No usable take for: ${unpicked.map((c) => c.id).join(", ")} (Scripts cannot use these until they are regenerated).`);
} catch (err) {
  if (err instanceof AssembleError || err instanceof FfmpegError) {
    console.error(`stopped: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

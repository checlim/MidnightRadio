/**
 * Choose foley takes automatically and assemble the sound library (no listening step).
 *
 *   pnpm --filter @midnight-radio/mix sfx:auto [--candidates <dir>]
 *
 * Writes assets/sfx/picks.json and assets/sfx/autopick.json (every take's measurements and why
 * each won or lost), then assembles assets/sfx/ as sfx:assemble does. Edit picks.json and run
 * sfx:assemble to override a choice. Needs ffmpeg.
 */
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { AssembleError } from "../src/assemble-sfx.js";
import { FfmpegError } from "../src/ffmpeg.js";
import { autoAssemble } from "../src/sfx-build.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { values } = parseArgs({ options: { candidates: { type: "string" } } });

try {
  const { report, assembled } = await autoAssemble({
    sfxDir: resolve(root, "assets/sfx"),
    candidatesDir: resolve(values.candidates ?? resolve(root, "services/local-audio/sfx-candidates")),
    attribution: resolve(root, "ATTRIBUTION.md"),
  });
  for (const c of report.cues) console.log(`${c.id.padEnd(20)} ${c.picked === null ? "—" : `take ${c.picked}`}  ${c.reason}`);
  console.log(`\n${assembled.assembled.length} sound(s) assembled; catalogue ${assembled.catalogueId}.`);
  const unpicked = report.cues.filter((c) => c.picked === null);
  if (unpicked.length > 0) console.log(`No usable take for: ${unpicked.map((c) => c.id).join(", ")} (Scripts cannot use these until they are regenerated).`);
} catch (err) {
  if (err instanceof AssembleError || err instanceof FfmpegError) {
    console.error(`stopped: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

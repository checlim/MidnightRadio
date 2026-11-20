/**
 * Assemble the chosen foley takes into assets/sfx (Task 6.1).
 *
 *   pnpm --filter @midnight-radio/mix sfx:assemble [--candidates <dir>]
 *
 * Reads assets/sfx/prompts.json and assets/sfx/picks.json, plus takes.json and the takes in the
 * candidates folder (default services/local-audio/sfx-candidates). Writes the 24 kHz files,
 * assets/sfx/index.json and the sound section of ATTRIBUTION.md. Needs ffmpeg and ffprobe.
 */
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { AssembleError, assembleSfx } from "../src/assemble-sfx.js";
import { FfmpegError } from "../src/ffmpeg.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { values } = parseArgs({ options: { candidates: { type: "string" } } });

try {
  const report = await assembleSfx({
    sfxDir: resolve(root, "assets/sfx"),
    candidatesDir: resolve(values.candidates ?? resolve(root, "services/local-audio/sfx-candidates")),
    attribution: resolve(root, "ATTRIBUTION.md"),
  });
  for (const s of report.assembled) {
    const clicks = s.possibleClicks.length > 0 ? `  listen near ${s.possibleClicks.map((t) => `${t.toFixed(2)} s`).join(", ")} (sudden jump)` : "";
    console.log(`${s.id.padEnd(20)} ${(s.durationMs / 1000).toFixed(2).padStart(6)} s  assets/sfx/${s.path}${clicks}`);
  }
  console.log(`\n${report.assembled.length} sound(s) assembled; catalogue ${report.catalogueId}.`);
  if (report.skipped.length > 0) console.log(`No pick yet: ${report.skipped.join(", ")}`);
} catch (err) {
  if (err instanceof AssembleError || err instanceof FfmpegError) {
    console.error(`stopped: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

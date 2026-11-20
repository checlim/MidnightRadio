/**
 * Choose and import the theme, sting and transition music automatically (no listening step).
 *
 *   pnpm --filter @midnight-radio/mix sfx:music [--candidates <dir>]
 *
 * Reads assets/sfx/music-sources.json (the CC0 files allowed for each cue), checks each file in
 * the candidates folder (default music-candidates/) against its recorded hash, chooses an excerpt
 * per cue, writes assets/sfx/music-picks.json (every file's best excerpt and why it won or lost),
 * and imports the winners into the library pinned to their cues, as sfx:import does. Stops without
 * importing anything if a cue has no usable excerpt. Needs ffmpeg and ffprobe.
 */
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { AssembleError } from "../src/assemble-sfx.js";
import { FfmpegError } from "../src/ffmpeg.js";
import { importMusic } from "../src/sfx-build.js";
import { printMusic } from "./print.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { values } = parseArgs({ options: { candidates: { type: "string" } } });

try {
  const r = await importMusic({ sfxDir: resolve(root, "assets/sfx"), musicDir: resolve(values.candidates ?? resolve(root, "music-candidates")), attribution: resolve(root, "ATTRIBUTION.md") });
  printMusic(r.report);
  for (const i of r.imported) console.log(`imported ${i.id} (${(i.durationMs / 1000).toFixed(1)} s) as the ${i.cue}`);
  console.log(`catalogue ${r.catalogueId}`);
} catch (err) {
  if (err instanceof AssembleError || err instanceof FfmpegError) {
    console.error(`stopped: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

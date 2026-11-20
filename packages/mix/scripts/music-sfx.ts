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
import { writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { AssembleError, importSfx } from "../src/assemble-sfx.js";
import { FfmpegError } from "../src/ffmpeg.js";
import { pickMusic } from "../src/music-pick.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { values } = parseArgs({ options: { candidates: { type: "string" } } });
const sfxDir = resolve(root, "assets/sfx");
const candidatesDir = resolve(values.candidates ?? resolve(root, "music-candidates"));

try {
  const { choices, report } = await pickMusic(join(sfxDir, "music-sources.json"), candidatesDir);
  await writeFile(join(sfxDir, "music-picks.json"), `${JSON.stringify(report, null, 2)}\n`);
  for (const c of report.cues) {
    console.log(`${c.cue.padEnd(11)} ${c.picked ? `${c.picked.file} ${c.picked.startS}–${(c.picked.startS + c.picked.durationS).toFixed(1)} s (score ${c.picked.score})` : "—"}`);
    for (const k of c.candidates.filter((k) => k.rejected)) console.log(`${"".padEnd(12)}${k.file}: ${k.rejected}`);
  }
  const missing = report.cues.filter((c) => c.picked === null).map((c) => c.cue);
  if (missing.length > 0) {
    throw new AssembleError(`no usable music for: ${missing.join(", ")}. Download the files listed in assets/sfx/music-sources.json from their source pages into ${candidatesDir}`);
  }
  for (const c of choices) {
    const r = await importSfx(
      { sfxDir, attribution: resolve(root, "ATTRIBUTION.md") },
      { file: join(candidatesDir, c.source.file), id: c.id, kind: "music", title: c.source.title, sourceUrl: c.source.sourcePage, author: c.source.author, startS: c.startS, durationS: c.durationS, fadeOutS: c.fadeOutS, cue: c.cue, tags: ["music", c.cue] },
      { log: (m) => console.error(m) },
    );
    console.log(`imported ${r.id} (${(r.durationMs / 1000).toFixed(1)} s) as the ${c.cue}; catalogue ${r.catalogueId}`);
  }
} catch (err) {
  if (err instanceof AssembleError || err instanceof FfmpegError) {
    console.error(`stopped: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

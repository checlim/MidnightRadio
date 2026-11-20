/**
 * Build the whole sound library with no listening step.
 *
 *   pnpm sfx:build [--takes 3]
 *
 * 1. Generates foley takes for every cue in assets/sfx/prompts.json on the sound-effect server at
 *    SFX_SERVICE_URL (and SFX_SERVICE_TOKEN for https), read from the environment or the repo's
 *    .env; resumes after a dropped session and retries failed takes once.
 * 2. Chooses one take per cue (sfx:auto) and assembles assets/sfx/.
 * 3. Chooses and imports the theme, sting and transition music (sfx:music).
 * Stops with a message saying what to do if the server is unreachable, uv or ffmpeg is missing,
 * or the music files are absent. Exit status: 0 complete, 1 built but some cues have no usable
 * take, 2 stopped.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { AssembleError } from "../src/assemble-sfx.js";
import { FfmpegError } from "../src/ffmpeg.js";
import { buildSfx, pythonGenerate } from "../src/sfx-build.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
if (existsSync(resolve(root, ".env"))) process.loadEnvFile(resolve(root, ".env"));
const { values } = parseArgs({ options: { takes: { type: "string", default: "3" } } });
const takes = Number(values.takes);
const sfxDir = resolve(root, "assets/sfx");
const candidatesDir = resolve(root, "services/local-audio/sfx-candidates");

try {
  if (!Number.isInteger(takes) || takes < 1 || takes > 10) throw new AssembleError("--takes must be a whole number from 1 to 10");
  const r = await buildSfx(
    { sfxDir, candidatesDir, musicDir: resolve(root, "music-candidates"), attribution: resolve(root, "ATTRIBUTION.md") },
    { generate: pythonGenerate({ serviceDir: resolve(root, "services/local-audio"), prompts: resolve(sfxDir, "prompts.json"), out: candidatesDir, takes }) },
  );
  console.log(`\nfoley: ${r.foley.assembled.length} sound(s) assembled; music: ${r.music.map((m) => `${m.cue} ${m.id}`).join(", ")}`);
  console.log(`catalogue ${r.catalogueId}; choices recorded in assets/sfx/autopick.json and music-picks.json`);
  if (r.generationIncomplete) console.log("Some takes still failed after a retry; run pnpm sfx:build again to retry them.");
  if (r.foley.unpicked.length > 0) {
    console.log(`No usable take for: ${r.foley.unpicked.join(", ")}. Scripts cannot use these; change their prompt or seed in prompts.json and run again.`);
    process.exit(1);
  }
} catch (err) {
  if (err instanceof AssembleError || err instanceof FfmpegError) {
    console.error(`stopped: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

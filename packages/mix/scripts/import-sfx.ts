/**
 * Add one CC0 sound or piece of music to assets/sfx (Task 6.1).
 *
 *   pnpm --filter @midnight-radio/mix sfx:import -- --file <path> --id <id> --kind music|sfx \
 *     --title "<title>" --source <https page stating CC0> [--author <name>] \
 *     [--start <s>] [--duration <s>] [--fade-out <s>] [--loop] [--cue theme|sting|transition] [--tag <t>]...
 *
 * Confirm the CC0 dedication on the source page before importing. Needs ffmpeg and ffprobe.
 */
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { AssembleError, importSfx } from "../src/assemble-sfx.js";
import { FfmpegError } from "../src/ffmpeg.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const { values: v } = parseArgs({
  options: {
    file: { type: "string" },
    id: { type: "string" },
    kind: { type: "string" },
    title: { type: "string" },
    source: { type: "string" },
    author: { type: "string" },
    start: { type: "string" },
    duration: { type: "string" },
    "fade-out": { type: "string" },
    loop: { type: "boolean", default: false },
    cue: { type: "string" },
    tag: { type: "string", multiple: true },
  },
});
const num = (name: string, raw: string | undefined) => {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new AssembleError(`--${name} must be a number of seconds`);
  return n;
};
try {
  for (const required of ["file", "id", "kind", "title", "source"] as const) if (!v[required]) throw new AssembleError(`--${required} is required`);
  if (v.kind !== "music" && v.kind !== "sfx") throw new AssembleError("--kind must be music or sfx");
  if (!/^https:\/\//.test(v.source!)) throw new AssembleError("--source must be the https page that states the CC0 dedication");
  const r = await importSfx(
    { sfxDir: resolve(root, "assets/sfx"), attribution: resolve(root, "ATTRIBUTION.md") },
    {
      file: resolve(v.file!),
      id: v.id!,
      kind: v.kind,
      title: v.title!,
      sourceUrl: v.source!,
      ...(v.author ? { author: v.author } : {}),
      ...(v.start !== undefined ? { startS: num("start", v.start)! } : {}),
      ...(v.duration !== undefined ? { durationS: num("duration", v.duration)! } : {}),
      ...(v["fade-out"] !== undefined ? { fadeOutS: num("fade-out", v["fade-out"])! } : {}),
      loopable: v.loop,
      ...(v.cue ? { cue: v.cue as "theme" } : {}),
      ...(v.tag ? { tags: v.tag } : {}),
    },
  );
  const clicks = r.possibleClicks.length > 0 ? `; listen near ${r.possibleClicks.map((t) => `${t.toFixed(2)} s`).join(", ")} (sudden jump)` : "";
  console.log(`${r.id}: ${(r.durationMs / 1000).toFixed(2)} s → assets/sfx/${r.path}${clicks}\ncatalogue ${r.catalogueId}`);
} catch (err) {
  if (err instanceof AssembleError || err instanceof FfmpegError) {
    console.error(`stopped: ${err.message}`);
    process.exit(2);
  }
  throw err;
}

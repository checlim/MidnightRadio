import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { AssembleError, assembleSfx, importSfx, type AssembleReport } from "./assemble-sfx.js";
import { autopick, type AutopickReport } from "./autopick.js";
import type { FfmpegOptions } from "./ffmpeg.js";
import { pickMusic, type MusicCue, type MusicPickReport } from "./music-pick.js";

/**
 * The sound library, built without a listener: generate foley takes on the sound-effect server,
 * choose them (`autopick`), assemble them, then choose and import the music excerpts. Each step
 * stops with an `AssembleError` whose message says what to do.
 */

export interface SfxBuildPaths {
  /** `assets/sfx`: prompts.json, music-sources.json and the library. */
  sfxDir: string;
  /** Generated foley takes (git-ignored). */
  candidatesDir: string;
  /** Downloaded CC0 music (git-ignored). */
  musicDir: string;
  attribution: string;
}

/** Choose foley takes, write picks.json and autopick.json, and assemble the library. */
export async function autoAssemble(paths: Omit<SfxBuildPaths, "musicDir">, ff: FfmpegOptions = {}): Promise<{ report: AutopickReport; assembled: AssembleReport }> {
  if (!existsSync(join(paths.candidatesDir, "takes.json"))) {
    throw new AssembleError(`no generated takes in ${paths.candidatesDir}; run services/local-audio/tools/generate_sfx.py against your sound-effect server first`);
  }
  const { picks, report } = await autopick(paths.sfxDir, paths.candidatesDir);
  await writeFile(join(paths.sfxDir, "picks.json"), `${JSON.stringify({ version: 1, picks }, null, 2)}\n`);
  await writeFile(join(paths.sfxDir, "autopick.json"), `${JSON.stringify(report, null, 2)}\n`);
  const assembled = await assembleSfx({ sfxDir: paths.sfxDir, candidatesDir: paths.candidatesDir, attribution: paths.attribution }, ff);
  return { report, assembled };
}

/** Choose the music excerpts, write music-picks.json, and import them pinned to their cues. */
export async function importMusic(paths: Omit<SfxBuildPaths, "candidatesDir">, ff: FfmpegOptions = {}): Promise<{ report: MusicPickReport; imported: { cue: MusicCue; id: string; durationMs: number }[]; catalogueId: string | null }> {
  const { choices, report } = await pickMusic(join(paths.sfxDir, "music-sources.json"), paths.musicDir, ff);
  await writeFile(join(paths.sfxDir, "music-picks.json"), `${JSON.stringify(report, null, 2)}\n`);
  const missing = report.cues.filter((c) => c.picked === null).map((c) => c.cue);
  if (missing.length > 0) {
    throw new AssembleError(`no usable music for: ${missing.join(", ")}. Download the files listed in assets/sfx/music-sources.json from their source pages into ${paths.musicDir}`);
  }
  const imported: { cue: MusicCue; id: string; durationMs: number }[] = [];
  let catalogueId: string | null = null;
  for (const c of choices) {
    const r = await importSfx(
      { sfxDir: paths.sfxDir, attribution: paths.attribution },
      { file: join(paths.musicDir, c.source.file), id: c.id, kind: "music", title: c.source.title, sourceUrl: c.source.sourcePage, author: c.source.author, startS: c.startS, durationS: c.durationS, fadeOutS: c.fadeOutS, cue: c.cue, tags: ["music", c.cue] },
      ff,
    );
    imported.push({ cue: c.cue, id: r.id, durationMs: r.durationMs });
    catalogueId = r.catalogueId;
  }
  return { report, imported, catalogueId };
}

/** One run of the foley generator. Resolves with its exit status: 0 all rendered, 1 some failed, 2 stopped. */
export type GenerateStep = () => Promise<number>;

/** Run `services/local-audio/tools/generate_sfx.py` through uv, its output shown as it goes. */
export function pythonGenerate(opts: { serviceDir: string; prompts: string; out: string; takes: number; env?: NodeJS.ProcessEnv }): GenerateStep {
  return () =>
    new Promise((resolve, reject) => {
      const child = spawn("uv", ["run", "--no-project", "--python", ">=3.10", "python", "tools/generate_sfx.py", "--prompts", opts.prompts, "--out", opts.out, "--takes", String(opts.takes)], {
        cwd: opts.serviceDir,
        env: opts.env ?? process.env,
        stdio: ["ignore", "inherit", "inherit"],
      });
      child.on("error", (err) => reject((err as NodeJS.ErrnoException).code === "ENOENT" ? new AssembleError("uv is not installed (https://docs.astral.sh/uv/); it runs the foley generator") : err));
      child.on("exit", (code) => resolve(code ?? 2));
    });
}

const TakesModelSchema = z.object({ model: z.object({ model: z.string(), revision: z.string() }).passthrough() });

export interface SfxBuildResult {
  catalogueId: string;
  foley: { assembled: string[]; unpicked: string[] };
  music: { cue: MusicCue; id: string }[];
  /** Some takes still failed after one retry; the library was built from the rest. */
  generationIncomplete: boolean;
}

/**
 * Generate (retrying failed takes once), choose and assemble foley, then import music. Refuses
 * takes from the service's fake test backend unless `allowFakeModel` (tests only), so tones can
 * never end up in the library by pointing at the wrong server.
 */
export async function buildSfx(paths: SfxBuildPaths, opts: { generate: GenerateStep; allowFakeModel?: boolean; log?: (m: string) => void; ff?: FfmpegOptions }): Promise<SfxBuildResult> {
  const log = opts.log ?? console.log;
  let status = await opts.generate();
  if (status === 1) {
    log("some takes failed; retrying them once");
    status = await opts.generate();
  }
  if (status !== 0 && status !== 1) throw new AssembleError("foley generation stopped (see the message above); nothing was assembled");
  const takes = TakesModelSchema.safeParse(JSON.parse(await readFile(join(paths.candidatesDir, "takes.json"), "utf8").catch(() => "null")));
  if (!takes.success) throw new AssembleError(`foley generation wrote no usable takes.json in ${paths.candidatesDir}`);
  if (!opts.allowFakeModel && /^fake/i.test(takes.data.model.model)) {
    throw new AssembleError(`the takes come from "${takes.data.model.model}", the local service's test backend (tones); point SFX_SERVICE_URL at a real sound-effect server and use a fresh candidates folder`);
  }
  const foley = await autoAssemble(paths, opts.ff);
  const music = await importMusic(paths, opts.ff);
  return {
    catalogueId: music.catalogueId ?? foley.assembled.catalogueId,
    foley: { assembled: foley.assembled.assembled.map((a) => a.id), unpicked: foley.report.cues.filter((c) => c.picked === null).map((c) => c.id) },
    music: music.imported.map(({ cue, id }) => ({ cue, id })),
    generationIncomplete: status === 1,
  };
}

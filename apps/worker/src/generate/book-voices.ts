import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ChunkCharacterSchema, VoiceCatalogueSchema, bookVoiceCatalogue, catalogueHash, designedVoiceId, requireClonable, voiceTraits, type ClonableCatalogue, type InventoryCharacter } from "@midnight-radio/core";
import { DESIGN_SENTENCE, checkDesignedClip, type VoiceDesignPin, type VoiceDesigner } from "@midnight-radio/tts";
import { z } from "zod";

/**
 * A book's own voices on disk: `<voicesRoot>/<bookId>/catalogue.json` and `clips/`, holding the
 * series Announcer and Narrator (copied) and one clip designed for each speaking character from
 * their voice brief. Also the plan (`voices-plan.json`: the frozen character inventory and the
 * briefs), written before any clip is designed, so a crash never repeats the paid LLM steps.
 */

/** Seeds tried in turn until a designed clip passes the reference checks. */
export const DESIGN_SEEDS = [1940, 1941, 1942] as const;

export class VoiceDesignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceDesignError";
  }
}

export interface BookVoicesDeps {
  /** `<DATA_DIR>/voices`. */
  voicesRoot: string;
  /** The series catalogue (Announcer, Narrator, the voice-clone pin) and the folder its clips are in. */
  series: ClonableCatalogue;
  seriesDir: string;
  designPin: VoiceDesignPin;
  log: (message: string) => void;
  fence?: () => void;
  signal?: AbortSignal;
}

export const bookVoicesDir = (voicesRoot: string, bookId: string) => join(voicesRoot, bookId);

async function writeAtomic(path: string, bytes: Uint8Array | string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(bytes);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

const InventorySchema = z.array(
  z.object({
    id: z.string(),
    name: z.string(),
    aliases: z.array(z.string()),
    genderPresentation: z.enum(["feminine", "masculine", "neutral", "unstated"]),
    ageBand: z.enum(["child", "teen", "young-adult", "adult", "older", "unknown"]),
    description: z.string(),
    speaks: z.boolean(),
    mentionCount: z.number().int().min(0),
    firstChapterIdx: z.number().int().min(0),
  }),
);
const PlanSchema = z.object({ version: z.literal(1), inventory: InventorySchema, briefs: z.record(z.string(), z.string()) });
export type VoicesPlan = z.infer<typeof PlanSchema>;

export async function readVoicesPlan(voicesRoot: string, bookId: string): Promise<VoicesPlan | null> {
  const path = join(bookVoicesDir(voicesRoot, bookId), "voices-plan.json");
  if (!existsSync(path)) return null;
  return PlanSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

export async function writeVoicesPlan(voicesRoot: string, bookId: string, inventory: InventoryCharacter[], briefs: ReadonlyMap<string, string>): Promise<void> {
  const plan: VoicesPlan = { version: 1, inventory, briefs: Object.fromEntries(briefs) };
  await writeAtomic(join(bookVoicesDir(voicesRoot, bookId), "voices-plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
}

const ProgressSchema = z.object({
  version: z.literal(1),
  chunks: z.array(z.object({ chunk: z.number().int().min(0), chapterIdx: z.number().int().min(0), textSha256: z.string().regex(/^[0-9a-f]{64}$/), characters: z.array(ChunkCharacterSchema).max(60) })),
});
export type CastingProgress = z.infer<typeof ProgressSchema>["chunks"];

/**
 * Excerpts casting has already read for a book (`casting-progress.json`), so an interrupted run
 * resumes instead of paying for them again. A missing or unreadable file means none.
 */
export async function readCastingProgress(voicesRoot: string, bookId: string): Promise<CastingProgress> {
  const path = join(bookVoicesDir(voicesRoot, bookId), "casting-progress.json");
  if (!existsSync(path)) return [];
  const parsed = ProgressSchema.safeParse(JSON.parse(await readFile(path, "utf8").catch(() => "null")));
  return parsed.success ? parsed.data.chunks : [];
}

export async function writeCastingProgress(voicesRoot: string, bookId: string, chunks: CastingProgress): Promise<void> {
  const sorted = [...chunks].sort((a, b) => a.chunk - b.chunk);
  await writeAtomic(join(bookVoicesDir(voicesRoot, bookId), "casting-progress.json"), `${JSON.stringify({ version: 1, chunks: sorted })}\n`);
}

/** The catalogue a book's Cast is pinned to: its own, or the series catalogue for a book cast from it. */
export async function loadBookCatalogue(voicesRoot: string, bookId: string, series: ClonableCatalogue, seriesDir: string, pin: { catalogueId: string; catalogueHash: string }): Promise<{ catalogue: ClonableCatalogue; clipDir: string }> {
  if (pin.catalogueId === series.id && pin.catalogueHash === catalogueHash(series)) return { catalogue: series, clipDir: seriesDir };
  const dir = bookVoicesDir(voicesRoot, bookId);
  const path = join(dir, "catalogue.json");
  if (!existsSync(path)) throw new VoiceDesignError(`the book's voices are missing (${path}); its Cast cannot be rendered`);
  const catalogue = requireClonable(VoiceCatalogueSchema.parse(JSON.parse(await readFile(path, "utf8"))));
  if (catalogue.id !== pin.catalogueId || catalogueHash(catalogue) !== pin.catalogueHash) throw new VoiceDesignError("the book's voices on disk are not the ones its Cast is pinned to");
  return { catalogue, clipDir: dir };
}

/** File name of a designed clip: the voice id and a hash of what produced it, so a redesign never overwrites a clip in use. */
const clipFileFor = (voiceId: string, brief: string, seed: number, revision: string) =>
  `clips/${voiceId}-${createHash("sha256").update(`${brief}\0${seed}\0${revision}`).digest("hex").slice(0, 10)}.wav`;

/**
 * Design one voice: try each seed until the clip passes the checks. A clip already on disk for the
 * same brief, seed and model is reused (resume). Returns the clip's relative path and hash.
 */
export async function designClip(dir: string, voiceId: string, characterName: string, brief: string, designer: VoiceDesigner, deps: Pick<BookVoicesDeps, "fence" | "signal" | "log">): Promise<{ file: string; sha256: string; seed: number }> {
  const reasons: string[] = [];
  for (const seed of DESIGN_SEEDS) {
    const file = clipFileFor(voiceId, brief, seed, designer.identity.revision);
    const path = join(dir, file);
    if (existsSync(path)) {
      const bytes = await readFile(path);
      if (checkDesignedClip(bytes).ok) return { file, sha256: createHash("sha256").update(bytes).digest("hex"), seed };
    }
    deps.signal?.throwIfAborted();
    const wav = await designer.design({ instruct: brief, text: DESIGN_SENTENCE, seed }, deps.signal ? { signal: deps.signal } : {});
    const verdict = checkDesignedClip(wav);
    if (!verdict.ok) {
      reasons.push(`seed ${seed}: ${verdict.reason}`);
      deps.log(`voice for ${characterName}: seed ${seed} gave an unusable clip (${verdict.reason}); trying another`);
      continue;
    }
    deps.fence?.();
    await writeAtomic(path, wav);
    return { file, sha256: createHash("sha256").update(wav).digest("hex"), seed };
  }
  throw new VoiceDesignError(`no usable voice for "${characterName}" after ${DESIGN_SEEDS.length} tries (${reasons.join("; ")})`);
}

/**
 * Design every speaking character's voice and write the book's catalogue. Returns the catalogue,
 * its folder, and which voice each character (by inventory id) got. Resumable: clips already made
 * are reused. With no speaking characters the series catalogue serves the book.
 */
export async function designBookVoices(bookId: string, plan: VoicesPlan, designer: VoiceDesigner | null, deps: BookVoicesDeps): Promise<{ catalogue: ClonableCatalogue; clipDir: string; voiceFor: Map<string, string> }> {
  const speakers = plan.inventory.filter((c) => c.speaks);
  if (speakers.length === 0) return { catalogue: deps.series, clipDir: deps.seriesDir, voiceFor: new Map() };
  if (!designer) throw new VoiceDesignError("the book's characters need voices designed, and no voice-design server is connected");
  const dir = bookVoicesDir(deps.voicesRoot, bookId);
  await mkdir(join(dir, "clips"), { recursive: true });
  for (const role of ["announcer", "narrator"] as const) {
    const v = deps.series.voices.find((x) => x.id === deps.series.reserved[role])!;
    const target = join(dir, v.clip.file);
    if (!existsSync(target)) {
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(deps.seriesDir, v.clip.file), target);
    }
  }
  const voices = [];
  const voiceFor = new Map<string, string>();
  let done = 0;
  for (const c of speakers) {
    const brief = plan.briefs[c.name];
    if (!brief) throw new VoiceDesignError(`no voice brief for "${c.name}"`);
    const id = designedVoiceId(c.name);
    const clip = await designClip(dir, id, c.name, brief, designer, deps);
    voices.push({ id, name: c.name, ...voiceTraits(c), brief, clip: { file: clip.file, sha256: clip.sha256, transcript: DESIGN_SENTENCE } });
    voiceFor.set(c.id, id);
    done++;
    if (done % 5 === 0 || done === speakers.length) deps.log(`voices: ${done}/${speakers.length} designed`);
  }
  const catalogue = bookVoiceCatalogue({ bookId, series: deps.series, designPin: deps.designPin, voices, version: 1 });
  deps.fence?.();
  await writeAtomic(join(dir, "catalogue.json"), `${JSON.stringify(catalogue, null, 2)}\n`);
  return { catalogue, clipDir: dir, voiceFor };
}

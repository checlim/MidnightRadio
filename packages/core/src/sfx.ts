import { z } from "zod";
import { MUSIC_CUES, type SceneBedSchema } from "./schema.js";

/**
 * The sound library catalogue, `assets/sfx/index.json` (Req 3.5, 4.1, 9.2; design "Script Schema").
 * One versioned catalogue for sound effects and music, read in-process by adaptation and
 * validation and by the `sfx-library` MCP server, so all of them apply the same rules.
 *
 * Every asset says where it came from and under what licence. Only licences that allow the
 * project to redistribute the file are accepted (fail closed: an unknown licence is refused).
 * Generated foley also records the model, revision and output licence the sound-effect service
 * reported (docs/sfx-service-api.md), plus the prompt and seed that made it.
 */

/** Licences an asset may carry. CC0 for found sounds; generated or hand-made assets may also use permissive licences. */
export const SFX_LICENCES = ["CC0-1.0", "Apache-2.0", "MIT"] as const;
export type SfxLicence = (typeof SFX_LICENCES)[number];

export const SFX_KINDS = ["sfx", "music"] as const;
export type SfxKind = (typeof SFX_KINDS)[number];

/** Same shape as cue ids in `assets/sfx/prompts.json`, e.g. `door_creak`. */
export const SfxIdSchema = z.string().regex(/^[a-z][a-z0-9_]{1,47}$/, "sound ids are 2–48 lower-case letters, digits or _ starting with a letter");

const shortText = z.string().trim().min(1).max(100);
const sha256 = z.string().regex(/^[0-9a-f]{64}$/, "sha256 must be 64 lowercase hex characters");
const tag = z.string().regex(/^[a-z][a-z0-9-]{0,23}$/, "tags are short lower-case words");
const utcTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, "use a UTC time like 2026-11-20T10:00:00Z");

/** A path relative to `assets/sfx/`: plain segments, no `.`/`..`, no absolute paths, a .wav file. */
export const SfxPathSchema = z
  .string()
  .max(200)
  .regex(/^[a-z0-9][a-z0-9_/-]*\.wav$/, "sound files are lower-case relative .wav paths")
  .refine((p) => !p.split("/").some((s) => s === "" || s === "." || s === ".."), "sound paths must not contain empty, . or .. segments");

export const SfxSourceSchema = z.discriminatedUnion("type", [
  /** Made through the sound-effect service API; every field is what the service reported or was sent. */
  z.strictObject({
    type: z.literal("generated"),
    model: shortText,
    revision: shortText,
    weightsSha256: sha256.optional(),
    /** The model's output licence as reported by the service. */
    licence: z.enum(SFX_LICENCES),
    prompt: z.string().trim().min(1).max(500),
    seed: z.number().int().min(0).max(2_147_483_647),
    /** Hash of the file the service returned, before resampling and normalising. */
    originalSha256: sha256,
    generatedAt: utcTime,
  }),
  /** A found sound dedicated to the public domain. */
  z.strictObject({
    type: z.literal("cc0"),
    url: z.url({ protocol: /^https$/ }).max(300),
    author: shortText.optional(),
    licence: z.literal("CC0-1.0"),
    /** Hash of the downloaded file, so the import can be repeated and checked. */
    originalSha256: sha256.optional(),
    /** The part of the original that was used, when it was trimmed. */
    excerpt: z.strictObject({ startMs: z.number().int().min(0), durationMs: z.number().int().min(100) }).optional(),
  }),
  /** Made by hand for the project. */
  z.strictObject({
    type: z.literal("project"),
    author: shortText,
    licence: z.enum(SFX_LICENCES),
    note: z.string().trim().min(1).max(300).optional(),
  }),
]);
export type SfxSource = z.infer<typeof SfxSourceSchema>;

export const SfxEntrySchema = z.strictObject({
  id: SfxIdSchema,
  kind: z.enum(SFX_KINDS),
  title: shortText,
  /** Relative to `assets/sfx/`. Always 24 kHz mono 16-bit PCM WAV, the mixer's working format. */
  path: SfxPathSchema,
  sha256,
  durationMs: z.number().int().min(100).max(300_000),
  /** True for beds that may loop under a scene; they are checked for a seamless loop when assembled. */
  loopable: z.boolean(),
  /** Peak level after normalising, in dBFS. */
  peakDb: z.number().min(-60).max(0),
  tags: z.array(tag).max(8).refine((t) => new Set(t).size === t.length, "tags must not repeat"),
  source: SfxSourceSchema,
});
export type SfxEntry = z.infer<typeof SfxEntrySchema>;

export const SfxCatalogueSchema = z
  .strictObject({
    version: z.literal(1),
    /** Which sound library this is; changes whenever an asset is added, replaced or removed. */
    id: shortText,
    entries: z.array(SfxEntrySchema).max(500),
    /** Pinned music: the asset each Script music cue plays. A cue without an entry cannot be used yet. */
    musicCues: z.strictObject(Object.fromEntries(MUSIC_CUES.map((c) => [c, SfxIdSchema.optional()])) as Record<(typeof MUSIC_CUES)[number], z.ZodOptional<typeof SfxIdSchema>>),
  })
  .superRefine((c, ctx) => {
    const ids = new Map<string, SfxEntry>();
    const paths = new Set<string>();
    c.entries.forEach((e, i) => {
      if (ids.has(e.id)) ctx.addIssue({ code: "custom", path: ["entries", i, "id"], message: `duplicate sound id "${e.id}"` });
      if (paths.has(e.path)) ctx.addIssue({ code: "custom", path: ["entries", i, "path"], message: `two sounds share the file "${e.path}"` });
      ids.set(e.id, e);
      paths.add(e.path);
    });
    for (const cue of MUSIC_CUES) {
      const id = c.musicCues[cue];
      if (id === undefined) continue;
      const entry = ids.get(id);
      if (!entry) ctx.addIssue({ code: "custom", path: ["musicCues", cue], message: `music cue "${cue}" points to "${id}", which is not in the catalogue` });
      else if (entry.kind !== "music") ctx.addIssue({ code: "custom", path: ["musicCues", cue], message: `music cue "${cue}" points to "${id}", which is not music` });
    }
  });
export type SfxCatalogue = z.infer<typeof SfxCatalogueSchema>;

/** A Script's reference to the library that cannot be played. The message is safe to show and to feed back to the adapter. */
export interface SfxIssue {
  code: "unknown_id" | "wrong_kind" | "not_loopable" | "unmapped_cue";
  id: string;
  message: string;
}

type SceneBed = z.infer<typeof SceneBedSchema>;

/** Index for repeated lookups; build once per catalogue. */
export const indexSfx = (catalogue: SfxCatalogue): ReadonlyMap<string, SfxEntry> => new Map(catalogue.entries.map((e) => [e.id, e]));

/** A discrete `sfx` segment: the id must name a sound effect (not music). */
export function checkSfxSegment(index: ReadonlyMap<string, SfxEntry>, sfxId: string): SfxIssue | null {
  const entry = index.get(sfxId);
  if (!entry) return { code: "unknown_id", id: sfxId, message: `"${sfxId}" is not in the sound library` };
  if (entry.kind !== "sfx") return { code: "wrong_kind", id: sfxId, message: `"${sfxId}" is music; use a music segment for it` };
  return null;
}

/** A scene's ambience bed: the id must exist, be of the declared kind, and be loopable. */
export function checkSceneBed(index: ReadonlyMap<string, SfxEntry>, bed: SceneBed): SfxIssue | null {
  const entry = index.get(bed.id);
  if (!entry) return { code: "unknown_id", id: bed.id, message: `"${bed.id}" is not in the sound library` };
  if (entry.kind !== bed.kind) return { code: "wrong_kind", id: bed.id, message: `"${bed.id}" is ${entry.kind}, but the scene's ambience says ${bed.kind}` };
  if (!entry.loopable) return { code: "not_loopable", id: bed.id, message: `"${bed.id}" cannot loop, so it cannot be a scene's ambience; use it as a discrete sound` };
  return null;
}

/** The pinned asset for a music cue, or an issue if the cue has none yet. */
export function resolveMusicCue(catalogue: SfxCatalogue, index: ReadonlyMap<string, SfxEntry>, cue: (typeof MUSIC_CUES)[number]): SfxEntry | SfxIssue {
  const id = catalogue.musicCues[cue];
  const entry = id === undefined ? undefined : index.get(id);
  if (!entry || entry.kind !== "music") return { code: "unmapped_cue", id: cue, message: `the "${cue}" music cue has no pinned music in the sound library yet` };
  return entry;
}

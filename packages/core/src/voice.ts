import { createHash } from "node:crypto";
import { z } from "zod";
import { nameKey, type AgeBand, type GenderPresentation, type InventoryCharacter } from "./cast.js";

/**
 * Voice catalogue and deterministic voice assignment (Req 2.2, 2.6).
 *
 * The catalogue is pinned: provider, model, version, a fixed seed and the exact voice list, with a
 * content hash stored alongside the Cast. The Announcer and Narrator voices are named by the
 * catalogue and are never handed to a character. Assignment is a pure function of the frozen
 * character inventory and the catalogue: it does not depend on the order characters were
 * discovered, and it never shares a voice. When voices run out it stops with an error.
 */

export const VOICE_AGE_BANDS = ["child", "teen", "young-adult", "adult", "older"] as const;
export const VOICE_GENDERS = ["feminine", "masculine", "neutral"] as const;
export type VoiceGender = (typeof VOICE_GENDERS)[number];

const text = z.string().trim().min(1).max(100);
const voiceId = text.regex(/^[\w.:-]+$/, "voice ids may only contain letters, digits and . : _ -");

export const VoiceSchema = z.strictObject({
  id: voiceId,
  name: text,
  gender: z.enum(VOICE_GENDERS),
  /** Ages the voice can plausibly play. Empty means no stated range. */
  ageBands: z
    .array(z.enum(VOICE_AGE_BANDS))
    .max(VOICE_AGE_BANDS.length)
    .refine((bands) => new Set(bands).size === bands.length, "ageBands must not repeat"),
});

export const VoiceCatalogueSchema = z
  .strictObject({
    /** Pinned identity, e.g. "elevenlabs-multilingual-v2-2026-11". */
    id: text,
    provider: text,
    model: text,
    version: text,
    /** Fixed seed for the stable tie-break between equally good voices. */
    seed: text,
    reserved: z.strictObject({ announcer: voiceId, narrator: voiceId }),
    voices: z.array(VoiceSchema).min(3).max(500),
  })
  .superRefine((c, ctx) => {
    const ids = new Set<string>();
    c.voices.forEach((v, i) => {
      if (ids.has(v.id)) ctx.addIssue({ code: "custom", path: ["voices", i, "id"], message: `duplicate voice id "${v.id}"` });
      ids.add(v.id);
    });
    for (const role of ["announcer", "narrator"] as const) {
      if (!ids.has(c.reserved[role])) ctx.addIssue({ code: "custom", path: ["reserved", role], message: `reserved ${role} voice "${c.reserved[role]}" is not in the catalogue` });
    }
    if (c.reserved.announcer === c.reserved.narrator) {
      ctx.addIssue({ code: "custom", path: ["reserved", "narrator"], message: "the Announcer and Narrator must have different voices" });
    }
  });

export type Voice = z.infer<typeof VoiceSchema>;
export type VoiceCatalogue = z.infer<typeof VoiceCatalogueSchema>;

/** Content hash of a catalogue, independent of voice order and key order. Stored with the Cast as its pin. */
export function catalogueHash(input: VoiceCatalogue): string {
  const c = VoiceCatalogueSchema.parse(input);
  const canonical = {
    id: c.id,
    provider: c.provider,
    model: c.model,
    version: c.version,
    seed: c.seed,
    reserved: { announcer: c.reserved.announcer, narrator: c.reserved.narrator },
    voices: [...c.voices]
      .sort((a, b) => compare(a.id, b.id))
      .map((v) => ({ id: v.id, name: v.name, gender: v.gender, ageBands: [...v.ageBands].sort() })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export type VoiceFit = "good" | "fair" | "poor";

export interface AssignableCharacter {
  id: string;
  name: string;
  genderPresentation: GenderPresentation;
  ageBand: AgeBand;
  /** Only characters who speak are given a voice. */
  speaks: boolean;
  mentionCount: number;
}

export interface CharacterVoice {
  characterId: string;
  /** Null for characters who never speak. */
  voiceId: string | null;
  /** How well the voice suits the character; null when no voice was assigned. */
  fit: VoiceFit | null;
}

export interface VoiceAssignment {
  catalogueId: string;
  catalogueHash: string;
  announcerVoiceId: string;
  narratorVoiceId: string;
  /** In casting priority order: most mentioned first. */
  characters: CharacterVoice[];
}

export type CastingPauseReason = "voices_exhausted" | "reserved_name" | "duplicate_character";

/** Casting cannot continue without a person's decision. The message is safe to show users. */
export class CastingPausedError extends Error {
  constructor(
    readonly reason: CastingPauseReason,
    message: string,
    readonly details: { needed?: number; available?: number; names?: string[] } = {},
  ) {
    super(message);
    this.name = "CastingPausedError";
  }
}

const RESERVED_NAMES = new Set(["announcer", "narrator"]);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Casting priority: most mentioned first, then by name, then id: a total order, so input order never matters. */
export const byPriority = (a: AssignableCharacter, b: AssignableCharacter) =>
  b.mentionCount - a.mentionCount || compare(nameKey(a.name), nameKey(b.name)) || compare(a.id, b.id);

interface Rating {
  score: number;
  fit: VoiceFit;
}

/** How well `voice` suits `character`. Gender counts most, then age. */
export function rateVoice(character: Pick<AssignableCharacter, "genderPresentation" | "ageBand">, voice: Voice): Rating {
  const g = character.genderPresentation;
  let gender: number;
  let genderFit: VoiceFit = "good";
  if (g === "unstated") gender = 1; // no preference
  else if (g === "neutral") {
    gender = voice.gender === "neutral" ? 2 : 1;
  } else if (voice.gender === g) gender = 2;
  else if (voice.gender === "neutral") {
    gender = 1;
    genderFit = "fair";
  } else {
    gender = 0;
    genderFit = "poor";
  }

  let age = 1;
  let ageFit: VoiceFit = "good";
  if (character.ageBand !== "unknown" && voice.ageBands.length > 0) {
    if (voice.ageBands.includes(character.ageBand as (typeof VOICE_AGE_BANDS)[number])) age = 2;
    else {
      age = 0;
      ageFit = "fair";
    }
  }
  const fit: VoiceFit = genderFit === "poor" ? "poor" : genderFit === "fair" || ageFit === "fair" ? "fair" : "good";
  return { score: gender * 10 + age, fit };
}

/** Stable pseudo-random order between equally good voices, fixed by the catalogue's seed. */
const tieBreak = (c: VoiceCatalogue, characterId: string, voice: Voice) =>
  createHash("sha256").update([c.seed, c.id, c.version, characterId, voice.id].join("\u0000")).digest("hex");

/**
 * Assign each speaking character a distinct, non-reserved voice from the pinned catalogue.
 * Characters are served in priority order (most mentioned first), each taking the best-suited
 * voice still free; ties go to the voice with the smallest seeded hash. Characters who never
 * speak get no voice. Throws CastingPausedError instead of sharing a voice.
 */
export function assignVoices(characters: AssignableCharacter[], catalogueInput: VoiceCatalogue): VoiceAssignment {
  const catalogue = VoiceCatalogueSchema.parse(catalogueInput);

  const seen = new Set<string>();
  for (const c of characters) {
    if (seen.has(c.id)) throw new CastingPausedError("duplicate_character", `The character list contains "${c.id}" twice.`, { names: [c.name] });
    seen.add(c.id);
  }
  const reservedNamed = characters.filter((c) => RESERVED_NAMES.has(nameKey(c.name)));
  if (reservedNamed.length > 0) {
    throw new CastingPausedError(
      "reserved_name",
      `A character is named "${reservedNamed[0]!.name}", which is reserved for the radio Announcer or Narrator. Rename the character to continue.`,
      { names: reservedNamed.map((c) => c.name) },
    );
  }

  const pool = catalogue.voices
    .filter((v) => v.id !== catalogue.reserved.announcer && v.id !== catalogue.reserved.narrator)
    .sort((a, b) => compare(a.id, b.id));
  const ordered = [...characters].sort(byPriority);
  const speakers = ordered.filter((c) => c.speaks);

  if (speakers.length > pool.length) {
    const left = speakers.slice(pool.length).map((c) => c.name);
    throw new CastingPausedError(
      "voices_exhausted",
      `This book has ${speakers.length} speaking characters, but the voice catalogue has only ${pool.length} voices left after the Announcer and Narrator. ` +
        `No voices are shared. Add voices to the catalogue or merge minor characters, then try again. First without a voice: ${left.slice(0, 3).join(", ")}.`,
      { needed: speakers.length, available: pool.length, names: left },
    );
  }

  const free = new Set(pool.map((v) => v.id));
  const chosen = new Map<string, CharacterVoice>();
  for (const c of speakers) {
    let best: { voice: Voice; rating: Rating; hash: string } | undefined;
    for (const voice of pool) {
      if (!free.has(voice.id)) continue;
      const rating = rateVoice(c, voice);
      const hash = tieBreak(catalogue, c.id, voice);
      if (!best || rating.score > best.rating.score || (rating.score === best.rating.score && (hash < best.hash || (hash === best.hash && voice.id < best.voice.id)))) {
        best = { voice, rating, hash };
      }
    }
    free.delete(best!.voice.id);
    chosen.set(c.id, { characterId: c.id, voiceId: best!.voice.id, fit: best!.rating.fit });
  }

  return {
    catalogueId: catalogue.id,
    catalogueHash: catalogueHash(catalogue),
    announcerVoiceId: catalogue.reserved.announcer,
    narratorVoiceId: catalogue.reserved.narrator,
    characters: ordered.map((c) => chosen.get(c.id) ?? { characterId: c.id, voiceId: null, fit: null }),
  };
}

/** A Cast entry in the shape the database stores (kept structurally identical to `@midnight-radio/db`'s `CastMember`). */
export interface CastRecord {
  name: string;
  role: "announcer" | "narrator" | "character";
  aliases: string[];
  genderPresentation: string | null;
  ageBand: string | null;
  description: string | null;
  voiceId: string | null;
  voiceFit: VoiceFit | null;
  mentionCount: number;
  speaks: boolean;
}

export const ANNOUNCER_NAME = "Announcer";
export const NARRATOR_NAME = "Narrator";

/**
 * The complete Cast for a Book: the reserved Announcer and Narrator plus every inventory
 * character, with voices from `assignVoices`. Pure; saving it is the caller's job.
 */
export function buildCast(
  inventory: InventoryCharacter[],
  catalogue: VoiceCatalogue,
): { pin: { catalogueId: string; catalogueHash: string }; members: CastRecord[] } {
  const assignment = assignVoices(assignableFrom(inventory), catalogue);
  const byId = new Map(inventory.map((c) => [c.id, c]));
  const reservedMember = (role: "announcer" | "narrator", name: string, voiceId: string): CastRecord => ({
    name,
    role,
    aliases: [],
    genderPresentation: null,
    ageBand: null,
    description: null,
    voiceId,
    voiceFit: null,
    mentionCount: 0,
    speaks: true,
  });
  return {
    pin: { catalogueId: assignment.catalogueId, catalogueHash: assignment.catalogueHash },
    members: [
      reservedMember("announcer", ANNOUNCER_NAME, assignment.announcerVoiceId),
      reservedMember("narrator", NARRATOR_NAME, assignment.narratorVoiceId),
      ...assignment.characters.map((a): CastRecord => {
        const c = byId.get(a.characterId)!;
        return {
          name: c.name,
          role: "character",
          aliases: c.aliases,
          genderPresentation: c.genderPresentation,
          ageBand: c.ageBand,
          description: c.description,
          voiceId: a.voiceId,
          voiceFit: a.fit,
          mentionCount: c.mentionCount,
          speaks: c.speaks,
        };
      }),
    ],
  };
}

/** Adapter from the frozen inventory. */
export const assignableFrom = (inventory: InventoryCharacter[]): AssignableCharacter[] =>
  inventory.map(({ id, name, genderPresentation, ageBand, speaks, mentionCount }) => ({ id, name, genderPresentation, ageBand, speaks, mentionCount }));

/**
 * Offline catalogue for tests and the StubProvider. Real catalogues are pinned per TTS provider
 * and model (task 5.1); never use this one for paid synthesis.
 */
export const STUB_VOICE_CATALOGUE: VoiceCatalogue = {
  id: "stub-voices-1",
  provider: "stub",
  model: "stub-1",
  version: "1",
  seed: "midnight-radio-stub-seed-1",
  reserved: { announcer: "stub-announcer", narrator: "stub-narrator" },
  voices: [
    { id: "stub-announcer", name: "Announcer", gender: "masculine", ageBands: ["adult"] },
    { id: "stub-narrator", name: "Narrator", gender: "feminine", ageBands: ["adult"] },
    { id: "stub-f1", name: "Ada", gender: "feminine", ageBands: ["young-adult", "adult"] },
    { id: "stub-f2", name: "Beatrice", gender: "feminine", ageBands: ["adult", "older"] },
    { id: "stub-f3", name: "Clara", gender: "feminine", ageBands: ["teen", "young-adult"] },
    { id: "stub-f4", name: "Delia", gender: "feminine", ageBands: ["child", "teen"] },
    { id: "stub-m1", name: "Edmund", gender: "masculine", ageBands: ["young-adult", "adult"] },
    { id: "stub-m2", name: "Felix", gender: "masculine", ageBands: ["adult", "older"] },
    { id: "stub-m3", name: "Gideon", gender: "masculine", ageBands: ["teen", "young-adult"] },
    { id: "stub-m4", name: "Hugo", gender: "masculine", ageBands: ["child", "teen"] },
    { id: "stub-n1", name: "Ira", gender: "neutral", ageBands: ["adult"] },
    { id: "stub-n2", name: "Juno", gender: "neutral", ageBands: ["young-adult", "adult", "older"] },
  ],
};

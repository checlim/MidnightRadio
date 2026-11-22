import { createHash } from "node:crypto";
import { nameKey, type InventoryCharacter } from "./cast.js";
import {
  ANNOUNCER_NAME,
  NARRATOR_NAME,
  VoiceCatalogueSchema,
  catalogueHash,
  requireClonable,
  type CastRecord,
  type ClonableCatalogue,
  type Voice,
  type VoiceCatalogue,
  type VoiceGender,
} from "./voice.js";

/**
 * Each book's own voices: the series Announcer and Narrator, plus one voice designed for every
 * speaking character from the voice brief the LLM wrote. Pure; the worker designs the clips and
 * stores the catalogue under `<DATA_DIR>/voices/<bookId>/`.
 */

export interface DesignedVoice {
  id: string;
  /** The character's name. */
  name: string;
  gender: VoiceGender;
  ageBands: Voice["ageBands"];
  /** The voice brief the clip was designed from. */
  brief: string;
  clip: { file: string; sha256: string; transcript: string };
}

/** A stable, safe voice id for a character, e.g. `count-dracula-3f9a1c`. */
export function designedVoiceId(characterName: string): string {
  const slug =
    characterName
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40)
      .replace(/-+$/, "") || "voice";
  return `${slug}-${createHash("sha256").update(nameKey(characterName)).digest("hex").slice(0, 6)}`;
}

const AGE_BANDS: Record<string, Voice["ageBands"]> = {
  child: ["child"],
  teen: ["teen"],
  "young-adult": ["young-adult"],
  adult: ["adult"],
  older: ["older"],
};

/** The voice fields a character's inventory entry implies. Unstated gender reads as neutral. */
export function voiceTraits(c: Pick<InventoryCharacter, "genderPresentation" | "ageBand">): { gender: VoiceGender; ageBands: Voice["ageBands"] } {
  const gender: VoiceGender = c.genderPresentation === "feminine" || c.genderPresentation === "masculine" ? c.genderPresentation : "neutral";
  return { gender, ageBands: AGE_BANDS[c.ageBand] ?? [] };
}

/**
 * The book's catalogue: the series catalogue's Announcer and Narrator (with their clips, which the
 * worker copies next to the designed ones), the designed voices, and the series voice-clone pin
 * plus the voice-design pin. `version` counts redesigns, so every change gives a new content hash.
 */
export function bookVoiceCatalogue(input: {
  bookId: string;
  series: ClonableCatalogue;
  designPin: { name: string; revision: string; weightsSha256?: string | undefined };
  voices: readonly DesignedVoice[];
  version: number;
}): ClonableCatalogue {
  const { series } = input;
  const reserved = [series.reserved.announcer, series.reserved.narrator].map((id) => series.voices.find((v) => v.id === id)!);
  const clone = series.models?.find((m) => m.role === "voice-clone");
  const catalogue: VoiceCatalogue = {
    id: `book-${input.bookId}`,
    provider: series.provider,
    model: series.model,
    version: String(input.version),
    seed: series.seed,
    reserved: { ...series.reserved },
    models: [
      ...(clone ? [clone] : []),
      { role: "voice-design", name: input.designPin.name, revision: input.designPin.revision, ...(input.designPin.weightsSha256 ? { weightsSha256: input.designPin.weightsSha256 } : {}) },
    ],
    voices: [
      ...reserved,
      ...input.voices.map((v) => ({ id: v.id, name: v.name.slice(0, 100), gender: v.gender, ageBands: v.ageBands, description: v.brief, clip: v.clip })),
    ],
  };
  return requireClonable(VoiceCatalogueSchema.parse(catalogue));
}

/**
 * The Cast when every speaking character has a voice designed for them: the Announcer and
 * Narrator on the series voices, each speaking character on their own voice (fit "good"), silent
 * characters without one. Throws if a speaking character has no designed voice. Pure.
 */
export function buildDesignedCast(inventory: InventoryCharacter[], catalogue: ClonableCatalogue, voiceFor: ReadonlyMap<string, string>): { pin: { catalogueId: string; catalogueHash: string }; members: CastRecord[] } {
  const ids = new Set(catalogue.voices.map((v) => v.id));
  const reserved = (role: "announcer" | "narrator", name: string, voiceId: string): CastRecord => ({ name, role, aliases: [], genderPresentation: null, ageBand: null, description: null, voiceId, voiceFit: null, mentionCount: 0, speaks: true });
  const members: CastRecord[] = [reserved("announcer", ANNOUNCER_NAME, catalogue.reserved.announcer), reserved("narrator", NARRATOR_NAME, catalogue.reserved.narrator)];
  for (const c of [...inventory].sort((a, b) => b.mentionCount - a.mentionCount || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const voiceId = c.speaks ? voiceFor.get(c.id) : undefined;
    if (c.speaks && (!voiceId || !ids.has(voiceId))) throw new Error(`speaking character "${c.name}" has no designed voice`);
    members.push({
      name: c.name,
      role: "character",
      aliases: c.aliases,
      genderPresentation: c.genderPresentation,
      ageBand: c.ageBand,
      description: c.description,
      voiceId: voiceId ?? null,
      voiceFit: voiceId ? "good" : null,
      mentionCount: c.mentionCount,
      speaks: c.speaks,
      firstChapterIdx: c.firstChapterIdx,
    });
  }
  return { pin: { catalogueId: catalogue.id, catalogueHash: catalogueHash(catalogue) }, members };
}

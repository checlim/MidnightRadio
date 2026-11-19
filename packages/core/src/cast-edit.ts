import { AGE_BANDS, GENDER_PRESENTATIONS, nameKey, type AgeBand, type GenderPresentation, type InventoryCharacter } from "./cast.js";
import {
  CastingPausedError,
  VoiceCatalogueSchema,
  allocateVoices,
  byPriority,
  catalogueHash,
  isReservedName,
  rateVoice,
  type AssignableCharacter,
  type CastRecord,
  type VoiceCatalogue,
  type VoiceFit,
} from "./voice.js";

/**
 * Changes to a frozen Cast (Req 2.4, 2.5). Both are pure: they work out what should change and
 * refuse anything that would break the Cast's rules; the database layer applies the result and
 * enforces distinct voices again with its unique index.
 *
 * - `addToCast`: characters a chapter introduces get unused, non-reserved voices by the same rules
 *   as first casting. Existing members are never touched.
 * - `planVoiceEdits`: a person changes characters' voices. Voices stay distinct, reserved voices
 *   stay with the Announcer and Narrator, and only characters whose voice actually changes are
 *   reported, so only their lines are re-rendered.
 */

/** A Book's Cast as stored (structurally the same as `@midnight-radio/db`'s `StoredCast`). */
export interface FrozenCast {
  pin: { catalogueId: string; catalogueHash: string };
  announcer: CastRecord;
  narrator: CastRecord;
  characters: CastRecord[];
}

/** A new character from a later chapter: the inventory fields, without book-wide position. */
export type NewCharacter = Omit<InventoryCharacter, "firstChapterIdx">;

const members = (cast: FrozenCast): CastRecord[] => [cast.announcer, cast.narrator, ...cast.characters];
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** The catalogue must be the one the Cast was made with: same id and same content hash. */
function samePin(cast: FrozenCast, catalogue: VoiceCatalogue): boolean {
  return catalogue.id === cast.pin.catalogueId && catalogueHash(catalogue) === cast.pin.catalogueHash;
}

/**
 * Cast records for characters that are not in the Cast yet, in casting priority order. Speaking
 * newcomers take the best-suited voices nobody in the Cast holds; silent ones get no voice.
 * Throws CastingPausedError (nothing is added) when the catalogue is not the pinned one, a name
 * is reserved or already in the Cast, or there are not enough unused voices.
 */
export function addToCast(cast: FrozenCast, newcomers: NewCharacter[], catalogueInput: VoiceCatalogue): CastRecord[] {
  const catalogue = VoiceCatalogueSchema.parse(catalogueInput);
  if (!samePin(cast, catalogue)) {
    throw new CastingPausedError(
      "catalogue_changed",
      `This Book's Cast was made with voice catalogue "${cast.pin.catalogueId}" (${cast.pin.catalogueHash.slice(0, 12)}), which differs from the one loaded now ("${catalogue.id}"). ` +
        "New characters can only be added from the catalogue the Cast is pinned to.",
    );
  }

  const reserved = newcomers.filter((c) => isReservedName(c.name));
  if (reserved.length > 0) {
    throw new CastingPausedError(
      "reserved_name",
      `A new character is named "${reserved[0]!.name}", which is reserved for the radio Announcer or Narrator. Rename the character to continue.`,
      { names: reserved.map((c) => c.name) },
    );
  }

  // Every name and alias already in the Cast, so a newcomer cannot be a second copy of someone.
  const taken = new Set<string>();
  for (const m of members(cast)) {
    taken.add(nameKey(m.name));
    for (const a of m.aliases) taken.add(nameKey(a));
  }
  const seenIds = new Set<string>();
  const seenNames = new Set<string>();
  const clashes: string[] = [];
  for (const c of newcomers) {
    const key = nameKey(c.name);
    if (seenIds.has(c.id) || seenNames.has(key) || taken.has(key)) clashes.push(c.name);
    seenIds.add(c.id);
    seenNames.add(key);
  }
  if (clashes.length > 0) {
    throw new CastingPausedError(
      "duplicate_character",
      `"${clashes[0]}" is already in the Cast (by name or alias) or listed twice. Existing characters keep their voices; edit the Cast instead of adding them again.`,
      { names: clashes },
    );
  }

  const used = new Set(members(cast).flatMap((m) => (m.voiceId ? [m.voiceId] : [])));
  const pool = catalogue.voices
    .filter((v) => v.id !== catalogue.reserved.announcer && v.id !== catalogue.reserved.narrator && !used.has(v.id))
    .sort((a, b) => compare(a.id, b.id));
  const assignable: AssignableCharacter[] = newcomers.map(({ id, name, genderPresentation, ageBand, speaks, mentionCount }) => ({ id, name, genderPresentation, ageBand, speaks, mentionCount }));
  const ordered = [...assignable].sort(byPriority);
  const speakers = ordered.filter((c) => c.speaks);
  if (speakers.length > pool.length) {
    const left = speakers.slice(pool.length).map((c) => c.name);
    throw new CastingPausedError(
      "voices_exhausted",
      `This chapter introduces ${speakers.length} new speaking characters, but only ${pool.length} voices in the catalogue are unused. ` +
        `Existing voices are kept and never shared. Merge minor characters or free a voice by editing the Cast, then try again. First without a voice: ${left.slice(0, 3).join(", ")}.`,
      { needed: speakers.length, available: pool.length, names: left },
    );
  }
  const chosen = allocateVoices(speakers, pool, catalogue);

  const byId = new Map(newcomers.map((c) => [c.id, c]));
  return ordered.map((a): CastRecord => {
    const c = byId.get(a.id)!;
    const voice = chosen.get(c.id);
    return {
      name: c.name,
      role: "character",
      // Aliases another member already uses would make speakers ambiguous; they are dropped.
      aliases: c.aliases.filter((alias) => !taken.has(nameKey(alias)) && !seenNames.has(nameKey(alias))),
      genderPresentation: c.genderPresentation,
      ageBand: c.ageBand,
      description: c.description,
      voiceId: voice?.voiceId ?? null,
      voiceFit: voice?.fit ?? null,
      mentionCount: c.mentionCount,
      speaks: c.speaks,
    };
  });
}

export type CastEditErrorReason =
  | "catalogue_changed"
  | "unknown_character"
  | "reserved_role"
  | "silent_character"
  | "duplicate_edit"
  | "unknown_voice"
  | "reserved_voice"
  | "voice_taken";

/** A Cast edit was refused; nothing changes. The message is safe to show users. */
export class CastEditError extends Error {
  constructor(
    readonly reason: CastEditErrorReason,
    message: string,
    readonly names: string[] = [],
  ) {
    super(message);
    this.name = "CastEditError";
  }
}

export interface VoiceEdit {
  /** The character's name as shown in the Cast (matched by `nameKey`). */
  name: string;
  voiceId: string;
}

export interface VoiceChange {
  /** The stored name. */
  name: string;
  previousVoiceId: string;
  voiceId: string;
  voiceFit: VoiceFit;
}

const asGender = (g: string | null): GenderPresentation => ((GENDER_PRESENTATIONS as readonly string[]).includes(g ?? "") ? (g as GenderPresentation) : "unstated");
const asAge = (a: string | null): AgeBand => ((AGE_BANDS as readonly string[]).includes(a ?? "") ? (a as AgeBand) : "unknown");

/**
 * Check a set of voice edits against the frozen Cast and its pinned catalogue, and return only the
 * characters whose voice actually changes (in Cast order). Edits apply together, so two
 * characters can swap voices. Throws CastEditError if any edit is refused.
 */
export function planVoiceEdits(cast: FrozenCast, edits: VoiceEdit[], catalogueInput: VoiceCatalogue): VoiceChange[] {
  const catalogue = VoiceCatalogueSchema.parse(catalogueInput);
  if (!samePin(cast, catalogue)) {
    throw new CastEditError("catalogue_changed", `This Book's Cast is pinned to voice catalogue "${cast.pin.catalogueId}", not the one loaded now ("${catalogue.id}").`);
  }
  const reservedVoices = new Set([catalogue.reserved.announcer, catalogue.reserved.narrator, cast.announcer.voiceId, cast.narrator.voiceId]);
  const voices = new Map(catalogue.voices.map((v) => [v.id, v]));
  const byKey = new Map(cast.characters.map((c) => [nameKey(c.name), c]));

  const target = new Map<string, string>(); // stored name -> new voice id
  for (const edit of edits) {
    const key = nameKey(edit.name);
    if (isReservedName(edit.name) || key === nameKey(cast.announcer.name) || key === nameKey(cast.narrator.name)) {
      throw new CastEditError("reserved_role", `The ${edit.name} keeps its fixed voice and cannot be edited.`, [edit.name]);
    }
    const member = byKey.get(key);
    if (!member) throw new CastEditError("unknown_character", `"${edit.name}" is not in this Book's Cast.`, [edit.name]);
    if (!member.speaks || member.voiceId === null) {
      throw new CastEditError("silent_character", `"${member.name}" never speaks, so they have no voice to change.`, [member.name]);
    }
    if (target.has(member.name)) throw new CastEditError("duplicate_edit", `"${member.name}" is edited twice in one change.`, [member.name]);
    if (!voices.has(edit.voiceId)) throw new CastEditError("unknown_voice", `Voice "${edit.voiceId}" is not in the pinned voice catalogue.`, [member.name]);
    if (reservedVoices.has(edit.voiceId)) {
      throw new CastEditError("reserved_voice", `Voice "${edit.voiceId}" belongs to the Announcer or Narrator and cannot be given to a character.`, [member.name]);
    }
    target.set(member.name, edit.voiceId);
  }

  // Voices after every edit is applied: each must be held by one character only.
  const holder = new Map<string, string>();
  for (const c of cast.characters) {
    const voiceId = target.get(c.name) ?? c.voiceId;
    if (voiceId === null) continue;
    const other = holder.get(voiceId);
    if (other !== undefined) {
      const [edited, kept] = target.has(c.name) ? [c.name, other] : [other, c.name];
      throw new CastEditError("voice_taken", `Voice "${voiceId}" would be shared by "${edited}" and "${kept}". Every character needs a voice of their own.`, [edited, kept]);
    }
    holder.set(voiceId, c.name);
  }

  return cast.characters.flatMap((c): VoiceChange[] => {
    const voiceId = target.get(c.name);
    if (voiceId === undefined || voiceId === c.voiceId) return [];
    const { fit } = rateVoice({ genderPresentation: asGender(c.genderPresentation), ageBand: asAge(c.ageBand) }, voices.get(voiceId)!);
    return [{ name: c.name, previousVoiceId: c.voiceId!, voiceId, voiceFit: fit }];
  });
}

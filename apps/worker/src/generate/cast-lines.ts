import { nameKey, type Script, type ValidationCastMember } from "@midnight-radio/core";
import type { CastMember, StoredCast } from "@midnight-radio/db";
import type { PromptCastMember } from "@midnight-radio/llm";
import { segmentsInOrder } from "@midnight-radio/mix";
import type { RenderSegment } from "@midnight-radio/tts";

/** The characters as the adaptation prompt shows them (the prompt names Announcer and Narrator itself). Pure. */
export const promptCast = (cast: StoredCast): PromptCastMember[] =>
  cast.characters.map((c) => ({
    name: c.name,
    aliases: c.aliases,
    genderPresentation: c.genderPresentation,
    description: c.description,
    speaks: c.speaks,
    ...(c.firstChapterIdx != null ? { firstChapterIdx: c.firstChapterIdx } : {}),
  }));

/** The whole Cast as the fidelity gate checks speakers. Pure. */
export const validationCast = (cast: StoredCast): ValidationCastMember[] =>
  [cast.announcer, cast.narrator, ...cast.characters].map((m) => ({ name: m.name, role: m.role, speaks: m.speaks }));

/**
 * Every spoken segment of a Script with its Cast voice, keyed by the segment's path (the key the
 * mixer expects). Dialogue speakers are matched by `nameKey`, as the gate matches them, so a
 * validated Script always resolves; anything else throws. Pure.
 */
export function speechLines(script: Pick<Script, "coldOpen" | "scenes" | "close">, cast: StoredCast): RenderSegment[] {
  const byName = new Map<string, CastMember>([cast.announcer, cast.narrator, ...cast.characters].map((m) => [nameKey(m.name), m]));
  return segmentsInOrder(script).flatMap(({ ref, segment: s }) => {
    if (s.kind !== "announcer" && s.kind !== "narration" && s.kind !== "dialogue") return [];
    const member = s.kind === "announcer" ? cast.announcer : s.kind === "narration" ? cast.narrator : byName.get(nameKey(s.speaker));
    if (!member?.voiceId) throw new Error(`${ref.path}: "${s.kind === "dialogue" ? s.speaker : s.kind}" has no voice in the Cast`);
    return [{ id: ref.path, voiceId: member.voiceId, text: s.text, ...(s.delivery ? { delivery: s.delivery } : {}) }];
  });
}

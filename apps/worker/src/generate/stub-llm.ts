import { CLOSE_TAG, parseQuotes, type AdaptedScript } from "@midnight-radio/core";
import { SERIES_TITLE, StubLlmProvider, type LlmRequest } from "@midnight-radio/llm";

/**
 * An offline stand-in for the language model, for tests and for trying the whole flow with
 * `MIDNIGHT_STUB_PROVIDERS=1` (with the stub voices, which are tones). It never calls a paid API.
 *
 * Casting finds one character, "The Stranger". Adaptation is mechanical and still passes the
 * fidelity gate: every spoken quotation of the chapter, in order and word for word, becomes a
 * line by The Stranger, between a fixed cold open and close. It is not a real adaptation: who
 * says what is not worked out, and nothing is condensed.
 */

export const STUB_CHARACTER = "The Stranger";

function chapterText(user: string): string {
  const m = /<chapter_text>\n?([\s\S]*?)\n?<\/chapter_text>/.exec(user);
  return m?.[1] ?? "";
}

export function stubAdaptation(user: string): AdaptedScript {
  const episode = Number(/^Episode: (\d+)$/m.exec(user)?.[1] ?? "1");
  const text = chapterText(user);
  const speech = parseQuotes(text).quotes.filter((q) => q.kind === "speech");
  return {
    coldOpen: [
      { kind: "announcer", text: `Good evening. This is ${SERIES_TITLE}. Episode ${episode}.` },
      { kind: "music", cue: "theme" },
    ],
    scenes: [
      {
        id: "s1",
        segments: [
          { kind: "narration", text: "The story begins." },
          ...speech.map((q) => ({ kind: "dialogue" as const, speaker: STUB_CHARACTER, text: q.pieces.map((p) => text.slice(p.start, p.end)).join(" ") })),
        ],
      },
    ],
    close: [
      { kind: "announcer", text: `${CLOSE_TAG} to ${SERIES_TITLE}.` },
      { kind: "music", cue: "theme" },
    ],
  };
}

/**
 * Sound design in stub mode: the first effect in the library before the first segment, and the
 * first bed under the whole first scene, each with the chapter's opening words as evidence (which
 * are in the chapter, so they pass the evidence check). Nothing else is proposed.
 */
export function stubSoundDesign(user: string): { cues: unknown[]; ambience: unknown[] } {
  const evidence = chapterText(user).split(/\s+/).filter(Boolean).slice(0, 4).join(" ");
  const sfx = /use the id as sfxId\): ([a-z][a-z0-9_]+) \(/.exec(user)?.[1];
  const bed = /kind as shown\): sfx:([a-z][a-z0-9_]+)/.exec(user)?.[1];
  return {
    cues: sfx ? [{ scene: 0, beforeSegment: 0, sfxId: sfx, evidence }] : [],
    ambience: bed ? [{ scene: 0, fromSegment: 0, id: bed, gainDb: -18, evidence }] : [],
  };
}

export function stubLlm(): StubLlmProvider {
  return new StubLlmProvider((req: LlmRequest) => {
    if (req.jsonSchema.name === "voice_briefs") {
      // One plain brief per character listed ("- Name; …" lines), as the real model is asked to.
      const names = [...req.user.matchAll(/^- (.+?)(?: \(also: .*?\))?(?:;.*)?$/gm)].map((m) => m[1]!);
      return JSON.stringify({ voices: names.map((name) => ({ name, brief: `A clear, steady adult voice of middle pitch and even pace, for ${name}.`.slice(0, 300) })) });
    }
    if (req.jsonSchema.name === "chunk_characters") {
      return JSON.stringify({ characters: [{ name: STUB_CHARACTER, aliases: [], genderPresentation: "unstated", ageBand: "adult", description: "Speaks every line in stub mode.", speaks: true }] });
    }
    if (req.jsonSchema.name === "sound_design") return JSON.stringify(stubSoundDesign(req.user));
    return JSON.stringify(stubAdaptation(req.user));
  });
}

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

export function stubLlm(): StubLlmProvider {
  return new StubLlmProvider((req: LlmRequest) => {
    if (req.jsonSchema.name === "chunk_characters") {
      return JSON.stringify({ characters: [{ name: STUB_CHARACTER, aliases: [], genderPresentation: "unstated", ageBand: "adult", description: "Speaks every line in stub mode.", speaks: true }] });
    }
    return JSON.stringify(stubAdaptation(req.user));
  });
}

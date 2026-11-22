import { describe, expect, it } from "vitest";
import { fileProblem, shouldPoll, stateLabel, unfinishedChapters, voiceBrief, type BookView, type EpisodeView } from "./logic";

const voice = (id: string) => ({ id, name: id.toUpperCase(), gender: "neutral", ageBands: ["adult"], description: null });
const ep = (state: EpisodeView["state"], extra: Partial<EpisodeView> = {}): EpisodeView => ({ chapterId: "c", episodeNumber: 1, title: "I", stationId: "s", state, message: null, linesRendered: 0, linesTotal: 0, ...extra });
const book = (patch: Partial<BookView> = {}): BookView => ({
  id: "bk-0123456789abcdef",
  title: "Dracula",
  author: "Bram Stoker",
  charBudget: 60_000,
  charCeiling: 60_000,
  charsSpent: 0,
  chapters: [
    { number: 1, title: "I", words: 5000, episodes: [ep("ready")] },
    { number: 2, title: "II", words: 4000, episodes: [ep("not_started")] },
  ],
  cast: {
    announcerVoiceId: "ann",
    narratorVoiceId: "nar",
    characters: [
      { name: "Count Dracula", description: null, speaks: true, voiceId: "v1", voiceFit: "good" },
      { name: "Jonathan Harker", description: null, speaks: true, voiceId: "v2", voiceFit: "good" },
      { name: "The landlady", description: null, speaks: false, voiceId: null, voiceFit: null },
    ],
  },
  voices: ["ann", "nar", "v1", "v2", "v3"].map(voice),
  ...patch,
});

describe("studio logic", () => {
  it("checks a file before upload", () => {
    expect(fileProblem({ name: "Dracula.EPUB", size: 600_000 })).toBeNull();
    expect(fileProblem({ name: "dracula.pdf", size: 10 })).toBe("Choose an .epub file.");
    expect(fileProblem({ name: "big.epub", size: 20 * 1024 * 1024 + 1 })).toBe("The file is larger than 20 MB.");
    expect(fileProblem({ name: "empty.epub", size: 0 })).toBe("The file is empty.");
  });

  it("shows the voice description each character's voice was designed from", () => {
    const b = book({ voices: [{ ...voice("v1"), description: "A deep, slow, courtly old voice." }, voice("v2")] });
    expect(voiceBrief(b, { voiceId: "v1" })).toBe("A deep, slow, courtly old voice.");
    expect(voiceBrief(b, { voiceId: "v2" })).toBeNull(); // a voice without a description (e.g. a series voice)
    expect(voiceBrief(b, { voiceId: null })).toBeNull(); // does not speak
  });

  it("describes episode states, polls only while something is being made, and suggests unfinished chapters", () => {
    expect(stateLabel(ep("running", { linesRendered: 3, linesTotal: 26 }))).toBe("Recording: 3 of 26 lines");
    expect(stateLabel(ep("running"))).toBe("Writing the script");
    expect(stateLabel(ep("over_budget"))).toBe("Paused: budget reached");
    expect(shouldPoll(book())).toBe(false);
    expect(shouldPoll(book({ chapters: [{ number: 1, title: "I", words: 1, episodes: [ep("queued")] }] }))).toBe(true);
    expect(shouldPoll(null)).toBe(false);
    expect(unfinishedChapters(book())).toEqual([2]);
  });
});

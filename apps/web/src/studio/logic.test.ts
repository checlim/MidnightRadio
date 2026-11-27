import { describe, expect, it } from "vitest";
import { cancellableChapters, fileProblem, remixableChapters, shouldPoll, stageLines, stateLabel, unfinishedChapters, voiceBrief, type BookView, type EpisodeView } from "./logic";

const voice = (id: string) => ({ id, name: id.toUpperCase(), gender: "neutral", ageBands: ["adult"], description: null });
const ep = (state: EpisodeView["state"], extra: Partial<EpisodeView> = {}): EpisodeView => ({ chapterId: "c", episodeNumber: 1, title: "I", stationId: "s", state, message: null, linesRendered: 0, linesTotal: 0, revision: null, soundDesigned: false, hasScript: false, job: null, ...extra });
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
  it("shows each stage of a sound-designed job separately, and which chapters can be remixed or cancelled", () => {
    const job = (state: "queued" | "running", progress: NonNullable<EpisodeView["job"]>["progress"], cancelRequested = false): EpisodeView["job"] => ({ kind: "sound-design", state, message: null, cancelRequested, soundDesign: true, progress });
    const running = ep("ready", {
      hasScript: true,
      revision: 1,
      job: job("running", { library: { state: "done", done: 4, total: 4, message: "sound library lib-1 is ready" }, script: { state: "done", done: 0, total: 0, message: "1 sound(s) added" }, speech: { state: "running", done: 3, total: 9, message: null }, mix: { state: "pending", done: 0, total: 0, message: null } }),
    });
    expect(stageLines(running).map((l) => l.text)).toEqual(["Sound library: done 4/4 · sound library lib-1 is ready", "Script: done · 1 sound(s) added", "Speech: working 3/9", "Mix: waiting"]);
    expect(stageLines(ep("running"))).toEqual([]);
    expect(stateLabel(ep("ready", { revision: 2, soundDesigned: true }))).toBe("On air (revision 2, with sound design)");
    const b = book({ chapters: [{ number: 1, title: "I", words: 1, episodes: [running] }, { number: 2, title: "II", words: 1, episodes: [ep("not_started")] }] });
    expect(shouldPoll(b)).toBe(true); // a remix of an episode already on air is still being made
    expect(remixableChapters(b, new Set([1, 2]))).toEqual([1]);
    expect(cancellableChapters(b, new Set([1, 2]))).toEqual([1]);
    expect(cancellableChapters(book({ chapters: [{ number: 1, title: "I", words: 1, episodes: [{ ...running, job: job("running", {}, true) }] }] }), new Set([1]))).toEqual([]);
  });
});

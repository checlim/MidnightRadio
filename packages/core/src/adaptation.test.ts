import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_NARRATION_WORDS, checkAdaptationReply, checkAdaptationRules, mentionsEpisode, pathOf, wordCount, type AdaptedScript, type EpisodeInfo } from "./adaptation.js";

const EPISODE: EpisodeInfo = { bookId: "dracula", chapterId: "ch-1", episodeNumber: 1, seriesTitle: "Midnight Radio", chapterTitle: "Jonathan Harker's Journal" };

const reply = (patch: Partial<AdaptedScript> = {}): AdaptedScript => ({
  coldOpen: [{ kind: "announcer", text: "Good evening, listeners. This is Midnight Radio. Episode 1: Jonathan Harker's Journal." }, { kind: "music", cue: "theme" }],
  scenes: [
    {
      id: "s1",
      ambience: { kind: "sfx", id: "carriage_interior" },
      segments: [
        { kind: "narration", text: "Jonathan Harker rides east through the Borgo Pass as night falls." },
        { kind: "dialogue", speaker: "Jonathan Harker", text: "I must go on." },
        { kind: "narration", containsVerbatimQuote: true, text: Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ") },
      ],
    },
  ],
  close: [{ kind: "announcer", text: "Who waits at the castle door? Tune in next time to Midnight Radio." }, { kind: "music", cue: "theme" }],
  ...patch,
});
const check = (r: unknown, episode = EPISODE) => checkAdaptationReply(JSON.stringify(r), episode);

describe("checkAdaptationReply", () => {
  it("accepts a reply that meets every rule and adds the pipeline's ids", () => {
    const r = check(reply());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.script).toMatchObject({ bookId: "dracula", chapterId: "ch-1", episodeNumber: 1, scenes: [{ id: "s1", ambience: { kind: "sfx", id: "carriage_interior" } }] });
  });

  it("refuses text that is not JSON", () => {
    expect(checkAdaptationReply("Here is your script: {", EPISODE)).toEqual({ ok: false, issues: [{ path: "(reply)", message: "the reply was not valid JSON" }] });
  });

  it("refuses ids the model tries to set, unknown fields and unknown segment kinds", () => {
    for (const bad of [{ ...reply(), bookId: "other" }, { ...reply(), scenes: [{ id: "s1", segments: [{ kind: "song", text: "la" }] }] }, { ...reply(), coldOpen: [{ kind: "announcer", text: "Hi", volume: 11 }] }]) {
      const r = check(bad);
      expect(r.ok, JSON.stringify(bad).slice(0, 80)).toBe(false);
    }
  });

  it("applies the Script schema rules: announcer first, close with announcer and theme, unique scene ids", () => {
    const issues = (r: unknown) => {
      const c = check(r);
      return c.ok ? [] : c.issues.map((i) => `${i.path}: ${i.message}`);
    };
    expect(issues(reply({ coldOpen: [{ kind: "music", cue: "theme" }, { kind: "announcer", text: "Midnight Radio, Episode 1." }] }))).toEqual(["coldOpen[0]: first cold-open segment must be an announcer"]);
    expect(issues(reply({ close: [{ kind: "announcer", text: "Tune in next time." }] }))).toEqual(["close: close must contain a theme music cue"]);
    expect(issues(reply({ scenes: [...reply().scenes, { id: "s1", segments: [{ kind: "narration", text: "Later." }] }] }))).toEqual(['scenes[1].id: duplicate scene id "s1"']);
    expect(issues(reply({ scenes: [] }))[0]).toMatch(/^scenes:/);
  });

  it("reports schema problems before rule problems", () => {
    const r = check(reply({ scenes: [], close: [{ kind: "announcer", text: "Goodbye." }, { kind: "music", cue: "theme" }] }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.path)).toEqual(["scenes"]);
  });
});

describe("checkAdaptationRules", () => {
  const rules = (r: AdaptedScript, episode = EPISODE) => checkAdaptationRules(r, episode).map((i) => `${i.path}: ${i.message}`);
  const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join(" ");

  it("limits ordinary narration to 35 words but never a verbatim quote", () => {
    const at = (text: string, containsVerbatimQuote?: boolean) =>
      reply({ scenes: [{ id: "s1", segments: [{ kind: "narration", text, ...(containsVerbatimQuote ? { containsVerbatimQuote } : {}) }] }] });
    expect(rules(at(words(MAX_NARRATION_WORDS)))).toEqual([]);
    expect(rules(at(words(MAX_NARRATION_WORDS + 1)))).toEqual(["scenes[0].segments[0]: narration has 36 words; condense it to at most 35, or split it, keeping events in order"]);
    expect(rules(at(words(200), true))).toEqual([]);
    expect(rules(reply({ coldOpen: [{ kind: "announcer", text: "Midnight Radio. Episode 1." }, { kind: "narration", text: words(40) }] }))).toEqual(["coldOpen[1]: narration has 40 words; condense it to at most 35, or split it, keeping events in order"]);
  });

  it("requires the cold open to name the series and the episode number", () => {
    const open = (text: string) => reply({ coldOpen: [{ kind: "announcer", text }] });
    expect(rules(open("Good evening, this is midnight radio, episode one."))).toEqual([]);
    expect(rules(open("Midnight Radio presents Episode Number 1."))).toEqual([]);
    expect(rules(open("Good evening. Episode 1."))).toEqual(['coldOpen: the announcer\'s cold open must name the series, "Midnight Radio"']);
    expect(rules(open("Midnight Radio. Chapter 1."))).toEqual(['coldOpen: the announcer\'s cold open must say "Episode 1"']);
    expect(rules(open("Midnight Radio, episode 12."), { ...EPISODE, episodeNumber: 1 })).toEqual(['coldOpen: the announcer\'s cold open must say "Episode 1"']);
  });

  it("requires the close's announcer to say tune in next time", () => {
    expect(rules(reply({ close: [{ kind: "announcer", text: "TUNE IN NEXT TIME, if you dare!" }, { kind: "music", cue: "theme" }] }))).toEqual([]);
    expect(rules(reply({ close: [{ kind: "announcer", text: "Goodnight." }, { kind: "music", cue: "theme" }] }))).toEqual(['close: the announcer\'s close must end with "Tune in next time to Midnight Radio."']);
  });
});

describe("helpers", () => {
  it("counts whitespace-separated words", () => {
    expect([wordCount(""), wordCount("  one  "), wordCount("one two\nthree\tfour"), wordCount("well-known, it's")]).toEqual([0, 1, 4, 2]);
  });

  it("recognises the episode number in digits and words, and nothing else", () => {
    expect(mentionsEpisode("Episode 3", 3)).toBe(true);
    expect(mentionsEpisode("episode three", 3)).toBe(true);
    expect(mentionsEpisode("Episode 33", 3)).toBe(false);
    expect(mentionsEpisode("Episode 3", 33)).toBe(false);
    expect(mentionsEpisode("3 episodes", 3)).toBe(false);
    expect(mentionsEpisode("Episode 42", 42)).toBe(true);
  });

  it("formats issue paths", () => {
    expect([pathOf([]), pathOf(["scenes", 2, "segments", 4, "text"]), pathOf(["close"])]).toEqual(["(reply)", "scenes[2].segments[4].text", "close"]);
  });

  it("property: narration is refused exactly when it is ordinary and over 35 words", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 80 }), fc.boolean(), (n, quote) => {
        const r = reply({ scenes: [{ id: "s1", segments: [{ kind: "narration", text: Array.from({ length: n }, () => "x").join(" "), ...(quote ? { containsVerbatimQuote: true } : {}) }] }] });
        expect(checkAdaptationRules(r, EPISODE).length > 0).toBe(!quote && n > MAX_NARRATION_WORDS);
      }),
      { numRuns: 200 },
    );
  });
});

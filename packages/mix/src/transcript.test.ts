import type { Script, Segment } from "@midnight-radio/core";
import { describe, expect, it } from "vitest";
import { SAMPLE_RATE, buildTimeline, type SegmentAudio } from "./timeline.js";
import { chapterMarkers, ffmetadata, vttTime, webVtt } from "./transcript.js";

const script: Script = {
  bookId: "b",
  chapterId: "c",
  episodeNumber: 1,
  coldOpen: [{ kind: "announcer", text: "Good evening." }, { kind: "music", cue: "theme" }],
  scenes: [
    { id: "inn", title: "The inn", segments: [{ kind: "narration", text: "The inn." }, { kind: "dialogue", speaker: "Harker", text: "Is it <safe> & warm?\nYes." }] },
    { id: "road", segments: [{ kind: "sfx", sfxId: "wolves" }, { kind: "narration", containsVerbatimQuote: true, text: "Who goes there?" }] },
  ],
  close: [{ kind: "announcer", text: "Tune in next time." }],
};
const audio = (_r: unknown, s: Segment): SegmentAudio => (s.kind === "music" || s.kind === "sfx" ? { asset: { path: "x.wav", frames: SAMPLE_RATE * 2, loopable: false } } : { speech: { path: "s.wav", frames: SAMPLE_RATE } });
const t = buildTimeline(script, audio);

describe("vttTime", () => {
  it("formats hours, minutes, seconds and milliseconds", () => {
    expect([vttTime(0), vttTime(1234.4), vttTime(61_000), vttTime(3_723_456), vttTime(-5)]).toEqual(["00:00:00.000", "00:00:01.234", "00:01:01.000", "01:02:03.456", "00:00:00.000"]);
  });
});

describe("webVtt", () => {
  it("has one cue per spoken line at its timeline position, labelled with the speaker", () => {
    const vtt = webVtt(t);
    const cues = vtt.split("\n\n").slice(1).map((c) => c.trim()).filter((c) => c.length > 0);
    expect(vtt.startsWith("WEBVTT\n\n")).toBe(true);
    expect(cues).toEqual([
      "1\n00:00:00.000 --> 00:00:01.000\n<v Announcer>Good evening.",
      "2\n00:00:03.600 --> 00:00:04.600\n<v Narrator>The inn.",
      "3\n00:00:04.850 --> 00:00:05.850\n<v Harker>Is it &lt;safe&gt; &amp; warm? Yes.",
      "4\n00:00:08.450 --> 00:00:09.450\n<v Narrator>Who goes there?",
      "5\n00:00:10.050 --> 00:00:11.050\n<v Announcer>Tune in next time.",
    ]);
  });

  it("ends with a newline and separates cues by blank lines", () => {
    expect(webVtt(t).endsWith("Tune in next time.\n")).toBe(true);
    expect(webVtt(t)).not.toMatch(/\n\n\n/);
  });

  it("shifts every cue by the same offset", () => {
    expect(webVtt(t, { offsetMs: 25 })).toContain("00:00:03.625 --> 00:00:04.625");
  });
});

describe("chapterMarkers", () => {
  it("covers the episode with the cold open, each scene and the close, with no gaps", () => {
    const c = chapterMarkers(t);
    expect(c).toEqual([
      { title: "Cold open", startMs: 0, endMs: 3600 },
      { title: "The inn", startMs: 3600, endMs: 6450 },
      { title: "Scene 2", startMs: 6450, endMs: 10_050 },
      { title: "Close", startMs: 10_050, endMs: 11_050 },
    ]);
    for (let i = 1; i < c.length; i++) expect(c[i]!.startMs).toBe(c[i - 1]!.endMs);
    expect(c.at(-1)!.endMs).toBe(Math.round((t.totalFrames * 1000) / SAMPLE_RATE));
  });
});

describe("ffmetadata", () => {
  it("writes tags and chapters, escaping the format's special characters", () => {
    const m = ffmetadata({ title: "Ep 1; a=b #x", comment: "line\nbreak" }, [{ title: "Scene = 1", startMs: 0, endMs: 1000 }]);
    expect(m).toBe(";FFMETADATA1\ntitle=Ep 1\\; a\\=b \\#x\ncomment=line break\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Scene \\= 1\n");
  });
});

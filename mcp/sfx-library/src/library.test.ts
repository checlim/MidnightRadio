import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CatalogueFile, attributionOf, auditScript, getSfx, listMusicCues, searchSfx } from "./library.js";
import { CATALOGUE } from "./test-fixture.js";

describe("searchSfx", () => {
  it("ranks name matches above tags and prompts, and filters by kind and loopability", () => {
    expect(searchSfx(CATALOGUE, { query: "door" }).map((r) => r.id)).toEqual(["door_creak", "door_slam"]);
    expect(searchSfx(CATALOGUE, { query: "wooden" }).map((r) => r.id)).toEqual(["door_creak"]); // prompt only
    expect(searchSfx(CATALOGUE, { query: "interior" }).map((r) => r.id)).toEqual(["door_creak", "hearth"]); // tags
    expect(searchSfx(CATALOGUE, { query: "slam interior" }).map((r) => r.id)).toEqual(["door_slam", "door_creak", "hearth"]); // a name match beats a tag match
    expect(searchSfx(CATALOGUE, { query: "Rain, WINDOW!" }).map((r) => r.id)).toEqual(["rain"]);
    expect(searchSfx(CATALOGUE, { query: "", loopable: true }).map((r) => r.id)).toEqual(["hearth", "organ_drone", "rain"]);
    expect(searchSfx(CATALOGUE, { query: "", kind: "music" }).map((r) => r.id)).toEqual(["main_theme", "organ_drone"]);
    expect(searchSfx(CATALOGUE, { query: "ghost" })).toEqual([]);
  });

  it("returns summaries and respects the limit", () => {
    expect(searchSfx(CATALOGUE, { query: "rain" })[0]).toEqual({ id: "rain", kind: "sfx", title: "Rain", tags: ["weather"], durationMs: 28_000, loopable: true, licence: "Apache-2.0" });
    expect(searchSfx(CATALOGUE, { query: "", limit: 2 })).toHaveLength(2);
    expect(searchSfx(CATALOGUE, { query: "", limit: 500 })).toHaveLength(6);
  });
});

describe("getSfx and attribution", () => {
  it("gives the repo-relative path, level, loop flag, pinned cues and attribution", () => {
    expect(getSfx(CATALOGUE, "main_theme")).toMatchObject({ path: "assets/sfx/music/main_theme.wav", peakDb: -1, loopable: false, musicCues: ["theme"], attribution: "By Vox Mirabilis, CC0 1.0 (public domain dedication), from https://commons.wikimedia.org/wiki/File:Tutti-Bombwerk.wav, excerpt 12.0–32.0 s." });
    expect(getSfx(CATALOGUE, "nope")).toBeUndefined();
    expect(attributionOf(CATALOGUE.entries[0]!)).toBe("Generated for Midnight Radio with MOSS-SoundEffect-v2.0 (revision e35df4d), seed 1940; output licence Apache-2.0.");
    expect(attributionOf(CATALOGUE.entries[5]!)).toBe("Made for Midnight Radio by Midnight Radio; CC0-1.0.");
  });
});

describe("listMusicCues", () => {
  it("shows the pinned music per cue (null when none) and every loopable bed", () => {
    const r = listMusicCues(CATALOGUE);
    expect(r.cues.theme?.id).toBe("main_theme");
    expect(r.cues.sting).toBeNull();
    expect(r.cues.transition).toBeNull();
    expect(r.beds.map((b) => b.id)).toEqual(["hearth", "organ_drone", "rain"]);
  });
});

describe("auditScript", () => {
  const script = (sfxId: string) =>
    JSON.stringify({
      bookId: "b",
      chapterId: "c",
      episodeNumber: 1,
      coldOpen: [{ kind: "announcer", text: "Good evening." }],
      scenes: [{ id: "s1", ambience: { kind: "sfx", id: "rain" }, segments: [{ kind: "sfx", sfxId }] }],
      close: [{ kind: "announcer", text: "Goodnight." }, { kind: "music", cue: "theme" }],
    });

  it("uses the pipeline's own checks", () => {
    expect(auditScript(CATALOGUE, script("door_creak"))).toMatchObject({ ok: true, catalogueId: "midnight-radio-sfx-test", schemaErrors: [], issues: [] });
    const bad = auditScript(CATALOGUE, script("thunder"));
    expect(bad.ok).toBe(false);
    expect(bad.issues).toEqual([{ code: "unknown_id", id: "thunder", path: "scenes[0].segments[0]", message: '"thunder" is not in the sound library' }]);
    expect(auditScript(CATALOGUE, "[]")).toMatchObject({ ok: false, issues: [] });
    expect(auditScript(CATALOGUE, "[]").schemaErrors.length).toBeGreaterThan(0);
  });
});

describe("CatalogueFile", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mr-sfxlib-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("treats a missing index as an empty library, refuses an invalid one, and picks up changes", async () => {
    const path = join(dir, "index.json");
    const file = new CatalogueFile(path);
    expect(file.load().entries).toEqual([]);
    await writeFile(path, "{oops");
    expect(() => file.load()).toThrow(/not valid JSON/);
    await writeFile(path, JSON.stringify({ ...CATALOGUE, version: 2 }));
    expect(() => file.load()).toThrow(/not a valid sound library/);
    await writeFile(path, JSON.stringify(CATALOGUE));
    expect(file.load().entries).toHaveLength(6);
    await writeFile(path, JSON.stringify({ ...CATALOGUE, entries: CATALOGUE.entries.slice(0, 2), musicCues: {} }));
    const later = new Date(Date.now() + 5000);
    await utimes(path, later, later);
    expect(file.load().entries).toHaveLength(2);
  });
});

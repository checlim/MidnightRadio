import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogueHash, designedVoiceId, type InventoryCharacter } from "@midnight-radio/core";
import { DESIGN_SENTENCE, StubVoiceDesigner, checkDesignedClip } from "@midnight-radio/tts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DESIGN_SEEDS, VoiceDesignError, designBookVoices, designClip, loadBookCatalogue, readVoicesPlan, writeVoicesPlan } from "./book-voices.js";
import { voiceDeps } from "./test-support.js";

const ch = (id: string, name: string, speaks = true): InventoryCharacter => ({ id, name, aliases: [], genderPresentation: "masculine", ageBand: "older", description: `${name}.`, speaks, mentionCount: 3, firstChapterIdx: 0 });

describe("designing a book's voices", () => {
  let dir: string;
  let v: Awaited<ReturnType<typeof voiceDeps>>;
  const logs: string[] = [];
  const deps = () => ({ voicesRoot: v.voicesRoot, series: v.series, seriesDir: v.seriesDir, designPin: v.designPin, log: (m: string) => logs.push(m) });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mr-voices-"));
    v = await voiceDeps(dir);
    logs.length = 0;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("tries the next seed when a clip is unusable, and gives up with the reasons after the last", async () => {
    const designer = new StubVoiceDesigner(new Set([DESIGN_SEEDS[0]]));
    const clip = await designClip(join(dir, "b"), "count", "Count Dracula", "A deep, slow, courtly old voice.", designer, deps());
    expect(clip.seed).toBe(DESIGN_SEEDS[1]);
    expect(designer.requests.map((r) => [r.seed, r.text])).toEqual([
      [DESIGN_SEEDS[0], DESIGN_SENTENCE],
      [DESIGN_SEEDS[1], DESIGN_SENTENCE],
    ]);
    expect(logs).toEqual([expect.stringMatching(/seed 1940 gave an unusable clip \(nearly silent/)]);
    expect(checkDesignedClip(await readFile(join(dir, "b", clip.file))).ok).toBe(true);
    const hopeless = new StubVoiceDesigner(new Set(DESIGN_SEEDS));
    await expect(designClip(join(dir, "b"), "mina", "Mina", "A bright, quick young voice.", hopeless, deps())).rejects.toThrow(new VoiceDesignError('no usable voice for "Mina" after 3 tries (seed 1940: nearly silent (-120.0 dBFS); seed 1941: nearly silent (-120.0 dBFS); seed 1942: nearly silent (-120.0 dBFS))'));
  });

  it("writes the book's catalogue and clips, pins them, and on a rerun reuses every clip without the designer", async () => {
    const plan = { version: 1 as const, inventory: [ch("c1", "Count Dracula"), ch("c2", "Mina Harker"), ch("c3", "The landlady", false)], briefs: { "Count Dracula": "A deep, slow, courtly old voice.", "Mina Harker": "A bright, warm young woman's voice." } };
    const designer = new StubVoiceDesigner();
    const out = await designBookVoices("bk-1", plan, designer, deps());
    expect(out.clipDir).toBe(join(v.voicesRoot, "bk-1"));
    expect([...out.voiceFor]).toEqual([["c1", designedVoiceId("Count Dracula")], ["c2", designedVoiceId("Mina Harker")]]);
    expect(designer.requests.map((r) => r.instruct)).toEqual(["A deep, slow, courtly old voice.", "A bright, warm young woman's voice."]);
    for (const voice of out.catalogue.voices) expect(existsSync(join(out.clipDir, voice.clip.file))).toBe(true); // the series Announcer and Narrator are copied in
    const pin = { catalogueId: out.catalogue.id, catalogueHash: catalogueHash(out.catalogue) };
    const loaded = await loadBookCatalogue(v.voicesRoot, "bk-1", v.series, v.seriesDir, pin);
    expect(catalogueHash(loaded.catalogue)).toBe(pin.catalogueHash);

    const again = new StubVoiceDesigner();
    const rerun = await designBookVoices("bk-1", plan, again, deps());
    expect(again.requests).toEqual([]);
    expect(catalogueHash(rerun.catalogue)).toBe(pin.catalogueHash);

    await expect(loadBookCatalogue(v.voicesRoot, "bk-1", v.series, v.seriesDir, { ...pin, catalogueHash: "0".repeat(64) })).rejects.toThrow(/not the ones its Cast is pinned to/);
    await expect(loadBookCatalogue(v.voicesRoot, "bk-2", v.series, v.seriesDir, { catalogueId: "book-bk-2", catalogueHash: "0".repeat(64) })).rejects.toThrow(/voices are missing/);
  });

  it("uses the series voices for a book with no speaking characters, and for a book cast from them", async () => {
    const out = await designBookVoices("bk-3", { version: 1, inventory: [ch("c1", "A ghost", false)], briefs: {} }, null, deps());
    expect([out.catalogue.id, out.clipDir]).toEqual([v.series.id, v.seriesDir]);
    const loaded = await loadBookCatalogue(v.voicesRoot, "bk-3", v.series, v.seriesDir, { catalogueId: v.series.id, catalogueHash: catalogueHash(v.series) });
    expect(loaded.clipDir).toBe(v.seriesDir);
    await expect(designBookVoices("bk-4", { version: 1, inventory: [ch("c1", "Someone")], briefs: { Someone: "A plain, even adult voice." } }, null, deps())).rejects.toThrow(/no voice-design server/);
  });

  it("keeps the inventory and briefs, so a rerun repeats no LLM step", async () => {
    expect(await readVoicesPlan(v.voicesRoot, "bk-5")).toBeNull();
    await writeVoicesPlan(v.voicesRoot, "bk-5", [ch("c1", "Count Dracula")], new Map([["Count Dracula", "A deep, slow, courtly old voice."]]));
    expect(await readVoicesPlan(v.voicesRoot, "bk-5")).toEqual({ version: 1, inventory: [ch("c1", "Count Dracula")], briefs: { "Count Dracula": "A deep, slow, courtly old voice." } });
    await writeFile(join(v.voicesRoot, "bk-5", "voices-plan.json"), "{}");
    await expect(readVoicesPlan(v.voicesRoot, "bk-5")).rejects.toThrow();
  });
});

import { describe, expect, it } from "vitest";
import { buildDesignedCast, bookVoiceCatalogue, designedVoiceId, voiceTraits, type DesignedVoice } from "./book-voices.js";
import type { InventoryCharacter } from "./cast.js";
import { STUB_VOICE_CATALOGUE, catalogueHash, requireClonable } from "./voice.js";

const clip = (n: string) => ({ file: `clips/${n}.wav`, sha256: n.padEnd(64, "0").replace(/[^0-9a-f]/g, "a").slice(0, 64), transcript: "Good evening." });
const series = requireClonable({
  ...STUB_VOICE_CATALOGUE,
  models: [{ role: "voice-clone", name: "clone (float32)", revision: "c1" }],
  voices: STUB_VOICE_CATALOGUE.voices.map((v) => ({ ...v, description: "A voice.", clip: clip(v.id) })),
});
const ch = (id: string, name: string, extra: Partial<InventoryCharacter> = {}): InventoryCharacter => ({ id, name, aliases: [], genderPresentation: "masculine", ageBand: "older", description: `${name}.`, speaks: true, mentionCount: 5, firstChapterIdx: 0, ...extra });
const designed = (c: InventoryCharacter, n = 1): DesignedVoice => ({ id: designedVoiceId(c.name), name: c.name, ...voiceTraits(c), brief: `A designed voice for ${c.name}, version ${n}.`, clip: clip(`${c.id}${n}`) });

describe("a book's own voices", () => {
  it("gives every character a stable, safe voice id", () => {
    expect(designedVoiceId("Count Dracula")).toMatch(/^count-dracula-[0-9a-f]{6}$/);
    expect(designedVoiceId("count dracula")).toBe(designedVoiceId("Count Dracula"));
    expect(designedVoiceId("Dr. Van Helsing")).not.toBe(designedVoiceId("Van Helsing"));
    expect(designedVoiceId("Ägnes O’Brien")).toMatch(/^agnes-o-brien-[0-9a-f]{6}$/);
    expect(designedVoiceId("???")).toMatch(/^voice-[0-9a-f]{6}$/);
  });

  it("reads voice traits from the inventory; unstated gender is neutral, unknown age is no range", () => {
    expect(voiceTraits({ genderPresentation: "feminine", ageBand: "young-adult" })).toEqual({ gender: "feminine", ageBands: ["young-adult"] });
    expect(voiceTraits({ genderPresentation: "unstated", ageBand: "unknown" })).toEqual({ gender: "neutral", ageBands: [] });
  });

  it("builds the book's catalogue from the series Announcer and Narrator, the designed voices and both pins; a redesign changes its hash", () => {
    const count = ch("c1", "Count Dracula");
    const cat = bookVoiceCatalogue({ bookId: "bk-1", series, designPin: { name: "design (float32)", revision: "d1" }, voices: [designed(count)], version: 1 });
    expect(cat.id).toBe("book-bk-1");
    expect(cat.reserved).toEqual(series.reserved);
    expect(cat.voices.map((v) => v.id)).toEqual([series.reserved.announcer, series.reserved.narrator, designedVoiceId("Count Dracula")]);
    expect(cat.voices[0]!.clip).toEqual(series.voices.find((v) => v.id === series.reserved.announcer)!.clip);
    expect(cat.voices[2]).toMatchObject({ name: "Count Dracula", gender: "masculine", ageBands: ["older"], description: "A designed voice for Count Dracula, version 1." });
    expect(cat.models).toEqual([{ role: "voice-clone", name: "clone (float32)", revision: "c1" }, { role: "voice-design", name: "design (float32)", revision: "d1" }]);
    const again = bookVoiceCatalogue({ bookId: "bk-1", series, designPin: { name: "design (float32)", revision: "d1" }, voices: [designed(count, 2)], version: 2 });
    expect(catalogueHash(again)).not.toBe(catalogueHash(cat));
  });

  it("casts every speaking character on their own voice, silent ones on none, the reserved roles on the series voices", () => {
    const count = ch("c1", "Count Dracula", { mentionCount: 9 });
    const mina = ch("c2", "Mina Harker", { genderPresentation: "feminine", mentionCount: 12 });
    const landlady = ch("c3", "The landlady", { speaks: false, mentionCount: 1 });
    const cat = bookVoiceCatalogue({ bookId: "bk-1", series, designPin: { name: "d", revision: "d1" }, voices: [designed(count), designed(mina)], version: 1 });
    const { pin, members } = buildDesignedCast([count, mina, landlady], cat, new Map([["c1", designedVoiceId("Count Dracula")], ["c2", designedVoiceId("Mina Harker")]]));
    expect(pin).toEqual({ catalogueId: "book-bk-1", catalogueHash: catalogueHash(cat) });
    expect(members.map((m) => [m.role, m.name, m.voiceId, m.voiceFit])).toEqual([
      ["announcer", "Announcer", series.reserved.announcer, null],
      ["narrator", "Narrator", series.reserved.narrator, null],
      ["character", "Mina Harker", designedVoiceId("Mina Harker"), "good"],
      ["character", "Count Dracula", designedVoiceId("Count Dracula"), "good"],
      ["character", "The landlady", null, null],
    ]);
    expect(() => buildDesignedCast([count, mina], cat, new Map([["c1", designedVoiceId("Count Dracula")]]))).toThrow('speaking character "Mina Harker" has no designed voice');
  });
});

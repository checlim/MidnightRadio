import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VoiceCatalogueSchema,
  assignVoices,
  catalogueHash,
  requireClonable,
  type AssignableCharacter,
} from "@midnight-radio/core";
import { describe, expect, it } from "vitest";
import { WAV_BITS, WAV_CHANNELS, WAV_SAMPLE_RATE, validateWav } from "./wav.js";
/**
 * The committed Qwen3-TTS voice catalogue (assets/voices). Checks that it parses, that every
 * reference clip is the one it pins and is valid 24 kHz mono 16-bit audio, that it was assembled
 * from the committed designs, and that it can cast a book the size of Dracula without sharing a
 * voice or giving anyone a voice of the wrong gender. No model or service is needed.
 */
const here = dirname(fileURLToPath(import.meta.url));
const voicesDir = resolve(here, "../../../assets/voices");
const readJson = (name: string): unknown => JSON.parse(readFileSync(join(voicesDir, name), "utf8"));
const catalogue = requireClonable(VoiceCatalogueSchema.parse(readJson("catalogue.json")));
const designs = readJson("voices.json") as {
  referenceText: string;
  reserved: { announcer: string; narrator: string };
  voices: { id: string; name: string; gender: string; ageBands: string[]; description: string }[];
};
/**
 * Pin of the committed catalogue. A Cast stores this hash, so changing any voice, clip or model
 * pin must be deliberate: re-assemble, then update this value in the same commit.
 */
const PINNED_HASH = "37522d9f0045a3bb2de6b504f70e19339ebecc6a32b3c4890d6d854fcd121a90";
describe("committed voice catalogue", () => {
  it("is clonable and pins both Qwen3-TTS models by revision and weights hash", () => {
    expect(catalogue).toMatchObject({ provider: "qwen3-tts", model: "Qwen3-TTS-12Hz-1.7B-Base-bf16" });
    const roles = Object.fromEntries((catalogue.models ?? []).map((m) => [m.role, m]));
    expect(roles["voice-clone"]).toMatchObject({ name: catalogue.model, revision: "a6eb4f68e4b056f1215157bb696209bc82a6db48", weightsSha256: "81fb76175ff74e69be25fef2cc3e54f016df3034f1514c8e1c89da06a3510cff" });
    expect(roles["voice-design"]).toMatchObject({ name: "Qwen3-TTS-12Hz-1.7B-VoiceDesign-bf16", revision: "7d3824abff87e49756bb0f83fb5411de75d160c4", weightsSha256: "96ae28bec2205ec0b5e0c750bea2b8a5deac4f14d33a8a25a5f753299486b70e" });
  });
  it("has the reserved Announcer and Narrator plus at least 32 character voices", () => {
    expect(catalogue.reserved).toEqual(designs.reserved);
    const pool = catalogue.voices.filter((v) => v.id !== catalogue.reserved.announcer && v.id !== catalogue.reserved.narrator);
    expect(pool.length).toBeGreaterThanOrEqual(32);
    for (const gender of ["feminine", "masculine", "neutral"] as const) {
      expect(pool.some((v) => v.gender === gender)).toBe(true);
    }
    for (const band of ["child", "teen", "young-adult", "adult", "older"] as const) {
      expect(pool.some((v) => v.gender === "feminine" && v.ageBands.includes(band))).toBe(true);
      expect(pool.some((v) => v.gender === "masculine" && v.ageBands.includes(band))).toBe(true);
    }
  });
  it("matches the committed designs voice for voice", () => {
    expect(catalogue.voices.map((v) => v.id)).toEqual(designs.voices.map((v) => v.id));
    for (const [i, v] of catalogue.voices.entries()) {
      const d = designs.voices[i]!;
      expect({ name: v.name, gender: v.gender, ageBands: v.ageBands, description: v.description }).toEqual({ name: d.name, gender: d.gender, ageBands: d.ageBands, description: d.description });
      expect(v.clip.transcript).toBe(designs.referenceText);
    }
  });
  it("has exactly one valid 24 kHz mono 16-bit clip per voice, matching its pinned hash", () => {
    const files = catalogue.voices.map((v) => v.clip.file);
    expect(new Set(files).size).toBe(files.length);
    const onDisk = readdirSync(join(voicesDir, "clips")).filter((f) => !f.startsWith("."));
    expect(onDisk.map((f) => `clips/${f}`).sort()).toEqual([...files].sort());
    for (const v of catalogue.voices) {
      const bytes = readFileSync(join(voicesDir, v.clip.file));
      expect(createHash("sha256").update(bytes).digest("hex"), v.id).toBe(v.clip.sha256);
      const info = validateWav(bytes, { sampleRate: WAV_SAMPLE_RATE, channels: WAV_CHANNELS, bitsPerSample: WAV_BITS, maxDurationMs: 20_000 });
      // The reference sentence takes several seconds to say; much shorter means a truncated take.
      expect(info.durationMs, v.id).toBeGreaterThan(3_000);
    }
  });
  it("has a stable content hash, independent of voice order", () => {
    const hash = catalogueHash(catalogue);
    expect(catalogueHash({ ...catalogue, voices: [...catalogue.voices].reverse() })).toBe(hash);
    expect(hash).toBe(PINNED_HASH);
  });
  it("casts Dracula's speaking characters with distinct voices and no wrong-gender voice", () => {
    let n = 0;
    const ch = (name: string, genderPresentation: AssignableCharacter["genderPresentation"], ageBand: AssignableCharacter["ageBand"], mentionCount: number): AssignableCharacter => ({ id: `c${++n}`, name, genderPresentation, ageBand, speaks: true, mentionCount });
    const cast = [
      ch("Van Helsing", "masculine", "older", 900),
      ch("Jonathan Harker", "masculine", "young-adult", 800),
      ch("Mina Harker", "feminine", "young-adult", 750),
      ch("Dr. Seward", "masculine", "adult", 700),
      ch("Lucy Westenra", "feminine", "young-adult", 600),
      ch("Count Dracula", "masculine", "older", 550),
      ch("Arthur Holmwood", "masculine", "young-adult", 400),
      ch("Quincey Morris", "masculine", "young-adult", 300),
      ch("Renfield", "masculine", "adult", 250),
      ch("Mrs. Westenra", "feminine", "older", 120),
      ch("Mr. Swales", "masculine", "older", 60),
      ch("First Sister", "feminine", "young-adult", 30),
      ch("Second Sister", "feminine", "young-adult", 25),
      ch("Third Sister", "feminine", "young-adult", 20),
      ch("The Landlady", "feminine", "older", 15),
      ch("Sister Agatha", "feminine", "older", 12),
      ch("Mr. Hawkins", "masculine", "older", 10),
      ch("Thomas Bilder", "masculine", "adult", 10),
      ch("The Coachman", "masculine", "adult", 8),
      ch("Captain of the Demeter", "masculine", "adult", 8),
      ch("Lord Godalming's Servant", "masculine", "older", 5),
      ch("A Child", "unstated", "child", 3),
    ];
    const assignment = assignVoices(cast, catalogue);
    const voiceIds = assignment.characters.map((c) => c.voiceId);
    expect(voiceIds.every((id) => id !== null)).toBe(true);
    expect(new Set(voiceIds).size).toBe(cast.length);
    expect(voiceIds).not.toContain(catalogue.reserved.announcer);
    expect(voiceIds).not.toContain(catalogue.reserved.narrator);
    expect(assignment.characters.filter((c) => c.fit === "poor")).toEqual([]);
    // The main cast all get a voice of their stated gender and age.
    expect(assignment.characters.slice(0, 11).map((c) => c.fit)).toEqual(Array(11).fill("good"));
  });
});

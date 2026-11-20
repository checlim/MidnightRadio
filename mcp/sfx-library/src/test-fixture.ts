import type { SfxCatalogue, SfxEntry } from "@midnight-radio/core";

/** A small sound library for the tests: foley, beds, pinned and unpinned music, every source type. */
const H = "a".repeat(64);
const gen = (prompt: string) => ({ type: "generated", model: "MOSS-SoundEffect-v2.0", revision: "e35df4d", licence: "Apache-2.0", prompt, seed: 1940, originalSha256: H, generatedAt: "2026-11-20T10:00:00Z" }) as const;
const entry = (id: string, extra: Partial<SfxEntry> = {}): SfxEntry => ({ id, kind: "sfx", title: id.charAt(0).toUpperCase() + id.slice(1).replace(/_/g, " "), path: `foley/${id}.wav`, sha256: H, durationMs: 4000, loopable: false, peakDb: -1, tags: [], source: gen(`The sound of ${id.replace(/_/g, " ")}.`), ...extra });

export const CATALOGUE: SfxCatalogue = {
  version: 1,
  id: "midnight-radio-sfx-test",
  entries: [
    entry("door_creak", { tags: ["door", "interior"], source: gen("A heavy old wooden door creaks open slowly.") }),
    entry("door_slam", { tags: ["door"] }),
    entry("rain", { loopable: true, path: "beds/rain.wav", durationMs: 28_000, tags: ["weather"], source: gen("Steady heavy rain on a roof and window panes.") }),
    entry("hearth", { loopable: true, path: "beds/hearth.wav", durationMs: 28_000, tags: ["fire", "interior"] }),
    entry("main_theme", { kind: "music", path: "music/main_theme.wav", durationMs: 20_000, title: "Main theme", source: { type: "cc0", url: "https://commons.wikimedia.org/wiki/File:Tutti-Bombwerk.wav", author: "Vox Mirabilis", licence: "CC0-1.0", originalSha256: H, excerpt: { startMs: 12_000, durationMs: 20_000 } } }),
    entry("organ_drone", { kind: "music", loopable: true, path: "music/organ_drone.wav", durationMs: 30_000, source: { type: "project", author: "Midnight Radio", licence: "CC0-1.0" } }),
  ],
  musicCues: { theme: "main_theme" },
};


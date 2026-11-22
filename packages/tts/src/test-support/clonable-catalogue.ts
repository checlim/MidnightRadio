import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { STUB_VOICE_CATALOGUE, requireClonable, type ClonableCatalogue, type VoiceCatalogue } from "@midnight-radio/core";
import { encodeWav } from "../wav.js";

export const CLIP_TRANSCRIPT = "The night air is chill, and the hour is late.";

/** A tiny reference clip for a voice: distinct bytes per voice, so each has its own hash. */
export function clipBytes(voiceId: string): Buffer {
  const seed = [...voiceId].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1000, 7);
  return encodeWav(Int16Array.from({ length: 2400 }, (_, i) => ((i * (seed + 3)) % 2000) - 1000));
}

/** The stub catalogue with a description and reference clip for every voice, as a cloning provider needs. */
export function clonableStubCatalogue(patch: Partial<VoiceCatalogue> = {}): ClonableCatalogue {
  return requireClonable({
    ...STUB_VOICE_CATALOGUE,
    ...patch,
    voices: STUB_VOICE_CATALOGUE.voices.map((v) => ({
      ...v,
      description: `A designed voice for ${v.name}.`,
      clip: { file: `clips/${v.id}.wav`, sha256: createHash("sha256").update(clipBytes(v.id)).digest("hex"), transcript: CLIP_TRANSCRIPT },
    })),
  });
}

/** Write every voice's reference clip under `dir`, where the catalogue's clip paths point. */
export async function writeClips(dir: string, catalogue: ClonableCatalogue): Promise<void> {
  for (const v of catalogue.voices) {
    const path = join(dir, v.clip.file);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, clipBytes(v.id));
  }
}

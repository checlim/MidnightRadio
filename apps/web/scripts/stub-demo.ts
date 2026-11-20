/**
 * Development stations for the player, made offline with the StubProvider (test tones, no model,
 * no key): two short episodes through the real render cache and mixer, and one station that is
 * still "warming up". Writes episodes/ and stations.json into <DATA_DIR>/broadcast (served at
 * /broadcast/; DATA_DIR from the environment or the repo's .env); the real demo bundle (Task 12) replaces them.
 *
 *   pnpm --filter @midnight-radio/web demo:stub
 *
 * Lines are verbatim from the public-domain texts. Needs ffmpeg.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Script, SfxCatalogue } from "@midnight-radio/core";
import { mixEpisode, segmentsInOrder, type AudioFile } from "@midnight-radio/mix";
import { RenderCache, StubProvider, encodeWav, renderSegments } from "@midnight-radio/tts";
import { loadWebConfig } from "../src/server/config";

const web = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (existsSync(join(web, "../../.env"))) process.loadEnvFile(join(web, "../../.env"));
const pub = loadWebConfig(process.env, web).broadcastDir;
const RATE = 24_000;

const dracula: Script = {
  bookId: "dracula",
  chapterId: "dracula-2",
  episodeNumber: 2,
  coldOpen: [
    { kind: "announcer", text: "Good evening, listeners. This is Midnight Radio. Episode Two: Jonathan Harker's Journal, continued." },
    { kind: "music", cue: "theme" },
  ],
  scenes: [
    {
      id: "door",
      title: "The castle door",
      ambience: { kind: "sfx", id: "rain" },
      segments: [
        { kind: "narration", text: "At the door of the castle stands a tall old man, clean shaven save for a long white moustache." },
        { kind: "dialogue", speaker: "Count Dracula", text: "Welcome to my house! Enter freely and of your own will!", delivery: "sinister" },
        { kind: "dialogue", speaker: "Jonathan Harker", text: "Count Dracula?" },
        { kind: "dialogue", speaker: "Count Dracula", text: "I am Dracula; and I bid you welcome, Mr. Harker, to my house." },
      ],
    },
  ],
  close: [
    { kind: "announcer", text: "What does the Count want with a young English solicitor? Tune in next time to Midnight Radio." },
    { kind: "music", cue: "theme" },
  ],
};

const heart: Script = {
  bookId: "poe",
  chapterId: "telltale-heart",
  episodeNumber: 1,
  coldOpen: [
    { kind: "announcer", text: "Good evening. This is Midnight Radio. Episode One: The Telltale Heart." },
    { kind: "music", cue: "theme" },
  ],
  scenes: [
    {
      id: "chamber",
      title: "The old man's chamber",
      segments: [
        { kind: "narration", text: "At midnight a lantern opens a crack, and a single ray falls upon the old man's eye." },
        { kind: "dialogue", speaker: "The old man", text: "Who\u2019s there?", delivery: "fearful" },
        { kind: "pause", ms: 1200 },
        { kind: "narration", containsVerbatimQuote: true, text: "It is nothing but the wind in the chimney\u2014it is only a mouse crossing the floor," },
      ],
    },
  ],
  close: [
    { kind: "announcer", text: "And still the heart beats on. Tune in next time to Midnight Radio." },
    { kind: "music", cue: "theme" },
  ],
};

const VOICES: Record<string, string> = { Announcer: "stub-announcer", Narrator: "stub-narrator", "Count Dracula": "stub-m2", "Jonathan Harker": "stub-m1", "The old man": "stub-m4" };

async function main() {
  const work = await mkdtemp(join(tmpdir(), "mr-stub-demo-"));
  try {
    // A tiny synthetic sound library: a theme chord and a rain bed.
    const sfxDir = join(work, "sfx");
    await mkdir(join(sfxDir, "music"), { recursive: true });
    await mkdir(join(sfxDir, "beds"), { recursive: true });
    const wav = (seconds: number, f: (t: number) => number) => encodeWav(Int16Array.from({ length: Math.round(seconds * RATE) }, (_, i) => Math.round(f(i / RATE) * 32767)));
    let seed = 1940;
    const noise = () => ((seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
    await writeFile(join(sfxDir, "music/theme.wav"), wav(3, (t) => 0.25 * (Math.sin(2 * Math.PI * 196 * t) + Math.sin(2 * Math.PI * 233 * t) + Math.sin(2 * Math.PI * 294 * t)) * Math.min(1, t * 4, 3 - t)));
    await writeFile(join(sfxDir, "beds/rain.wav"), wav(4, () => 0.3 * noise()));
    const entry = (id: string, kind: "sfx" | "music", path: string, ms: number, loopable: boolean) => ({ id, kind, title: id, path, sha256: "0".repeat(64), durationMs: ms, loopable, peakDb: -1, tags: [], source: { type: "project" as const, author: "Midnight Radio (stub demo)", licence: "CC0-1.0" as const } });
    const sfx: SfxCatalogue = { version: 1, id: "stub-demo", entries: [entry("theme", "music", "music/theme.wav", 3000, false), entry("rain", "sfx", "beds/rain.wav", 4000, true)], musicCues: { theme: "theme" } };
    const cache = new RenderCache({ dir: join(work, "cache"), provider: new StubProvider() });

    const stations: unknown[] = [];
    for (const [id, script, book, author, title] of [
      ["dracula-2", dracula, "Dracula", "Bram Stoker", "Jonathan Harker\u2019s Journal (continued)"],
      ["telltale-heart", heart, "Short Fiction", "Edgar Allan Poe", "The Telltale Heart"],
    ] as const) {
      const lines = segmentsInOrder(script).flatMap(({ ref, segment: s }) => {
        if (s.kind !== "announcer" && s.kind !== "narration" && s.kind !== "dialogue") return [];
        const voiceId = VOICES[s.kind === "dialogue" ? s.speaker : s.kind === "announcer" ? "Announcer" : "Narrator"]!;
        return [{ id: ref.path, voiceId, text: s.text, ...(s.delivery ? { delivery: s.delivery } : {}) }];
      });
      const outcomes = await renderSegments(lines, { cache });
      const speech = new Map<string, AudioFile>(
        outcomes.map((o) => {
          if (o.status === "failed") throw new Error(o.error.message);
          return [o.id, { path: o.result.path, frames: o.result.info.frames }];
        }),
      );
      const outDir = join(pub, "episodes", id);
      await mkdir(outDir, { recursive: true });
      const episodeWork = join(work, id);
      await mkdir(episodeWork);
      const out = await mixEpisode({ script, speech, sfx, sfxDir, workDir: episodeWork, outDir, tags: { title: `Episode ${script.episodeNumber}: ${title}`, album: "Midnight Radio", artist: author, track: script.episodeNumber, aiDisclosure: "AI-generated stub demo: test tones, not real voices." } });
      stations.push({ status: "ready", id, book, author, episodeNumber: script.episodeNumber, title, durationMs: out.clean.durationMs, cleanUrl: `/broadcast/episodes/${id}/episode.mp3`, amUrl: `/broadcast/episodes/${id}/episode-am.mp3`, vttUrl: `/broadcast/episodes/${id}/episode.vtt` });
      console.log(`${id}: ${(out.clean.durationMs / 1000).toFixed(1)} s, clean ${out.clean.integratedLufs} LUFS, AM ${out.am.integratedLufs} LUFS`);
    }
    stations.push({ status: "warming", id: "dracula-3", book: "Dracula", author: "Bram Stoker", episodeNumber: 3, title: "Jonathan Harker\u2019s Journal (continued)", rendered: 47, total: 132 });
    await writeFile(join(pub, "stations.json"), `${JSON.stringify({ stations }, null, 2)}\n`);
    console.log(`wrote ${stations.length} stations to ${join(pub, "stations.json")}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

await main();

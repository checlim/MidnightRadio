import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEMO_DATA, FIXTURES, STUDIO_DATA } from "./paths";

/** Test media, made with ffmpeg: two 8 s MP3s (clean and AM) and a transcript with four lines. */
export { FIXTURES };

export default function globalSetup() {
  mkdirSync(FIXTURES, { recursive: true });
  // Every run starts with an empty radio and an empty studio.
  for (const dir of [DEMO_DATA, STUDIO_DATA]) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
  }
  const tone = (name: string, freq: number) =>
    execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", `sine=f=${freq}:r=44100:d=8`, "-ac", "1", "-c:a", "libmp3lame", "-b:a", "128k", join(FIXTURES, name)]);
  tone("clean.mp3", 440);
  tone("am.mp3", 660);
  writeFileSync(
    join(FIXTURES, "episode.vtt"),
    "WEBVTT\n\n1\n00:00:00.000 --> 00:00:02.000\n<v Announcer>Good evening, listeners.\n\n2\n00:00:02.000 --> 00:00:04.000\n<v Count Dracula>Welcome to my house!\n\n3\n00:00:04.000 --> 00:00:06.000\n<v Jonathan Harker>Count Dracula?\n\n4\n00:00:06.000 --> 00:00:08.000\n<v Narrator>The wolves howl below.\n",
  );
}

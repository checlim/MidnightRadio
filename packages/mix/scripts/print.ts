import type { MusicPickReport } from "../src/music-pick.js";

export function printMusic(report: MusicPickReport): void {
  for (const c of report.cues) {
    console.log(`${c.cue.padEnd(11)} ${c.picked ? `${c.picked.file} ${c.picked.startS}–${(c.picked.startS + c.picked.durationS).toFixed(1)} s (score ${c.picked.score})` : "—"}`);
    for (const k of c.candidates.filter((k) => k.rejected)) console.log(`${"".padEnd(12)}${k.file}: ${k.rejected}`);
  }
}

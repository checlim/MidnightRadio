import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateWav } from "@midnight-radio/tts";
import { z } from "zod";
import { findClicks } from "./assemble-sfx.js";

/**
 * Choosing foley takes without a listener (the user asked for a fully automatic flow). Pure
 * analysis of each take as the sound-effect service sent it, so the choice is repeatable and
 * explainable: every take's measurements and the reason it lost are recorded in
 * `assets/sfx/autopick.json`, and `picks.json` is written from the winners.
 *
 * A take is out if it misses its target length by more than 0.1 s, clips (more than 0.1 % of
 * samples at full scale), is near-silent (RMS below −45 dBFS), or (a one-off sound) is audible
 * for less than 15 % of its length, or (a bed) drops out for a second or more. The rest are
 * ranked by a score: fewer sudden clicks, a level near −20 dBFS, a prompt start for one-off
 * sounds, and a steady level for beds. Ties go to the lowest take number. Ears may disagree;
 * the record says why each take won, so a person can override it in `picks.json`.
 */

export const AUTOPICK_VERSION = "autopick-1";

export interface TakeMeasure {
  take: number;
  durationS: number;
  rmsDb: number;
  peakDb: number;
  clippedFraction: number;
  /** Share of 100 ms windows louder than −45 dBFS. */
  activeFraction: number;
  /** Seconds before the sound first rises above −45 dBFS. */
  leadSilenceS: number;
  /** Longest run below −50 dBFS, in seconds. */
  longestDropoutS: number;
  /** Spread (dB) of 500 ms window levels: low means steady. */
  levelSpreadDb: number;
  clicks: number;
}

export interface TakeVerdict extends TakeMeasure {
  rejected: string | null;
  score: number | null;
}

const db = (x: number) => (x <= 0 ? -Infinity : 20 * Math.log10(x));
const round = (x: number, d = 2) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

/** Read a mono 16-bit PCM WAV at whatever rate it has. */
export function readPcm16(bytes: Uint8Array): { samples: Int16Array; rate: number } {
  if (bytes.length < 28) throw new Error("not a WAV file");
  const rate = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(24, true);
  const info = validateWav(bytes, { sampleRate: rate, channels: 1, bitsPerSample: 16, maxDurationMs: 120_000, rejectSilence: false });
  const copy = bytes.slice(info.dataOffset, info.dataOffset + info.dataLength);
  return { samples: new Int16Array(copy.buffer, copy.byteOffset, info.frames), rate };
}

function windowsDb(s: Int16Array, rate: number, ms: number): number[] {
  const n = Math.max(1, Math.round((rate * ms) / 1000));
  const out: number[] = [];
  for (let i = 0; i + n <= s.length; i += n) {
    let sum = 0;
    for (let j = i; j < i + n; j++) sum += (s[j]! / 32768) ** 2;
    out.push(db(Math.sqrt(sum / n)));
  }
  return out;
}

/** Measurements of one take. Pure. */
export function measureTake(take: number, samples: Int16Array, rate: number): TakeMeasure {
  let sum = 0;
  let peak = 0;
  let clipped = 0;
  for (const v of samples) {
    const a = Math.abs(v);
    sum += (v / 32768) ** 2;
    if (a > peak) peak = a;
    if (a >= 32_700) clipped++;
  }
  const w100 = windowsDb(samples, rate, 100);
  const firstActive = w100.findIndex((d) => d > -45);
  let longest = 0;
  let run = 0;
  for (const d of w100) {
    run = d < -50 ? run + 1 : 0;
    longest = Math.max(longest, run);
  }
  const w500 = windowsDb(samples, rate, 500).filter((d) => Number.isFinite(d));
  const mean = w500.reduce((a, b) => a + b, 0) / Math.max(1, w500.length);
  const spread = Math.sqrt(w500.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, w500.length));
  return {
    take,
    durationS: round(samples.length / rate, 3),
    rmsDb: round(db(Math.sqrt(sum / Math.max(1, samples.length)))),
    peakDb: round(db(peak / 32768)),
    clippedFraction: round(clipped / Math.max(1, samples.length), 5),
    activeFraction: round(w100.filter((d) => d > -45).length / Math.max(1, w100.length), 3),
    leadSilenceS: firstActive === -1 ? round(samples.length / rate, 2) : round(firstActive * 0.1, 2),
    longestDropoutS: round(longest * 0.1, 2),
    levelSpreadDb: round(spread),
    clicks: findClicks(samples, rate).length,
  };
}

/** Accept or reject a take for its cue, and score it if accepted. Pure. */
export function judgeTake(m: TakeMeasure, cue: { durationSec: number; loopable: boolean }): TakeVerdict {
  const reject = (why: string): TakeVerdict => ({ ...m, rejected: why, score: null });
  if (Math.abs(m.durationS - cue.durationSec) > 0.1) return reject(`${m.durationS} s long, not ${cue.durationSec} s`);
  if (m.clippedFraction > 0.001) return reject(`clips (${(m.clippedFraction * 100).toFixed(2)} % of samples at full scale)`);
  if (!(m.rmsDb >= -45)) return reject(`nearly silent (${m.rmsDb} dBFS)`);
  if (!cue.loopable && m.activeFraction < 0.15) return reject(`audible for only ${Math.round(m.activeFraction * 100)} % of its length`);
  if (cue.loopable && m.longestDropoutS >= 1) return reject(`the bed drops out for ${m.longestDropoutS} s`);
  let score = 100 - 10 * m.clicks - 0.5 * Math.abs(m.rmsDb + 20);
  score -= cue.loopable ? 2 * m.levelSpreadDb : 5 * Math.min(m.leadSilenceS, 4);
  return { ...m, rejected: null, score: round(score) };
}

/** The winning take: highest score, then lowest take number. Null if every take was rejected. */
export function chooseTake(verdicts: readonly TakeVerdict[]): number | null {
  const ok = verdicts.filter((v) => v.score !== null).sort((a, b) => b.score! - a.score! || a.take - b.take);
  return ok[0]?.take ?? null;
}

const PromptsSchema = z.object({ version: z.literal(1), cues: z.array(z.object({ id: z.string(), prompt: z.string(), durationSec: z.number(), seed: z.number().int(), loopable: z.boolean() }).passthrough()) });
const TakesSchema = z.object({
  model: z.object({ model: z.string(), revision: z.string() }).passthrough(),
  takes: z.record(z.string(), z.record(z.string(), z.object({ prompt: z.string(), durationSec: z.number(), seed: z.number().int(), file: z.string().regex(/^take-\d+\.wav$/) }).passthrough())),
});

export interface AutopickReport {
  version: string;
  model: { model: string; revision: string };
  cues: { id: string; picked: number | null; reason: string; takes: TakeVerdict[] }[];
}

/**
 * Measure every take that belongs to the current prompts, choose one per cue, and return the
 * picks and the record. Takes made from an older prompt, duration or seed are ignored.
 */
export async function autopick(sfxDir: string, candidatesDir: string): Promise<{ picks: Record<string, number | null>; report: AutopickReport }> {
  const prompts = PromptsSchema.parse(JSON.parse(await readFile(join(sfxDir, "prompts.json"), "utf8")));
  const takes = TakesSchema.parse(JSON.parse(await readFile(join(candidatesDir, "takes.json"), "utf8")));
  const picks: Record<string, number | null> = {};
  const cues: AutopickReport["cues"] = [];
  for (const cue of prompts.cues) {
    const verdicts: TakeVerdict[] = [];
    for (const [n, t] of Object.entries(takes.takes[cue.id] ?? {}).sort((a, b) => Number(a[0]) - Number(b[0]))) {
      if (t.prompt !== cue.prompt || t.durationSec !== cue.durationSec || t.seed !== cue.seed + Number(n) - 1) continue;
      let verdict: TakeVerdict;
      try {
        const { samples, rate } = readPcm16(new Uint8Array(await readFile(join(candidatesDir, cue.id, t.file))));
        verdict = judgeTake(measureTake(Number(n), samples, rate), cue);
      } catch (err) {
        verdict = { take: Number(n), durationS: 0, rmsDb: -Infinity, peakDb: -Infinity, clippedFraction: 0, activeFraction: 0, leadSilenceS: 0, longestDropoutS: 0, levelSpreadDb: 0, clicks: 0, rejected: `unreadable (${(err as Error).message})`, score: null };
      }
      verdicts.push(verdict);
    }
    const picked = chooseTake(verdicts);
    picks[cue.id] = picked;
    const reason = verdicts.length === 0 ? "no takes for the current prompt" : picked === null ? "every take was rejected" : `take ${picked} scored highest (${verdicts.find((v) => v.take === picked)!.score})`;
    cues.push({ id: cue.id, picked, reason, takes: verdicts });
  }
  return { picks, report: { version: AUTOPICK_VERSION, model: { model: takes.model.model, revision: takes.model.revision }, cues } };
}

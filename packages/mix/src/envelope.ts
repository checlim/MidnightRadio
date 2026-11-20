/**
 * Ambience ducking (Task 9.2, Req 6.2). Pure. The timeline says exactly when someone speaks, so
 * instead of hoping a sidechain compressor reaches the required reduction, the bed's gain is a
 * computed envelope: full level between lines, `duckDb` below it during speech, reached
 * `attackMs` after a line starts, recovering over `releaseMs` after it ends, with fades at the
 * scene's edges. The reduction is then a property of the envelope, and Task 9.5 measures it in the
 * decoded audio anyway.
 */

export interface DuckingOptions {
  /** Gain change during speech. Default -18 dB, so the ≥12 dB requirement holds with margin. */
  duckDb?: number;
  attackMs?: number;
  releaseMs?: number;
  /** Fade in at the scene's start and out at its end. */
  fadeMs?: number;
  sampleRate?: number;
}

export const DUCKING_DEFAULTS = { duckDb: -18, attackMs: 40, releaseMs: 300, fadeMs: 500 } as const;

export const dbToGain = (db: number): number => 10 ** (db / 20);
export const gainToDb = (g: number): number => 20 * Math.log10(g);

/**
 * Gain for each sample of a scene's bed. `speech` holds ranges in timeline samples; only the
 * parts inside [sceneStart, sceneEnd) matter. Ranges closer together than attack + release stay
 * ducked between them, so the bed does not pump up for a moment between quick lines.
 */
export function duckingEnvelope(sceneStart: number, sceneEnd: number, speech: readonly { start: number; end: number }[], opts: DuckingOptions = {}): Float32Array {
  const rate = opts.sampleRate ?? 24_000;
  const duck = dbToGain(opts.duckDb ?? DUCKING_DEFAULTS.duckDb);
  const attack = Math.max(1, Math.round(((opts.attackMs ?? DUCKING_DEFAULTS.attackMs) * rate) / 1000));
  const release = Math.max(1, Math.round(((opts.releaseMs ?? DUCKING_DEFAULTS.releaseMs) * rate) / 1000));
  const length = Math.max(0, sceneEnd - sceneStart);
  const fade = Math.min(Math.round(((opts.fadeMs ?? DUCKING_DEFAULTS.fadeMs) * rate) / 1000), Math.floor(length / 2));
  const env = new Float32Array(length).fill(1);

  // Speech inside the scene, relative to its start, with short silences between lines merged.
  const ranges: { start: number; end: number }[] = [];
  for (const r of speech) {
    const start = Math.max(0, r.start - sceneStart);
    const end = Math.min(length, r.end - sceneStart);
    if (end <= start) continue;
    const last = ranges[ranges.length - 1];
    if (last && start - last.end < attack + release) last.end = Math.max(last.end, end);
    else ranges.push({ start, end });
  }
  for (const { start, end } of ranges) {
    // Attack: from full level to ducked over `attack` samples from the line's start.
    for (let i = start; i < Math.min(end, start + attack); i++) env[i] = Math.min(env[i]!, 1 - ((1 - duck) * (i - start + 1)) / attack);
    for (let i = start + attack; i < end; i++) env[i] = duck;
    // Release: back to full level after the line ends.
    for (let i = end; i < Math.min(length, end + release); i++) env[i] = Math.min(env[i]!, duck + ((1 - duck) * (i - end + 1)) / release);
  }
  // Scene fades multiply on top.
  for (let i = 0; i < fade; i++) {
    const g = (i + 1) / (fade + 1);
    env[i] = env[i]! * g;
    env[length - 1 - i] = env[length - 1 - i]! * g;
  }
  return env;
}

/** A mono 32-bit float WAV (format 3) of `samples`. */
export function encodeFloatWav(samples: Float32Array, sampleRate = 24_000): Buffer {
  const data = Buffer.alloc(samples.length * 4);
  for (let i = 0; i < samples.length; i++) data.writeFloatLE(samples[i]!, i * 4);
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(3, 20); // IEEE float
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 4, 28);
  h.writeUInt16LE(4, 32);
  h.writeUInt16LE(32, 34);
  h.write("data", 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

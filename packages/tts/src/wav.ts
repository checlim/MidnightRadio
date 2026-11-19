/**
 * Strict PCM WAV reading and writing (tech.md: "full PCM format/data-length/frame validation").
 *
 * Synthesised audio is untrusted, and a cache entry only counts if it passes `validateWav`.
 * The validator accepts exactly what the pipeline works with: a complete, canonical-enough
 * RIFF/WAVE file of 16-bit PCM at 24 kHz mono. Anything else is refused with a specific code.
 */

export const WAV_SAMPLE_RATE = 24_000;
export const WAV_CHANNELS = 1;
export const WAV_BITS = 16;

export type WavErrorCode =
  | "too_short" // smaller than a minimal header
  | "not_riff" // missing RIFF/WAVE signature
  | "size_mismatch" // RIFF size does not match the file: truncated, padded or streamed with an unknown size
  | "bad_chunk" // chunk overruns the file, duplicated, out of order, or too many
  | "missing_fmt"
  | "missing_data"
  | "unsupported_format" // not plain integer PCM
  | "wrong_format" // PCM, but not the required rate, channels or sample width
  | "bad_alignment" // data is not a whole number of frames
  | "empty" // no audio frames
  | "too_long"
  | "silent"; // every sample is zero

export class WavError extends Error {
  constructor(
    readonly code: WavErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WavError";
  }
}

export interface WavInfo {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  /** Sample frames (one 16-bit sample per frame for mono). */
  frames: number;
  durationMs: number;
  /** Byte offset of the first sample within the file. */
  dataOffset: number;
  dataLength: number;
  /** Largest absolute sample value, 0–32768. */
  peak: number;
}

export interface WavRequirements {
  sampleRate?: number;
  channels?: number;
  bitsPerSample?: number;
  /** Longest accepted audio. A single spoken line is never close to this. */
  maxDurationMs?: number;
  /** Refuse audio whose samples are all zero (a typical failed-synthesis output). Default true. */
  rejectSilence?: boolean;
}

const MAX_CHUNKS = 16;
const HEADER_MIN = 12 + 8 + 16 + 8; // RIFF header + fmt chunk + data chunk header

const tag = (b: Uint8Array, at: number) => String.fromCharCode(b[at]!, b[at + 1]!, b[at + 2]!, b[at + 3]!);

/**
 * Validate a complete WAV file and describe it. Throws WavError. Never reads outside `bytes`,
 * and never trusts a size field before checking it against the actual file length.
 */
export function validateWav(bytes: Uint8Array, req: WavRequirements = {}): WavInfo {
  const wantRate = req.sampleRate ?? WAV_SAMPLE_RATE;
  const wantChannels = req.channels ?? WAV_CHANNELS;
  const wantBits = req.bitsPerSample ?? WAV_BITS;
  const maxMs = req.maxDurationMs ?? 10 * 60_000;

  if (bytes.length < HEADER_MIN) throw new WavError("too_short", `WAV is only ${bytes.length} bytes`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (tag(bytes, 0) !== "RIFF" || tag(bytes, 8) !== "WAVE") throw new WavError("not_riff", "missing RIFF/WAVE signature");
  const riffSize = view.getUint32(4, true);
  if (riffSize + 8 !== bytes.length) {
    throw new WavError("size_mismatch", `RIFF declares ${riffSize + 8} bytes but the file has ${bytes.length}`);
  }

  let fmt: { channels: number; sampleRate: number; bits: number } | undefined;
  let data: { offset: number; length: number } | undefined;
  let offset = 12;
  let chunks = 0;
  while (offset < bytes.length) {
    if (++chunks > MAX_CHUNKS) throw new WavError("bad_chunk", "too many chunks");
    if (offset + 8 > bytes.length) throw new WavError("bad_chunk", "a chunk header is cut off");
    const id = tag(bytes, offset);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    if (body + size > bytes.length) throw new WavError("bad_chunk", `chunk "${id}" runs past the end of the file`);

    if (id === "fmt ") {
      if (fmt) throw new WavError("bad_chunk", "duplicate fmt chunk");
      if (data) throw new WavError("bad_chunk", "fmt chunk after data chunk");
      if (size !== 16 && size !== 18) throw new WavError("unsupported_format", `fmt chunk of ${size} bytes is not plain PCM`);
      const format = view.getUint16(body, true);
      if (format !== 1) throw new WavError("unsupported_format", `audio format ${format} is not integer PCM`);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const byteRate = view.getUint32(body + 8, true);
      const blockAlign = view.getUint16(body + 12, true);
      const bits = view.getUint16(body + 14, true);
      if (size === 18 && view.getUint16(body + 16, true) !== 0) throw new WavError("unsupported_format", "fmt extension is not empty");
      if (channels !== wantChannels || sampleRate !== wantRate || bits !== wantBits) {
        throw new WavError("wrong_format", `expected ${wantRate} Hz, ${wantChannels} channel(s), ${wantBits}-bit; got ${sampleRate} Hz, ${channels} channel(s), ${bits}-bit`);
      }
      if (blockAlign !== (channels * bits) / 8 || byteRate !== sampleRate * blockAlign) {
        throw new WavError("wrong_format", "block alignment or byte rate does not match the format");
      }
      fmt = { channels, sampleRate, bits };
    } else if (id === "data") {
      if (data) throw new WavError("bad_chunk", "duplicate data chunk");
      if (!fmt) throw new WavError("missing_fmt", "data chunk before fmt chunk");
      data = { offset: body, length: size };
    }
    offset = body + size + (size % 2); // chunks are padded to an even size
  }
  if (offset !== bytes.length) throw new WavError("bad_chunk", "chunks do not end exactly at the end of the file");
  if (!fmt) throw new WavError("missing_fmt", "no fmt chunk");
  if (!data) throw new WavError("missing_data", "no data chunk");

  const frameBytes = (fmt.channels * fmt.bits) / 8;
  if (data.length % frameBytes !== 0) throw new WavError("bad_alignment", `${data.length} data bytes is not a whole number of ${frameBytes}-byte frames`);
  const frames = data.length / frameBytes;
  if (frames === 0) throw new WavError("empty", "no audio frames");
  const durationMs = Math.round((frames / fmt.sampleRate) * 1000);
  if (durationMs > maxMs) throw new WavError("too_long", `${durationMs} ms is longer than the ${maxMs} ms limit`);

  // 16-bit samples, read through the DataView so no alignment of the underlying buffer is assumed.
  let peak = 0;
  for (let i = 0; i < data.length; i += 2) {
    const s = Math.abs(view.getInt16(data.offset + i, true));
    if (s > peak) peak = s;
  }
  if (peak === 0 && (req.rejectSilence ?? true)) throw new WavError("silent", "every sample is zero");

  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bitsPerSample: fmt.bits, frames, durationMs, dataOffset: data.offset, dataLength: data.length, peak };
}

/** Write mono 16-bit PCM as a canonical 44-byte-header WAV. */
export function encodeWav(samples: Int16Array, sampleRate: number = WAV_SAMPLE_RATE): Buffer {
  const dataLength = samples.length * 2;
  const out = Buffer.alloc(44 + dataLength);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + dataLength, 4);
  out.write("WAVE", 8, "ascii");
  out.write("fmt ", 12, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); // PCM
  out.writeUInt16LE(1, 22); // mono
  out.writeUInt32LE(sampleRate, 24);
  out.writeUInt32LE(sampleRate * 2, 28); // byte rate
  out.writeUInt16LE(2, 32); // block align
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(dataLength, 40);
  for (let i = 0; i < samples.length; i++) out.writeInt16LE(samples[i]!, 44 + i * 2);
  return out;
}

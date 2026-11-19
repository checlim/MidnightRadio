import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { encodeWav, validateWav, WavError, type WavErrorCode } from "./wav.js";

/** A RIFF/WAVE file from raw chunks, with a correct RIFF size. */
function riff(chunks: Buffer[], overrideSize?: number): Buffer {
  const body = Buffer.concat([Buffer.from("WAVE"), ...chunks]);
  const head = Buffer.alloc(8);
  head.write("RIFF", 0, "ascii");
  head.writeUInt32LE(overrideSize ?? body.length, 4);
  return Buffer.concat([head, body]);
}
const chunk = (id: string, body: Buffer, declaredSize = body.length): Buffer => {
  const h = Buffer.alloc(8);
  h.write(id, 0, "ascii");
  h.writeUInt32LE(declaredSize, 4);
  return Buffer.concat([h, body, body.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);
};
const fmtBody = (o: { format?: number; channels?: number; rate?: number; bits?: number; blockAlign?: number; byteRate?: number; extra?: Buffer } = {}) => {
  const channels = o.channels ?? 1;
  const rate = o.rate ?? 24_000;
  const bits = o.bits ?? 16;
  const blockAlign = o.blockAlign ?? (channels * bits) / 8;
  const b = Buffer.alloc(16);
  b.writeUInt16LE(o.format ?? 1, 0);
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(rate, 4);
  b.writeUInt32LE(o.byteRate ?? rate * blockAlign, 8);
  b.writeUInt16LE(blockAlign, 12);
  b.writeUInt16LE(bits, 14);
  return o.extra ? Buffer.concat([b, o.extra]) : b;
};
const pcm = (frames: number, value = 1000) => {
  const b = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) b.writeInt16LE(value, i * 2);
  return b;
};
const good = (frames = 240) => riff([chunk("fmt ", fmtBody()), chunk("data", pcm(frames))]);

function code(fn: () => unknown): WavErrorCode | "ok" {
  try {
    fn();
    return "ok";
  } catch (e) {
    if (e instanceof WavError) return e.code;
    throw e;
  }
}

describe("validateWav accepts what the pipeline works with", () => {
  it("describes a canonical file", () => {
    const wav = encodeWav(Int16Array.from([0, 100, -32768, 5]));
    expect(wav).toHaveLength(44 + 8);
    expect(validateWav(wav)).toEqual({ sampleRate: 24_000, channels: 1, bitsPerSample: 16, frames: 4, durationMs: 0, dataOffset: 44, dataLength: 8, peak: 32768 });
    expect(validateWav(good(24_000)).durationMs).toBe(1000);
  });

  it("tolerates extra chunks, odd-sized chunks with padding, and an 18-byte fmt chunk", () => {
    const list = chunk("LIST", Buffer.from("INFOx")); // 5 bytes + 1 pad
    expect(code(() => validateWav(riff([chunk("fmt ", fmtBody()), list, chunk("data", pcm(100)), chunk("id3 ", Buffer.from("abc"))])))).toBe("ok");
    expect(code(() => validateWav(riff([chunk("fmt ", fmtBody({ extra: Buffer.alloc(2) })), chunk("data", pcm(100))])))).toBe("ok");
  });

  it("works on a Buffer that is a slice of a larger allocation", () => {
    const wav = good();
    const padded = Buffer.concat([Buffer.alloc(7, 0xaa), wav, Buffer.alloc(5, 0xbb)]);
    expect(validateWav(padded.subarray(7, 7 + wav.length)).frames).toBe(240);
  });
});

describe("validateWav refuses everything else, with a specific code", () => {
  it.each<[string, () => Uint8Array, WavErrorCode]>([
    ["a file too small to hold a header", () => Buffer.alloc(20), "too_short"],
    ["no RIFF signature", () => Buffer.from(good()).fill("RIFX", 0, 4, "ascii"), "not_riff"],
    ["no WAVE form type", () => Buffer.from(good()).fill("AVI ", 8, 12, "ascii"), "not_riff"],
    ["a truncated file", () => good().subarray(0, good().length - 2), "size_mismatch"],
    ["bytes after the end", () => Buffer.concat([good(), Buffer.from([0])]), "size_mismatch"],
    ["a streamed file with an unknown RIFF size", () => riff([chunk("fmt ", fmtBody()), chunk("data", pcm(50))], 0xffffffff), "size_mismatch"],
    ["a data chunk that claims more than the file holds", () => riff([chunk("fmt ", fmtBody()), chunk("data", pcm(50), 10_000)]), "bad_chunk"],
    ["a duplicate fmt chunk", () => riff([chunk("fmt ", fmtBody()), chunk("fmt ", fmtBody()), chunk("data", pcm(50))]), "bad_chunk"],
    ["a duplicate data chunk", () => riff([chunk("fmt ", fmtBody()), chunk("data", pcm(50)), chunk("data", pcm(50))]), "bad_chunk"],
    ["a data chunk before the fmt chunk", () => riff([chunk("data", pcm(50)), chunk("fmt ", fmtBody())]), "missing_fmt"],
    ["too many chunks", () => riff([chunk("fmt ", fmtBody()), ...Array.from({ length: 20 }, () => chunk("junk", Buffer.alloc(2))), chunk("data", pcm(50))]), "bad_chunk"],
    ["leftover bytes that are not a chunk", () => Buffer.concat([riff([chunk("fmt ", fmtBody()), chunk("data", pcm(50))], 36 + 100 + 3), Buffer.alloc(3)]), "bad_chunk"],
    ["no fmt chunk", () => riff([chunk("LIST", Buffer.from("INFOabcd")), chunk("LIST", Buffer.from("INFOabcd"))]), "missing_fmt"],
    ["no data chunk", () => riff([chunk("fmt ", fmtBody()), chunk("LIST", Buffer.from("INFOabcd"))]), "missing_data"],
    ["floating-point samples", () => riff([chunk("fmt ", fmtBody({ format: 3, bits: 32, blockAlign: 4 })), chunk("data", pcm(50))]), "unsupported_format"],
    ["WAVE_FORMAT_EXTENSIBLE", () => riff([chunk("fmt ", fmtBody({ format: 0xfffe })), chunk("data", pcm(50))]), "unsupported_format"],
    ["a fmt chunk of an unexpected size", () => riff([chunk("fmt ", fmtBody({ extra: Buffer.alloc(24) })), chunk("data", pcm(50))]), "unsupported_format"],
    ["a non-empty fmt extension", () => riff([chunk("fmt ", fmtBody({ extra: Buffer.from([1, 0]) })), chunk("data", pcm(50))]), "unsupported_format"],
    ["44.1 kHz audio", () => riff([chunk("fmt ", fmtBody({ rate: 44_100 })), chunk("data", pcm(50))]), "wrong_format"],
    ["stereo audio", () => riff([chunk("fmt ", fmtBody({ channels: 2 })), chunk("data", pcm(50))]), "wrong_format"],
    ["8-bit audio", () => riff([chunk("fmt ", fmtBody({ bits: 8 })), chunk("data", pcm(50))]), "wrong_format"],
    ["24-bit audio", () => riff([chunk("fmt ", fmtBody({ bits: 24 })), chunk("data", pcm(50))]), "wrong_format"],
    ["a wrong block alignment", () => riff([chunk("fmt ", fmtBody({ blockAlign: 4 })), chunk("data", pcm(50))]), "wrong_format"],
    ["a wrong byte rate", () => riff([chunk("fmt ", fmtBody({ byteRate: 1234 })), chunk("data", pcm(50))]), "wrong_format"],
    ["half a sample at the end", () => riff([chunk("fmt ", fmtBody()), chunk("data", Buffer.concat([pcm(50), Buffer.from([7])]))]), "bad_alignment"],
    ["no audio frames", () => riff([chunk("fmt ", fmtBody()), chunk("data", Buffer.alloc(0))]), "empty"],
    ["only silence", () => riff([chunk("fmt ", fmtBody()), chunk("data", pcm(500, 0))]), "silent"],
  ])("rejects %s", (_label, build, expected) => {
    expect(code(() => validateWav(build()))).toBe(expected);
  });

  it("applies limits and options", () => {
    expect(code(() => validateWav(good(24_000), { maxDurationMs: 999 }))).toBe("too_long");
    expect(code(() => validateWav(good(24_000), { maxDurationMs: 1000 }))).toBe("ok");
    const silent = riff([chunk("fmt ", fmtBody()), chunk("data", pcm(500, 0))]);
    expect(code(() => validateWav(silent, { rejectSilence: false }))).toBe("ok");
    const stereo44 = riff([chunk("fmt ", fmtBody({ rate: 44_100, channels: 2 })), chunk("data", Buffer.concat([pcm(50), pcm(50)]))]);
    expect(validateWav(stereo44, { sampleRate: 44_100, channels: 2 }).frames).toBe(50);
  });

  it("does not trust size fields: a huge declared size cannot read past the file", () => {
    const evil = riff([chunk("fmt ", fmtBody()), chunk("data", pcm(10), 0xffffffff)]);
    expect(code(() => validateWav(evil))).toBe("bad_chunk");
  });
});

describe("property: validateWav and encodeWav", () => {
  const samples = fc.array(fc.integer({ min: -32768, max: 32767 }), { minLength: 1, maxLength: 600 }).filter((xs) => xs.some((x) => x !== 0));

  it("every encoded clip validates and reads back exactly", () => {
    fc.assert(
      fc.property(samples, (xs) => {
        const wav = encodeWav(Int16Array.from(xs));
        const info = validateWav(wav);
        expect(info.frames).toBe(xs.length);
        expect(info.dataLength).toBe(xs.length * 2);
        expect(info.peak).toBe(Math.max(...xs.map(Math.abs)));
        expect(info.durationMs).toBe(Math.round((xs.length / 24_000) * 1000));
        const back = Array.from({ length: xs.length }, (_, i) => wav.readInt16LE(info.dataOffset + i * 2));
        expect(back).toEqual(xs);
      }),
      { numRuns: 300 },
    );
  });

  it("every truncation and every extension of a valid file is refused", () => {
    fc.assert(
      fc.property(samples, fc.nat({ max: 5 }), fc.double({ min: 0, max: 0.999999, noNaN: true }), (xs, extra, where) => {
        const wav = encodeWav(Int16Array.from(xs));
        const cut = Math.floor(where * wav.length); // 0 up to length - 1: always a strict prefix
        expect(code(() => validateWav(wav.subarray(0, cut)))).not.toBe("ok");
        if (extra > 0) expect(code(() => validateWav(Buffer.concat([wav, Buffer.alloc(extra)])))).not.toBe("ok");
      }),
      { numRuns: 300 },
    );
  });

  it("changing any single header byte to any other value is refused", () => {
    const wav = encodeWav(Int16Array.from({ length: 64 }, (_, i) => (i + 1) * 100));
    let accepted = 0;
    for (let pos = 0; pos < 44; pos++) {
      for (let value = 0; value < 256; value++) {
        if (value === wav[pos]) continue;
        const mutated = Buffer.from(wav);
        mutated[pos] = value;
        if (code(() => validateWav(mutated)) === "ok") accepted++;
      }
    }
    expect(accepted).toBe(0);
  });

  it("a chunk cut off mid-way is a WavError, never a read past the end of the buffer", () => {
    // A leading padding chunk keeps the file past the minimum-size check, so the chunk logic is reached.
    const pad = chunk("junk", Buffer.alloc(30));
    const body = (id: string, declared: number, actual: Buffer) => riff([pad, chunk(id, actual, declared)]);
    // fmt promises 16 bytes but only 6 are there; data promises a lot but has a few bytes.
    expect(code(() => validateWav(body("fmt ", 16, Buffer.alloc(6, 1))))).toBe("bad_chunk");
    expect(code(() => validateWav(riff([chunk("fmt ", fmtBody()), chunk("data", Buffer.alloc(4, 1), 2_000_000)])))).toBe("bad_chunk");
  });

  it("files with a correct RIFF size but a damaged or random body only ever give WavError", () => {
    const chunkIds = ["fmt ", "data", "LIST", "fact", "junk"];
    fc.assert(
      fc.property(
        fc.array(fc.record({ id: fc.constantFrom(...chunkIds), declared: fc.oneof(fc.nat({ max: 64 }), fc.constant(0xffffffff)), body: fc.uint8Array({ maxLength: 40 }) }), { maxLength: 5 }),
        fc.uint8Array({ maxLength: 12 }),
        (chunks, tail) => {
          // Chunk headers that may lie about their size, then arbitrary trailing bytes; the RIFF size is always right.
          const parts = chunks.map((c) => {
            const h = Buffer.alloc(8);
            h.write(c.id, 0, "ascii");
            h.writeUInt32LE(c.declared, 4);
            return Buffer.concat([h, Buffer.from(c.body)]);
          });
          const wav = riff([chunk("junk", Buffer.alloc(30)), ...parts, Buffer.from(tail)]);
          code(() => validateWav(wav));
        },
      ),
      { numRuns: 2_000 },
    );
  });

  it("arbitrary bytes only ever produce WavError, never another exception", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 200 }), (bytes) => {
        code(() => validateWav(bytes));
      }),
      { numRuns: 1_000 },
    );
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 44, maxLength: 120 }), (tail) => {
        // Valid-looking prefix, arbitrary rest.
        const wav = Buffer.concat([encodeWav(Int16Array.from([1, 2, 3])).subarray(0, 44), Buffer.from(tail)]);
        code(() => validateWav(wav));
      }),
      { numRuns: 500 },
    );
  });
});

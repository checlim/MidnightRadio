import { spawn } from "node:child_process";
import { rm } from "node:fs/promises";
import { z } from "zod";

/**
 * The single way this project runs ffmpeg and ffprobe (tech.md). Arguments are always an array
 * (never a shell string). Files are passed with the `file:` protocol, so a name starting with
 * `-` is not read as an option and a name like `http://…` is never fetched. On failure the full
 * command and filter graph are logged and carried by the error, so a broken mix can be
 * reproduced exactly.
 */

export type FfmpegInput =
  /** A file on disk. */
  | { path: string; options?: string[] }
  /** A generated source, e.g. `anullsrc=r=24000:cl=mono` for silence. */
  | { lavfi: string; options?: string[] };

export interface FfmpegJob {
  inputs: FfmpegInput[];
  /** `-af` for a single audio chain, `-filter_complex` for a graph with labels. */
  filter?: { type: "audio" | "complex"; graph: string };
  /** Options after the filter, e.g. `["-map", "[out]", "-c:a", "pcm_s16le"]`. */
  outputOptions?: string[];
  /** Output file (written with `file:`), or `null` to discard output (`-f null -`), e.g. when only measuring. */
  output: string | null;
  /** Default 10 minutes. The process is killed when it runs over. */
  timeoutMs?: number;
  /** `error` by default. Measurements such as `ebur128` or `astats` report at `info`. */
  logLevel?: "error" | "warning" | "info";
}

export interface FfmpegResult {
  /** ffmpeg's log output (stderr), capped to the last 1 MB. */
  log: string;
  durationMs: number;
}

export class FfmpegError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly filterGraph: string | null,
    readonly exitCode: number | null,
    readonly signal: NodeJS.Signals | null,
    /** The last part of ffmpeg's log. */
    readonly logTail: string,
  ) {
    super(message);
    this.name = "FfmpegError";
  }
}

export interface FfmpegOptions {
  /** Defaults to `$FFMPEG_PATH` or `ffmpeg` on the PATH. */
  ffmpegPath?: string;
  ffprobePath?: string;
  /** Where failures are reported. Defaults to stderr. */
  log?: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_LOG_BYTES = 1024 * 1024;
const MAX_PROBE_BYTES = 1024 * 1024;
const TAIL_CHARS = 4000;

const asFile = (path: string): string => {
  if (path.length === 0 || path.includes("\0")) throw new TypeError("ffmpeg file paths must be non-empty and contain no NUL");
  return `file:${path}`;
};

/** The exact argument list for a job, without the program name. Pure, so tests can check it. */
export function buildArgs(job: FfmpegJob): string[] {
  if (job.inputs.length === 0) throw new TypeError("an ffmpeg job needs at least one input");
  const args = ["-hide_banner", "-nostdin", "-nostats", "-loglevel", job.logLevel ?? "error", "-y"];
  for (const input of job.inputs) {
    args.push(...(input.options ?? []));
    if ("path" in input) args.push("-i", asFile(input.path));
    else args.push("-f", "lavfi", "-i", input.lavfi);
  }
  if (job.filter) args.push(job.filter.type === "audio" ? "-af" : "-filter_complex", job.filter.graph);
  args.push(...(job.outputOptions ?? []));
  if (job.output === null) args.push("-f", "null", "-");
  else args.push(asFile(job.output));
  return args;
}

const quote = (a: string) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);

interface Collected {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: Buffer;
  stderr: string;
  timedOut: boolean;
  spawnError?: Error;
}

function collect(program: string, args: string[], timeoutMs: number, maxStdout: number): Promise<Collected> {
  return new Promise((resolve) => {
    const child = spawn(program, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const out: Buffer[] = [];
    let outBytes = 0;
    let overflow = false;
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => {
      outBytes += d.length;
      if (outBytes > maxStdout) {
        overflow = true;
        child.kill("SIGKILL");
      } else out.push(d);
    });
    child.stderr.on("data", (d: Buffer) => {
      err += d.toString("utf8");
      if (err.length > MAX_LOG_BYTES) err = err.slice(-MAX_LOG_BYTES);
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: null, signal: null, stdout: Buffer.alloc(0), stderr: err, timedOut, spawnError: e });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout: Buffer.concat(out), stderr: overflow ? `${err}\n[output larger than ${maxStdout} bytes; stopped]` : err, timedOut });
    });
  });
}

/** Run one ffmpeg job. Throws FfmpegError (after logging the command and graph) if ffmpeg fails, times out or cannot start. */
export async function runFfmpeg(job: FfmpegJob, opts: FfmpegOptions = {}): Promise<FfmpegResult> {
  const program = opts.ffmpegPath ?? process.env.FFMPEG_PATH ?? "ffmpeg";
  const args = buildArgs(job);
  const timeoutMs = job.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  const r = await collect(program, args, timeoutMs, 0);
  if (!r.spawnError && !r.timedOut && r.code === 0) return { log: r.stderr, durationMs: Date.now() - started };
  // A failed job's output is never usable. FFmpeg 4.4 opens (and so creates or truncates) the output
  // before it parses the filter graph, so a bad graph would leave an empty file at the final path.
  if (job.output !== null) await rm(job.output, { force: true }).catch(() => undefined);

  const graph = job.filter?.graph ?? null;
  const why = r.spawnError ? `could not start ffmpeg (${(r.spawnError as NodeJS.ErrnoException).code ?? r.spawnError.message})` : r.timedOut ? `ffmpeg ran longer than ${timeoutMs} ms and was stopped` : `ffmpeg failed (exit ${r.code ?? r.signal})`;
  const tail = r.stderr.slice(-TAIL_CHARS).trim();
  const report = [`${why}`, `command: ${[program, ...args].map(quote).join(" ")}`, `filter graph: ${graph ?? "(none)"}`, tail ? `ffmpeg said:\n${tail}` : "ffmpeg said nothing"].join("\n");
  (opts.log ?? ((m: string) => process.stderr.write(`${m}\n`)))(report);
  throw new FfmpegError(`${why}: ${tail.split("\n").pop() ?? ""}`.trim(), args, graph, r.code, r.signal, tail);
}

const ProbeSchema = z.object({
  streams: z
    .array(
      z.object({
        codec_type: z.string(),
        codec_name: z.string(),
        sample_rate: z.string().regex(/^\d+$/).transform(Number).optional(),
        channels: z.number().int().optional(),
        bits_per_sample: z.number().int().optional(),
        duration: z.string().regex(/^\d+(\.\d+)?$/).transform(Number).optional(),
      }),
    )
    .min(1),
  format: z.object({ format_name: z.string(), duration: z.string().regex(/^\d+(\.\d+)?$/).transform(Number).optional() }),
});

export interface AudioProbe {
  format: string;
  codec: string;
  sampleRate: number;
  channels: number;
  /** 0 when the codec does not have a fixed sample size (e.g. MP3). */
  bitsPerSample: number;
  durationMs: number;
}

/** Describe the first audio stream of a file with ffprobe. Throws FfmpegError if it cannot be read or has no audio. */
export async function probeAudio(path: string, opts: FfmpegOptions = {}): Promise<AudioProbe> {
  const program = opts.ffprobePath ?? process.env.FFPROBE_PATH ?? "ffprobe";
  const args = ["-hide_banner", "-loglevel", "error", "-print_format", "json", "-show_streams", "-show_format", asFile(path)];
  const r = await collect(program, args, 60_000, MAX_PROBE_BYTES);
  const fail = (why: string): never => {
    const tail = r.stderr.slice(-TAIL_CHARS).trim();
    (opts.log ?? ((m: string) => process.stderr.write(`${m}\n`)))(`${why}\ncommand: ${[program, ...args].map(quote).join(" ")}${tail ? `\nffprobe said:\n${tail}` : ""}`);
    throw new FfmpegError(`${why}${tail ? `: ${tail.split("\n").pop()}` : ""}`, args, null, r.code, r.signal, tail);
  };
  if (r.spawnError) fail(`could not start ffprobe (${(r.spawnError as NodeJS.ErrnoException).code ?? r.spawnError.message})`);
  if (r.timedOut || r.code !== 0) fail(`ffprobe could not read the file (exit ${r.code ?? r.signal})`);
  let parsed: z.infer<typeof ProbeSchema>;
  try {
    parsed = ProbeSchema.parse(JSON.parse(r.stdout.toString("utf8")));
  } catch {
    return fail("ffprobe's answer was not in the expected shape");
  }
  const audio = parsed.streams.find((s) => s.codec_type === "audio");
  if (!audio || audio.sample_rate === undefined || audio.channels === undefined) return fail("the file has no audio stream");
  const seconds = audio.duration ?? parsed.format.duration;
  if (seconds === undefined) return fail("ffprobe did not report a duration");
  return { format: parsed.format.format_name, codec: audio.codec_name, sampleRate: audio.sample_rate, channels: audio.channels, bitsPerSample: audio.bits_per_sample ?? 0, durationMs: Math.round(seconds * 1000) };
}

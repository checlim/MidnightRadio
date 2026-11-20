import { framesToMs, type Timeline } from "./timeline.js";

/**
 * Transcript and chapter markers (Task 9.4, Req 6.5). Pure, and built from the same timeline as
 * the audio, so every cue starts where its line starts in the mix. `offsetMs` shifts everything
 * by the same amount if the delivered file starts later than the mix (it should not: the MP3's
 * encoder delay is recorded in its header and removed by decoders; Task 9.5 checks this).
 */

export interface VttOptions {
  /** Labels for lines that are not dialogue. */
  announcerLabel?: string;
  narratorLabel?: string;
  offsetMs?: number;
}

/** `HH:MM:SS.mmm`, as WebVTT wants it. */
export function vttTime(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const f = total % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(f).padStart(3, "0")}`;
}

/** Cue text cannot contain markup or a cue-ending blank line. */
const escapeCue = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\s*\n\s*/g, " ").trim();

/** One cue per spoken line, labelled with who speaks, in timeline order. */
export function webVtt(timeline: Timeline, opts: VttOptions = {}): string {
  const offset = opts.offsetMs ?? 0;
  const lines = ["WEBVTT", ""];
  let n = 0;
  for (const it of timeline.items) {
    if (it.kind !== "speech") continue;
    const who = it.segmentKind === "dialogue" ? it.speaker! : it.segmentKind === "announcer" ? (opts.announcerLabel ?? "Announcer") : (opts.narratorLabel ?? "Narrator");
    const start = framesToMs(it.startFrame) + offset;
    const end = framesToMs(it.startFrame + it.frames) + offset;
    lines.push(String(++n), `${vttTime(start)} --> ${vttTime(end)}`, `<v ${escapeCue(who)}>${escapeCue(it.text)}`, "");
  }
  return lines.join("\n");
}

export interface ChapterMarker {
  title: string;
  startMs: number;
  endMs: number;
}

/**
 * Chapter markers: the cold open, each scene (its title, or "Scene N") and the close. Each runs
 * until the next one starts, so together they cover the whole episode with no gaps.
 */
export function chapterMarkers(timeline: Timeline, offsetMs = 0): ChapterMarker[] {
  const starts: { title: string; frame: number }[] = [];
  const first = (section: "coldOpen" | "close") => timeline.items.find((i) => i.ref.section === section)?.startFrame;
  const open = first("coldOpen");
  if (open !== undefined) starts.push({ title: "Cold open", frame: 0 });
  for (const sc of timeline.scenes) starts.push({ title: sc.title ?? `Scene ${sc.sceneIdx + 1}`, frame: starts.length === 0 ? 0 : sc.startFrame });
  const close = first("close");
  if (close !== undefined) starts.push({ title: "Close", frame: close });
  return starts.map((s, i) => ({
    title: s.title,
    startMs: Math.round(framesToMs(s.frame) + (i === 0 ? 0 : offsetMs)),
    endMs: Math.round(framesToMs(i + 1 < starts.length ? starts[i + 1]!.frame : timeline.totalFrames) + offsetMs),
  }));
}

/** An FFMETADATA1 file carrying chapters and tags, for the MP3 muxer (ID3 CHAP and text frames). */
export function ffmetadata(tags: Record<string, string>, chapters: readonly ChapterMarker[]): string {
  const esc = (s: string) => s.replace(/[\\=;#\n]/g, (c) => (c === "\n" ? " " : `\\${c}`));
  const lines = [";FFMETADATA1", ...Object.entries(tags).map(([k, v]) => `${esc(k)}=${esc(v)}`)];
  for (const c of chapters) lines.push("[CHAPTER]", "TIMEBASE=1/1000", `START=${c.startMs}`, `END=${c.endMs}`, `title=${esc(c.title)}`);
  return `${lines.join("\n")}\n`;
}

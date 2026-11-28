/**
 * The episode transcript (Req 7.3, 7.4): a small WebVTT reader for the files the mixer writes, and
 * a cue lookup by playback time. Pure. Tolerant of what browsers accept (cue ids, settings after
 * the timing, CRLF), strict about what the player needs (valid times, start ≤ end).
 */

export interface Cue {
  startMs: number;
  endMs: number;
  /** From a `<v Speaker>` tag, if any. */
  speaker: string | null;
  text: string;
}

const TIME = /(?:(\d+):)?(\d{2}):(\d{2})\.(\d{3})/;
const toMs = (m: RegExpExecArray) => ((Number(m[1] ?? 0) * 60 + Number(m[2])) * 60 + Number(m[3])) * 1000 + Number(m[4]);

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&nbsp;": "\u00a0", "&lrm;": "\u200e", "&rlm;": "\u200f" };
const unescape = (s: string) => s.replace(/&(?:amp|lt|gt|nbsp|lrm|rlm);/g, (e) => ENTITIES[e]!);

export function parseVtt(text: string): Cue[] {
  const src = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!/^WEBVTT(?:[ \t].*)?(?:\n|$)/.test(src)) throw new Error("not a WebVTT file");
  const cues: Cue[] = [];
  for (const block of src.split(/\n{2,}/).slice(1)) {
    const lines = block.split("\n").filter((l) => l.length > 0);
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at === -1) continue; // NOTE, STYLE, REGION blocks
    const [a, b] = lines[at]!.split("-->");
    const start = TIME.exec(a ?? "");
    const end = TIME.exec(b ?? "");
    if (!start || !end) continue;
    const raw = lines.slice(at + 1).join(" ");
    const voice = /^<v(?:\.[^ >]*)?\s+([^>]+)>/.exec(raw);
    const body = unescape(raw.replace(/<\/?[^>]*>/g, "")).trim();
    const startMs = toMs(start);
    const endMs = toMs(end);
    if (endMs < startMs) continue;
    cues.push({ startMs, endMs, speaker: voice ? unescape(voice[1]!.trim()) : null, text: body });
  }
  return cues.sort((x, y) => x.startMs - y.startMs);
}

/** Index of the cue playing at `ms`, or -1 between cues. Binary search over cues sorted by start. */
export function cueIndexAt(cues: readonly Cue[], ms: number): number {
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid]!.startMs <= ms) {
      found = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return found !== -1 && ms < cues[found]!.endMs ? found : -1;
}

/** Cues whose text or speaker contains `query` (case-insensitive), for the transcript search. */
export function searchCues(cues: readonly Cue[], query: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return cues.flatMap((c, i) => (c.text.toLowerCase().includes(q) || (c.speaker ?? "").toLowerCase().includes(q) ? [i] : []));
}

/** `m:ss`, or `h:mm:ss` past an hour, for transcript timestamps. */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/**
 * Where a scrolling list should be scrolled to show an item, moving as little as possible
 * ("nearest"): unchanged if the item is already fully in view, otherwise just far enough to show
 * it, preferring its top if it is taller than the list. Item positions are measured from the top of
 * the list's content. Pure. Used instead of `scrollIntoView`, which also scrolls the page.
 */
export function scrollTopToReveal(view: { scrollTop: number; height: number }, item: { top: number; height: number }): number {
  const bottom = item.top + item.height;
  if (item.top < view.scrollTop || item.height > view.height) return item.top;
  if (bottom > view.scrollTop + view.height) return bottom - view.height;
  return view.scrollTop;
}

import { z } from "zod";
import { SceneSchema, ScriptSchema, SegmentSchema, type Script, type Segment } from "./schema.js";

/**
 * What the adapter model writes, and the rules a Script must meet beyond its schema (Task 7.2,
 * Req 3.3, 3.4, 3.6). Pure.
 *
 * The model writes only the cold open, scenes and close; book, chapter and episode come from the
 * pipeline (`completeScript`), so the model cannot get them wrong. `checkAdaptationRules` covers
 * what code can decide: narration length, and the announcer's cold open and close lines. Tense
 * and "no spoilers" cannot be checked mechanically; the prompt and the chapter-local Cast cover
 * those, and Task 8 checks that no speech was invented.
 */

export const MAX_NARRATION_WORDS = 35;
export const CLOSE_TAG = "Tune in next time";

/** The model's reply. Same segment and scene rules as the Script; strict, so extra fields are refused. */
export const AdaptedScriptSchema = z.strictObject({
  coldOpen: z.array(SegmentSchema).min(1),
  scenes: z.array(SceneSchema).min(1),
  close: z.array(SegmentSchema).min(1),
});
export type AdaptedScript = z.infer<typeof AdaptedScriptSchema>;

export interface EpisodeInfo {
  bookId: string;
  chapterId: string;
  episodeNumber: number;
  seriesTitle: string;
  /** Shown in the cold open; not checked word for word, since the announcer may say it naturally. */
  chapterTitle: string;
}

/** A rule the reply broke, with where (e.g. `scenes[2].segments[4]`) and a message fit to send back to the model. */
export interface AdaptationIssue {
  path: string;
  message: string;
}

/** Whitespace-separated words, the same definition the splitter uses (Req 1.5). */
export const wordCount = (text: string): number => text.split(/\s+/).filter((w) => w.length > 0).length;

const NUMBER_WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const fold = (s: string) => s.normalize("NFC").replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').toLowerCase();

/** True if `text` says episode `n` as digits ("Episode 3") or, up to twenty, in words ("episode three"). */
export function mentionsEpisode(text: string, n: number): boolean {
  const t = fold(text);
  const forms = [String(n), ...(n < NUMBER_WORDS.length ? [NUMBER_WORDS[n]!] : [])];
  return forms.some((f) => new RegExp(`\\bepisode\\s+(?:number\\s+)?${f}\\b`).test(t));
}

/** Every rule the reply breaks, in Script order. Empty means it may go on to validation (Task 8). */
export function checkAdaptationRules(script: Pick<Script, "coldOpen" | "scenes" | "close">, episode: Pick<EpisodeInfo, "episodeNumber" | "seriesTitle">): AdaptationIssue[] {
  const issues: AdaptationIssue[] = [];
  const narration = (seg: Segment, path: string) => {
    if (seg.kind !== "narration" || seg.containsVerbatimQuote) return;
    const n = wordCount(seg.text);
    if (n > MAX_NARRATION_WORDS) issues.push({ path, message: `narration has ${n} words; condense it to at most ${MAX_NARRATION_WORDS}, or split it, keeping events in order` });
  };
  script.coldOpen.forEach((s, i) => narration(s, `coldOpen[${i}]`));
  script.scenes.forEach((scene, si) => scene.segments.forEach((s, i) => narration(s, `scenes[${si}].segments[${i}]`)));
  script.close.forEach((s, i) => narration(s, `close[${i}]`));

  const openLines = script.coldOpen.filter((s) => s.kind === "announcer").map((s) => s.text);
  const opening = openLines.join(" ");
  if (openLines.length > 0) {
    if (!fold(opening).includes(fold(episode.seriesTitle))) issues.push({ path: "coldOpen", message: `the announcer's cold open must name the series, "${episode.seriesTitle}"` });
    if (!mentionsEpisode(opening, episode.episodeNumber)) issues.push({ path: "coldOpen", message: `the announcer's cold open must say "Episode ${episode.episodeNumber}"` });
  }
  const closeLines = script.close.filter((s) => s.kind === "announcer").map((s) => s.text).join(" ");
  if (closeLines.length > 0 && !fold(closeLines).includes(fold(CLOSE_TAG))) {
    issues.push({ path: "close", message: `the announcer's close must end with "${CLOSE_TAG} to ${episode.seriesTitle}."` });
  }
  return issues;
}

/** Add the pipeline's ids to the model's reply and check it against the full Script schema. */
export function completeScript(reply: AdaptedScript, episode: Pick<EpisodeInfo, "bookId" | "chapterId" | "episodeNumber">): ReturnType<typeof ScriptSchema.safeParse> {
  return ScriptSchema.safeParse({ bookId: episode.bookId, chapterId: episode.chapterId, episodeNumber: episode.episodeNumber, ...reply });
}

export type AdaptationCheck = { ok: true; script: Script } | { ok: false; issues: AdaptationIssue[] };

/**
 * Parse the model's raw reply and apply every check in order: JSON, reply schema, full Script
 * schema (cold open starts with the announcer, close has announcer and theme, unique scene ids),
 * then the adaptation rules. All problems found at the first failing stage are reported.
 */
export function checkAdaptationReply(text: string, episode: EpisodeInfo): AdaptationCheck {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, issues: [{ path: "(reply)", message: "the reply was not valid JSON" }] };
  }
  const zodIssues = (error: z.ZodError) => error.issues.slice(0, 20).map((i): AdaptationIssue => ({ path: pathOf(i.path), message: i.message }));
  const reply = AdaptedScriptSchema.safeParse(json);
  if (!reply.success) return { ok: false, issues: zodIssues(reply.error) };
  const script = completeScript(reply.data, episode);
  if (!script.success) return { ok: false, issues: zodIssues(script.error) };
  const rules = checkAdaptationRules(script.data, episode);
  return rules.length > 0 ? { ok: false, issues: rules } : { ok: true, script: script.data };
}

/** `["scenes", 2, "segments", 4, "text"]` → `scenes[2].segments[4].text`. */
export function pathOf(path: readonly PropertyKey[]): string {
  if (path.length === 0) return "(reply)";
  return path.reduce<string>((acc, p) => (typeof p === "number" ? `${acc}[${p}]` : acc ? `${acc}.${String(p)}` : String(p)), "");
}

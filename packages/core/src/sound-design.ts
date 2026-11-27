import { z } from "zod";
import { canonicaliseText } from "./normalise.js";
import { ScriptSchema, type Scene, type Script, type Segment } from "./schema.js";
import { MIN_CUE_MS, auditScriptSfx, indexSfx, type SfxAuditIssue, type SfxCatalogue } from "./sfx.js";

/**
 * A sound-design pass on a saved Script (adds effects and ambience, nothing else). The model
 * proposes edits against the Script as it stands; this module applies them and enforces, in
 * code, that no spoken segment is rewritten, dropped, reordered or duplicated, and that no
 * speaker, delivery, music cue or pause changes. Every proposed sound must quote the chapter
 * text it is based on; a quote that is not in the chapter drops that sound. Pure.
 */

/** A sound before a segment of a scene (`beforeSegment` = the scene's length puts it at the end). */
const CueEditSchema = z.strictObject({
  scene: z.number().int().min(0),
  beforeSegment: z.number().int().min(0),
  sfxId: z.string().min(1).max(48),
  durationMs: z.number().int().min(MIN_CUE_MS).max(30_000).optional(),
  /** Words from the chapter that make this sound happen. */
  evidence: z.string().min(1).max(300),
});

/** The background from a segment of a scene on (`fromSegment` > 0 splits the scene there). `id: null` clears it. */
const AmbienceEditSchema = z.strictObject({
  scene: z.number().int().min(0),
  fromSegment: z.number().int().min(0),
  id: z.string().min(1).max(48).nullable(),
  gainDb: z.number().min(-40).max(0).optional(),
  evidence: z.string().min(1).max(300),
});

export const SoundDesignEditsSchema = z.strictObject({
  cues: z.array(CueEditSchema).max(80),
  ambience: z.array(AmbienceEditSchema).max(40),
});
export type SoundDesignEdits = z.infer<typeof SoundDesignEditsSchema>;

export interface RejectedEdit {
  edit: "cue" | "ambience";
  index: number;
  reason: string;
}

export interface AppliedCue {
  path: string;
  sfxId: string;
  evidence: string;
}

export interface SoundDesignResult {
  script: Script;
  cues: AppliedCue[];
  beds: { sceneIdx: number; id: string; evidence: string }[];
  /** Proposals that were dropped, with why. Optional: the rest is still used. */
  rejected: RejectedEdit[];
  /** Old spoken-segment path → new path; a bijection, in order. */
  speechMap: Map<string, string>;
}

const words = (s: string) => canonicaliseText(s).toLowerCase().replace(/[^\p{L}\p{N}' ]+/gu, " ").split(/\s+/).filter(Boolean);

/** Whether `evidence` (at least two words) appears, word for word, in the chapter. Punctuation and case are ignored. */
export function evidenceInChapter(evidence: string, chapterText: string): boolean {
  const e = words(evidence);
  if (e.length < 2) return false;
  const hay = ` ${words(chapterText).join(" ")} `;
  return hay.includes(` ${e.join(" ")} `);
}

const isSpoken = (s: Segment) => s.kind === "announcer" || s.kind === "narration" || s.kind === "dialogue";

/** Every segment in playing order with its path. */
function flatten(script: Pick<Script, "coldOpen" | "scenes" | "close">): { path: string; segment: Segment }[] {
  return [
    ...script.coldOpen.map((segment, i) => ({ path: `coldOpen[${i}]`, segment })),
    ...script.scenes.flatMap((scene, si) => scene.segments.map((segment, i) => ({ path: `scenes[${si}].segments[${i}]`, segment }))),
    ...script.close.map((segment, i) => ({ path: `close[${i}]`, segment })),
  ];
}

const same = (a: Segment, b: Segment) => JSON.stringify(a) === JSON.stringify(b);

export interface PreservationIssue {
  path: string;
  message: string;
}

/**
 * Check that `after` is `before` with only sound-effect segments added (and scenes possibly split
 * or given other ambience): every other segment, spoken or not, is present once, unchanged and in
 * order. Returns the spoken-segment path map on success. Pure.
 */
export function checkOnlySoundAdded(before: Pick<Script, "coldOpen" | "scenes" | "close">, after: Pick<Script, "coldOpen" | "scenes" | "close">): { ok: true; speechMap: Map<string, string> } | { ok: false; issues: PreservationIssue[] } {
  const b = flatten(before);
  const a = flatten(after);
  const issues: PreservationIssue[] = [];
  if (JSON.stringify(before.coldOpen) !== JSON.stringify(after.coldOpen)) issues.push({ path: "coldOpen", message: "the cold open changed" });
  if (JSON.stringify(before.close) !== JSON.stringify(after.close)) issues.push({ path: "close", message: "the close changed" });
  const speechMap = new Map<string, string>();
  let j = 0;
  for (const item of b) {
    while (j < a.length && !same(a[j]!.segment, item.segment)) {
      if (a[j]!.segment.kind !== "sfx") {
        issues.push({ path: a[j]!.path, message: isSpoken(a[j]!.segment) ? "a spoken line was added, changed or moved" : `a ${a[j]!.segment.kind} segment was added or changed` });
      }
      j++;
    }
    if (j >= a.length) {
      issues.push({ path: item.path, message: isSpoken(item.segment) ? "a spoken line is missing, changed or out of order" : `a ${item.segment.kind} segment is missing, changed or out of order` });
      break;
    }
    if (isSpoken(item.segment)) speechMap.set(item.path, a[j]!.path);
    j++;
  }
  for (; j < a.length; j++) if (a[j]!.segment.kind !== "sfx") issues.push({ path: a[j]!.path, message: isSpoken(a[j]!.segment) ? "a spoken line was added" : `a ${a[j]!.segment.kind} segment was added` });
  return issues.length > 0 ? { ok: false, issues } : { ok: true, speechMap };
}

/**
 * Apply proposed edits to a Script. Each proposal is checked on its own (scene and segment exist,
 * the sound exists and fits, the quote is in the chapter); bad ones are dropped and reported.
 * The result is checked again as a whole: sounds against the library, and the speech against
 * the original. Throws only if that final check fails (a bug, since edits cannot touch speech).
 */
export function applySoundDesign(script: Script, edits: SoundDesignEdits, catalogue: SfxCatalogue, chapterText: string): SoundDesignResult {
  const index = indexSfx(catalogue);
  const rejected: RejectedEdit[] = [];
  const cues: AppliedCue[] = [];
  const beds: SoundDesignResult["beds"] = [];
  /** Each inserted segment object → its report entry, to record where it ended up. */
  const placed = new Map<Segment, AppliedCue>();

  // Per original scene: insertions before each original index, and ambience boundaries.
  const inserts = new Map<number, Map<number, Segment[]>>();
  const bounds = new Map<number, Map<number, { id: string | null; gainDb: number | undefined; evidence: string }>>();
  edits.cues.forEach((c, i) => {
    const scene = script.scenes[c.scene];
    const entry = index.get(c.sfxId);
    const reason = !scene
      ? `there is no scene ${c.scene}`
      : c.beforeSegment > scene.segments.length
        ? `scene ${c.scene} has no segment ${c.beforeSegment}`
        : !entry
          ? `"${c.sfxId}" is not in the sound library`
          : entry.kind !== "sfx"
            ? `"${c.sfxId}" is music, not a sound effect`
            : c.durationMs !== undefined && !entry.loopable && c.durationMs > entry.durationMs
              ? `"${c.sfxId}" lasts ${entry.durationMs} ms and cannot loop`
              : !evidenceInChapter(c.evidence, chapterText)
                ? "its quote is not in the chapter, so the sound is not supported by the text"
                : null;
    if (reason) return void rejected.push({ edit: "cue", index: i, reason });
    const at = inserts.get(c.scene) ?? new Map<number, Segment[]>();
    const seg: Segment = { kind: "sfx", sfxId: c.sfxId, ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}) };
    at.set(c.beforeSegment, [...(at.get(c.beforeSegment) ?? []), seg]);
    inserts.set(c.scene, at);
    const applied = { path: "", sfxId: c.sfxId, evidence: c.evidence };
    cues.push(applied);
    placed.set(seg, applied);
  });
  edits.ambience.forEach((a, i) => {
    const scene = script.scenes[a.scene];
    const entry = a.id === null ? null : index.get(a.id);
    const reason = !scene
      ? `there is no scene ${a.scene}`
      : a.fromSegment >= scene.segments.length
        ? `scene ${a.scene} has no segment ${a.fromSegment} to start a background at`
        : a.id !== null && !entry
          ? `"${a.id}" is not in the sound library`
          : entry && !entry.loopable
            ? `"${a.id}" cannot loop, so it cannot be a background`
            : bounds.get(a.scene)?.has(a.fromSegment)
              ? "another background already starts there"
              : a.id !== null && !evidenceInChapter(a.evidence, chapterText)
                ? "its quote is not in the chapter, so the background is not supported by the text"
                : null;
    if (reason) return void rejected.push({ edit: "ambience", index: i, reason });
    const at = bounds.get(a.scene) ?? new Map();
    at.set(a.fromSegment, { id: a.id, gainDb: a.gainDb, evidence: a.evidence });
    bounds.set(a.scene, at);
  });

  // Rebuild the scenes: split at ambience boundaries, insert the sounds.
  const scenes: Scene[] = [];
  const usedIds = new Set(script.scenes.map((s) => s.id));
  script.scenes.forEach((scene, si) => {
    const at = inserts.get(si);
    const cuts = [...(bounds.get(si)?.keys() ?? [])].filter((k) => k > 0).sort((x, y) => x - y);
    const starts = [0, ...cuts];
    starts.forEach((start, part) => {
      const end = part + 1 < starts.length ? starts[part + 1]! : scene.segments.length;
      const segments: Segment[] = [];
      for (let k = start; k < end; k++) {
        segments.push(...(at?.get(k) ?? []));
        segments.push(scene.segments[k]!);
      }
      if (end === scene.segments.length) segments.push(...(at?.get(scene.segments.length) ?? []));
      const edit = bounds.get(si)?.get(start);
      const prevBed = part === 0 ? scene.ambience : scenes[scenes.length - 1]!.ambience;
      const ambience = edit === undefined ? prevBed : edit.id === null ? undefined : { kind: "sfx" as const, id: edit.id, ...(edit.gainDb !== undefined ? { gainDb: edit.gainDb } : {}) };
      let id = scene.id;
      if (part > 0) {
        let n = part + 1;
        while (usedIds.has(`${scene.id}-${n}`)) n++;
        id = `${scene.id}-${n}`;
        usedIds.add(id);
      }
      const next: Scene = { id, ...(part === 0 && scene.title !== undefined ? { title: scene.title } : {}), ...(ambience ? { ambience } : {}), segments };
      scenes.push(next);
      if (edit && edit.id !== null) beds.push({ sceneIdx: scenes.length - 1, id: edit.id, evidence: edit.evidence });
      segments.forEach((seg, k) => {
        const applied = placed.get(seg);
        if (applied) applied.path = `scenes[${scenes.length - 1}].segments[${k}]`;
      });
    });
  });
  const out = ScriptSchema.parse({ ...script, scenes });

  const preserved = checkOnlySoundAdded(script, out);
  if (!preserved.ok) throw new Error(`a sound-design pass changed speech: ${preserved.issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  const audit = auditScriptSfx(catalogue, out);
  if (audit.length > 0) throw new Error(`a sound-design pass produced invalid cues: ${audit.map((i) => `${i.path}: ${i.message}`).join("; ")}`);
  return { script: out, cues, beds, rejected, speechMap: preserved.speechMap };
}

/** Problems with a Script's sounds, as a gate before a mix (unknown ids, kinds, beds that cannot loop, durations). */
export const validateCues = (catalogue: SfxCatalogue, script: Script): SfxAuditIssue[] => auditScriptSfx(catalogue, script);

/**
 * A saved Script whose sounds no longer fit a library (an effect or bed that is gone, too short,
 * or cannot loop): the same Script with those sound-effect segments and backgrounds removed, and
 * what was removed. Music cues and speech are never touched; a music cue the library cannot play
 * stays an error for `validateCues`, and so does an effect in the cold open or close (they are
 * fixed). Pure.
 */
export function stripUnavailableSound(script: Script, catalogue: SfxCatalogue): { script: Script; removed: { path: string; id: string; reason: string }[] } {
  const issues = auditScriptSfx(catalogue, script);
  const bad = new Map<string, SfxAuditIssue>();
  for (const i of issues) bad.set(i.path, i);
  const removed: { path: string; id: string; reason: string }[] = [];
  const keep = (segments: Segment[], prefix: string) =>
    segments.filter((s, i) => {
      const issue = s.kind === "sfx" ? bad.get(`${prefix}[${i}]`) : undefined;
      if (issue) removed.push({ path: `${prefix}[${i}]`, id: s.kind === "sfx" ? s.sfxId : "", reason: issue.message });
      return !issue;
    });
  const scenes = script.scenes.map((scene, si) => {
    const bed = bad.get(`scenes[${si}].ambience`);
    if (bed && scene.ambience) removed.push({ path: `scenes[${si}].ambience`, id: scene.ambience.id, reason: bed.message });
    const { ambience, ...rest } = scene;
    return { ...rest, ...(ambience && !bed ? { ambience } : {}), segments: keep(scene.segments, `scenes[${si}].segments`) };
  });
  const out = ScriptSchema.parse({ ...script, scenes });
  // Removing sounds must leave every other segment as it was: the reverse of adding them.
  const check = checkOnlySoundAdded(out, script);
  if (!check.ok) throw new Error(`removing unavailable sounds changed the Script: ${check.issues.map((i) => i.message).join("; ")}`);
  return { script: out, removed };
}

/**
 * Whether two Scripts say exactly the same thing: the same spoken segments (kind, speaker, text,
 * delivery, verbatim flag) and the same music and pauses, in the same order, with the same cold
 * open and close. Sound effects and backgrounds may differ. This is the rule for a remix,
 * checked between the parent Script and its sound-design revision. Pure.
 */
export function checkSpeechUnchanged(before: Pick<Script, "coldOpen" | "scenes" | "close">, after: Pick<Script, "coldOpen" | "scenes" | "close">): PreservationIssue[] {
  const issues: PreservationIssue[] = [];
  const strip = (segs: Segment[]) => segs.filter((s) => s.kind !== "sfx");
  if (JSON.stringify(strip(before.coldOpen)) !== JSON.stringify(strip(after.coldOpen))) issues.push({ path: "coldOpen", message: "the cold open's speech or music changed" });
  if (JSON.stringify(strip(before.close)) !== JSON.stringify(strip(after.close))) issues.push({ path: "close", message: "the close's speech or music changed" });
  const b = flatten(before).filter((x) => x.segment.kind !== "sfx");
  const a = flatten(after).filter((x) => x.segment.kind !== "sfx");
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = b[i];
    const y = a[i];
    if (!x || !y || !same(x.segment, y.segment)) {
      issues.push({ path: y?.path ?? x!.path, message: !y ? "a line is missing" : !x ? "a line was added" : "a line was changed, moved or given another speaker or delivery" });
      break;
    }
  }
  return issues;
}

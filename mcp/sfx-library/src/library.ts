import { readFileSync, statSync } from "node:fs";
import { MUSIC_CUES, SfxCatalogueSchema, auditScriptSfxJson, indexSfx, resolveMusicCue, type SfxAuditIssue, type SfxCatalogue, type SfxEntry } from "@midnight-radio/core";

/**
 * Read-only views of the sound library (`assets/sfx/index.json`) for the `sfx-library` MCP
 * server. Pure apart from `CatalogueFile.load`. The checks are the ones adaptation and validation
 * use (`@midnight-radio/core`), so an agent sees exactly what the pipeline would accept.
 */

const EMPTY: SfxCatalogue = { version: 1, id: "midnight-radio-sfx-empty", entries: [], musicCues: {} };

/** `index.json`, re-read when it changes on disk. A missing file is an empty library; an invalid one is an error. */
export class CatalogueFile {
  private cached: { mtimeMs: number; size: number; catalogue: SfxCatalogue } | undefined;

  constructor(readonly path: string) {}

  load(): SfxCatalogue {
    let stat;
    try {
      stat = statSync(this.path);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return EMPTY;
      throw err;
    }
    if (this.cached && this.cached.mtimeMs === stat.mtimeMs && this.cached.size === stat.size) return this.cached.catalogue;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(this.path, "utf8"));
    } catch {
      throw new Error("assets/sfx/index.json is not valid JSON");
    }
    const parsed = SfxCatalogueSchema.safeParse(value);
    if (!parsed.success) throw new Error(`assets/sfx/index.json is not a valid sound library: ${parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    this.cached = { mtimeMs: stat.mtimeMs, size: stat.size, catalogue: parsed.data };
    return parsed.data;
  }
}

export interface SfxSummary {
  id: string;
  kind: SfxEntry["kind"];
  title: string;
  tags: string[];
  durationMs: number;
  loopable: boolean;
  licence: string;
}

const summary = (e: SfxEntry): SfxSummary => ({ id: e.id, kind: e.kind, title: e.title, tags: e.tags, durationMs: e.durationMs, loopable: e.loopable, licence: e.source.licence });
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 0);

export interface SearchOptions {
  query: string;
  limit?: number | undefined;
  kind?: SfxEntry["kind"] | undefined;
  loopable?: boolean | undefined;
}

/**
 * Sounds matching any word of the query, best first: a word in the id or title counts most, then
 * a tag, then the generation prompt. An empty query lists everything (by id). At most `limit` (default 10, max 50).
 */
export function searchSfx(catalogue: SfxCatalogue, opts: SearchOptions): SfxSummary[] {
  const limit = Math.min(50, Math.max(1, opts.limit ?? 10));
  const query = [...new Set(words(opts.query))];
  const candidates = catalogue.entries.filter((e) => (opts.kind === undefined || e.kind === opts.kind) && (opts.loopable === undefined || e.loopable === opts.loopable));
  const scored = candidates.map((e) => {
    if (query.length === 0) return { e, score: 1 };
    const name = new Set([...words(e.id), ...words(e.title)]);
    const tags = new Set(e.tags.flatMap(words));
    const prompt = new Set(e.source.type === "generated" ? words(e.source.prompt) : []);
    const score = query.reduce((sum, w) => sum + (name.has(w) ? 3 : 0) + (tags.has(w) ? 2 : 0) + (prompt.has(w) ? 1 : 0), 0);
    return { e, score };
  });
  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.e.id < b.e.id ? -1 : 1))
    .slice(0, limit)
    .map((s) => summary(s.e));
}

/** Who made a sound and under what terms, in one line. */
export function attributionOf(e: SfxEntry): string {
  const s = e.source;
  if (s.type === "generated") return `Generated for Midnight Radio with ${s.model} (revision ${s.revision}), seed ${s.seed}; output licence ${s.licence}.`;
  if (s.type === "cc0") {
    const excerpt = s.excerpt ? `, excerpt ${(s.excerpt.startMs / 1000).toFixed(1)}–${((s.excerpt.startMs + s.excerpt.durationMs) / 1000).toFixed(1)} s` : "";
    return `${s.author ? `By ${s.author}` : "Author not recorded"}, CC0 1.0 (public domain dedication), from ${s.url}${excerpt}.`;
  }
  return `Made for Midnight Radio by ${s.author}; ${s.licence}.${s.note ? ` ${s.note}` : ""}`;
}

export interface SfxDetails extends SfxSummary {
  /** Relative to the repository root. */
  path: string;
  sha256: string;
  peakDb: number;
  attribution: string;
  /** Script music cues this asset is pinned to. */
  musicCues: string[];
}

export function getSfx(catalogue: SfxCatalogue, id: string): SfxDetails | undefined {
  const e = catalogue.entries.find((x) => x.id === id);
  if (!e) return undefined;
  const cues = MUSIC_CUES.filter((c) => catalogue.musicCues[c] === id);
  return { ...summary(e), path: `assets/sfx/${e.path}`, sha256: e.sha256, peakDb: e.peakDb, attribution: attributionOf(e), musicCues: cues };
}

export interface MusicCueList {
  /** The asset each Script music cue plays, or null if none is pinned yet (a Script using it fails validation). */
  cues: Record<(typeof MUSIC_CUES)[number], SfxSummary | null>;
  /** Everything that can be a scene's ambience bed (loopable), sound effects and music. */
  beds: SfxSummary[];
}

export function listMusicCues(catalogue: SfxCatalogue): MusicCueList {
  const index = indexSfx(catalogue);
  const cues = Object.fromEntries(
    MUSIC_CUES.map((c) => {
      const r = resolveMusicCue(catalogue, index, c);
      return [c, "code" in r ? null : summary(r)];
    }),
  ) as MusicCueList["cues"];
  const beds = catalogue.entries.filter((e) => e.loopable).sort((a, b) => (a.id < b.id ? -1 : 1)).map(summary);
  return { cues, beds };
}

export interface ScriptAudit {
  ok: boolean;
  catalogueId: string;
  schemaErrors: string[];
  issues: SfxAuditIssue[];
  note: string;
}

export function auditScript(catalogue: SfxCatalogue, scriptJson: string): ScriptAudit {
  const r = auditScriptSfxJson(catalogue, scriptJson);
  return {
    ok: r.schemaErrors.length === 0 && r.issues.length === 0,
    catalogueId: catalogue.id,
    ...r,
    note: "Checks ids, kinds, loopability, pinned music cues and requested durations. Exact scene timing is only known once speech is rendered.",
  };
}

import { z } from "zod";

/**
 * Character inventory (Req 2.1). The LLM only reports what it sees in each chunk (map); merging,
 * mention counts and descriptions are decided here, deterministically (reduce), so the frozen
 * inventory does not depend on the order chunks were processed or on model-supplied numbers.
 */

export const GENDER_PRESENTATIONS = ["feminine", "masculine", "neutral", "unstated"] as const;
export const AGE_BANDS = ["child", "teen", "young-adult", "adult", "older", "unknown"] as const;
export type GenderPresentation = (typeof GENDER_PRESENTATIONS)[number];
export type AgeBand = (typeof AGE_BANDS)[number];

const label = z.string().trim().min(1).max(80);

/** One character as reported by the model for one chunk. Untrusted: always parse with this. */
export const ChunkCharacterSchema = z.strictObject({
  name: label,
  aliases: z.array(label).max(12),
  genderPresentation: z.enum(GENDER_PRESENTATIONS),
  ageBand: z.enum(AGE_BANDS),
  description: z.string().trim().min(1).max(200),
  speaks: z.boolean(),
});
export const ChunkExtractionSchema = z.strictObject({ characters: z.array(ChunkCharacterSchema).max(60) });

export type ChunkCharacter = z.infer<typeof ChunkCharacterSchema>;

export interface ChunkEvidence {
  /** Position of the chunk in the book (not processing order). */
  chunk: number;
  chapterIdx: number;
  characters: ChunkCharacter[];
}

export interface InventoryCharacter {
  /** Stable within the inventory: derived from the name, unique. */
  id: string;
  name: string;
  /** Other names the text uses for this character; ambiguous ones (shared with another character) excluded. */
  aliases: string[];
  genderPresentation: GenderPresentation;
  ageBand: AgeBand;
  /** From the character's earliest appearance, so it never reveals later plot. */
  description: string;
  speaks: boolean;
  /** Counted in the source text (name and aliases, whole words), not reported by the model. */
  mentionCount: number;
  firstChapterIdx: number;
}

/** Comparison key for a name: NFC, folded apostrophes, collapsed spaces, lower case, no leading "the". */
export function nameKey(name: string): string {
  return name
    .normalize("NFC")
    .replace(/[\u2018\u2019\u02bc]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^the /, "");
}

const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Most frequent value; ties broken by longest, then code-point order. */
function pickSurface(values: string[]): string {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  return [...counts.entries()].sort(([a, ca], [b, cb]) => cb - ca || b.length - a.length || compareStrings(a, b))[0]![0];
}

/** Majority of the stated values; a tie or no stated value gives `fallback`. */
function majority<T extends string>(values: T[], fallback: T): T {
  const counts = new Map<T, number>();
  for (const v of values) if (v !== fallback) counts.set(v, (counts.get(v) ?? 0) + 1);
  const ranked = [...counts.entries()].sort(([, a], [, b]) => b - a);
  if (ranked.length === 0 || (ranked.length > 1 && ranked[0]![1] === ranked[1]![1])) return fallback;
  return ranked[0]![0];
}

interface Entry {
  chunk: number;
  chapterIdx: number;
  character: ChunkCharacter;
  key: string;
  aliasKeys: string[];
}

/**
 * Merge per-chunk reports into one inventory.
 *
 * Reports with the same name are one character. Reports are also linked when one's name is the
 * other's alias, or when they share an alias ("Count Dracula" and "the Count" both called
 * "Dracula"). Two names the model listed separately in the same chunk are different characters
 * and are never merged, however they are linked (Jonathan and Mina Harker, both "Harker").
 * Links are applied in sorted order, so the result is independent of the order of `evidence`
 * and of characters within each chunk. An alias still claimed by two characters is dropped.
 */
export function mergeCharacterEvidence(evidence: ChunkEvidence[]): Omit<InventoryCharacter, "mentionCount">[] {
  const entries: Entry[] = evidence
    .flatMap((e) => e.characters.map((character) => ({ chunk: e.chunk, chapterIdx: e.chapterIdx, character })))
    .map((x) => ({ ...x, key: nameKey(x.character.name), aliasKeys: x.character.aliases.map(nameKey) }))
    .sort((a, b) => a.chunk - b.chunk || compareStrings(a.key, b.key) || compareStrings(JSON.stringify(a.character), JSON.stringify(b.character)));
  const primaryKeys = [...new Set(entries.map((e) => e.key))].sort(compareStrings);

  // Names listed side by side in one chunk are known to be different characters.
  const distinct = new Set<string>();
  const pairKey = (a: string, b: string) => (a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`);
  const byChunk = new Map<number, Set<string>>();
  for (const e of entries) byChunk.set(e.chunk, (byChunk.get(e.chunk) ?? new Set()).add(e.key));
  for (const keys of byChunk.values()) {
    const ks = [...keys];
    for (let i = 0; i < ks.length; i++) for (let j = i + 1; j < ks.length; j++) distinct.add(pairKey(ks[i]!, ks[j]!));
  }

  // Which names claim each alias (a name also "claims" itself).
  const claimants = new Map<string, Set<string>>();
  for (const e of entries) for (const a of [e.key, ...e.aliasKeys]) claimants.set(a, (claimants.get(a) ?? new Set()).add(e.key));

  // Candidate links between names, via an alias they share; applied in sorted order.
  const links: [string, string, string][] = [];
  for (const [alias, names] of claimants) {
    const ns = [...names].sort(compareStrings);
    // An alias claimed by two names known to be different people is contested: it links nobody.
    if (ns.some((a, i) => ns.slice(i + 1).some((b) => distinct.has(pairKey(a, b))))) continue;
    for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) links.push([alias, ns[i]!, ns[j]!]);
  }
  links.sort((x, y) => compareStrings(x[0], y[0]) || compareStrings(x[1], y[1]) || compareStrings(x[2], y[2]));

  // Union-find with "cannot link" constraints between groups.
  const parent = new Map(primaryKeys.map((k) => [k, k]));
  const members = new Map(primaryKeys.map((k) => [k, [k]]));
  const find = (k: string): string => {
    const p = parent.get(k)!;
    return p === k ? k : find(p);
  };
  for (const [, a, b] of links) {
    const [ra, rb] = [find(a), find(b)];
    if (ra === rb) continue;
    const conflict = members.get(ra)!.some((x) => members.get(rb)!.some((y) => distinct.has(pairKey(x, y))));
    if (conflict) continue;
    const [root, child] = ra < rb ? [ra, rb] : [rb, ra];
    parent.set(child, root);
    members.set(root, [...members.get(root)!, ...members.get(child)!]);
    members.delete(child);
  }

  const groupOf = new Map(primaryKeys.map((k) => [k, find(k)]));
  const groups = new Map<string, Entry[]>();
  for (const e of entries) groups.set(groupOf.get(e.key)!, [...(groups.get(groupOf.get(e.key)!) ?? []), e]);
  // An alias is ambiguous if names in more than one final character claim it.
  const ambiguous = (alias: string) => new Set([...(claimants.get(alias) ?? [])].map((k) => groupOf.get(k))).size > 1;

  const merged = [...groups.values()].map((group) => {
    const name = pickSurface(group.map((e) => e.character.name));
    const nameK = nameKey(name);
    const aliasSurfaces = new Map<string, string[]>();
    for (const e of group) {
      for (const s of [e.character.name, ...e.character.aliases]) {
        const k = nameKey(s);
        if (k === nameK || ambiguous(k)) continue;
        // "The Count" at the start of a report reads as "the Count" mid-sentence.
        aliasSurfaces.set(k, [...(aliasSurfaces.get(k) ?? []), s.trim().replace(/^The /, "the ")]);
      }
    }
    const firstChunk = Math.min(...group.map((e) => e.chunk));
    const earliest = group.filter((e) => e.chunk === firstChunk).map((e) => e.character.description);
    return {
      name,
      aliases: [...aliasSurfaces.entries()].sort(([a], [b]) => compareStrings(a, b)).map(([, surfaces]) => pickSurface(surfaces)),
      genderPresentation: majority(group.map((e) => e.character.genderPresentation), "unstated" as GenderPresentation),
      ageBand: majority(group.map((e) => e.character.ageBand), "unknown" as AgeBand),
      description: earliest.sort((a, b) => b.length - a.length || compareStrings(a, b))[0]!,
      speaks: group.some((e) => e.character.speaks),
      firstChapterIdx: Math.min(...group.map((e) => e.chapterIdx)),
    };
  });

  merged.sort((a, b) => compareStrings(nameKey(a.name), nameKey(b.name)) || compareStrings(a.name, b.name));
  const used = new Set<string>();
  return merged.map((c) => {
    const base = `ch-${slug(c.name) || "character"}`;
    let id = base;
    for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
    used.add(id);
    return { id, ...c };
  });
}

function slug(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Count each character's mentions in the source: every name and alias as a whole word, case
 * sensitive (so the verb "count" is not "the Count"), apostrophes folded, longest match first
 * and never overlapping (so "Count Dracula" counts once, for Dracula). A leading "the" may be
 * capitalised. Names shared by several characters are not counted for any of them.
 */
export function countMentions(texts: string[], characters: Pick<InventoryCharacter, "id" | "name" | "aliases">[]): Map<string, number> {
  const owner = new Map<string, string | null>(); // normalised surface → character id, or null if shared
  for (const c of characters) {
    for (const s of [c.name, ...c.aliases]) {
      const surface = surfaceKey(s);
      if (!surface) continue;
      const prev = owner.get(surface);
      owner.set(surface, prev === undefined || prev === c.id ? c.id : null);
    }
  }
  const counts = new Map(characters.map((c) => [c.id, 0]));
  const surfaces = [...owner.keys()].sort((a, b) => b.length - a.length || compareStrings(a, b));
  if (surfaces.length === 0) return counts;
  const pattern = surfaces.map((s) => escapeRegExp(s).replace(/^the /, "[Tt]he ").replace(/ /g, "\\s+")).join("|");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${pattern})(?![\\p{L}\\p{N}])`, "gu");
  for (const text of texts) {
    for (const m of foldApostrophes(text).matchAll(re)) {
      const id = owner.get(surfaceKey(m[0]));
      if (id) counts.set(id, counts.get(id)! + 1);
    }
  }
  return counts;
}

const foldApostrophes = (s: string) => s.normalize("NFC").replace(/[\u2018\u2019\u02bc]/g, "'");

/** A name as it appears in text, normalised only where texts vary: apostrophes, spacing, a leading "The". */
const surfaceKey = (s: string) => foldApostrophes(s).replace(/\s+/g, " ").trim().replace(/^The /, "the ");

/** Merge evidence and attach source-derived mention counts: the inventory to freeze. */
export function buildInventory(evidence: ChunkEvidence[], texts: string[]): InventoryCharacter[] {
  const merged = mergeCharacterEvidence(evidence);
  const counts = countMentions(texts, merged);
  return merged.map((c) => ({ ...c, mentionCount: counts.get(c.id) ?? 0 }));
}

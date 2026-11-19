import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Persisted Cast (Req 2.2, 2.3). Plain types only, so this package does not depend on the domain
 * package; the shapes match `@midnight-radio/core`'s inventory and voice assignment.
 */

export type CastRole = "announcer" | "narrator" | "character";
export type VoiceFitLevel = "good" | "fair" | "poor";

export interface CastMember {
  name: string;
  role: CastRole;
  aliases: string[];
  genderPresentation: string | null;
  ageBand: string | null;
  description: string | null;
  /** Null for characters who never speak. */
  voiceId: string | null;
  voiceFit: VoiceFitLevel | null;
  mentionCount: number;
  speaks: boolean;
}

export interface CastPin {
  catalogueId: string;
  catalogueHash: string;
}

export interface StoredCast {
  pin: CastPin;
  announcer: CastMember;
  narrator: CastMember;
  /** Most mentioned first, then by name. */
  characters: CastMember[];
}

/** The Book already has a Cast. It is never replaced automatically (Req 2.3). */
export class CastFrozenError extends Error {
  constructor(readonly bookId: string) {
    super(`Book ${bookId} already has a Cast; it is not reassigned automatically.`);
    this.name = "CastFrozenError";
  }
}

const ROLES = new Set<CastRole>(["announcer", "narrator", "character"]);

function validate(members: CastMember[]): void {
  for (const role of ["announcer", "narrator"] as const) {
    const m = members.filter((x) => x.role === role);
    if (m.length !== 1) throw new Error(`a Cast needs exactly one ${role}, got ${m.length}`);
    if (!m[0]!.voiceId) throw new Error(`the ${role} needs a voice`);
  }
  for (const m of members) {
    if (!ROLES.has(m.role)) throw new Error(`unknown cast role "${m.role}"`);
    if (!m.name.trim()) throw new Error("cast members need a name");
    if (m.role === "character" && m.speaks && !m.voiceId) throw new Error(`speaking character "${m.name}" has no voice`);
    if (m.role === "character" && !m.speaks && m.voiceId) throw new Error(`silent character "${m.name}" must not hold a voice`);
  }
}

/**
 * Write a Book's Cast and pin the voice catalogue. Does not open a transaction: call it inside
 * `JobQueue.publish` (fenced by the job lease), or use `saveCast`. Throws CastFrozenError if the
 * Book already has a Cast. Voice reuse is rejected by the database's unique index.
 */
export function writeCast(db: DatabaseSync, bookId: string, pin: CastPin, members: CastMember[], newId: () => string = randomUUID): void {
  validate(members);
  const book = db.prepare("SELECT voice_catalogue_hash AS hash FROM books WHERE id = ?").get(bookId) as { hash: string | null } | undefined;
  if (!book) throw new Error(`unknown book ${bookId}`);
  if (book.hash !== null) throw new CastFrozenError(bookId);

  const insert = db.prepare(
    `INSERT INTO cast_members (id, book_id, name, aliases_json, role, gender_hint, age_band, voice_id, description, mention_count, speaks, voice_fit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const m of members) {
    insert.run(newId(), bookId, m.name, JSON.stringify(m.aliases), m.role, m.genderPresentation, m.ageBand, m.voiceId, m.description, m.mentionCount, m.speaks ? 1 : 0, m.voiceFit);
  }
  db.prepare("UPDATE books SET voice_catalogue_id = ?, voice_catalogue_hash = ? WHERE id = ?").run(pin.catalogueId, pin.catalogueHash, bookId);
}

/** `writeCast` in its own transaction. */
export function saveCast(db: DatabaseSync, bookId: string, pin: CastPin, members: CastMember[], newId?: () => string): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    writeCast(db, bookId, pin, members, newId);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

interface Row {
  name: string;
  role: CastRole;
  aliases_json: string;
  gender_hint: string | null;
  age_band: string | null;
  description: string | null;
  voice_id: string | null;
  voice_fit: VoiceFitLevel | null;
  mention_count: number;
  speaks: number;
}

/** The Book's frozen Cast, or undefined if it has none yet. */
export function loadCast(db: DatabaseSync, bookId: string): StoredCast | undefined {
  const book = db.prepare("SELECT voice_catalogue_id AS id, voice_catalogue_hash AS hash FROM books WHERE id = ?").get(bookId) as { id: string | null; hash: string | null } | undefined;
  if (!book || book.hash === null || book.id === null) return undefined;
  const rows = db
    .prepare(
      `SELECT name, role, aliases_json, gender_hint, age_band, description, voice_id, voice_fit, mention_count, speaks
       FROM cast_members WHERE book_id = ? ORDER BY mention_count DESC, name COLLATE BINARY, rowid`,
    )
    .all(bookId) as unknown as Row[];
  const members = rows.map(
    (r): CastMember => ({
      name: r.name,
      role: r.role,
      aliases: JSON.parse(r.aliases_json) as string[],
      genderPresentation: r.gender_hint,
      ageBand: r.age_band,
      description: r.description,
      voiceId: r.voice_id,
      voiceFit: r.voice_fit,
      mentionCount: Number(r.mention_count),
      speaks: r.speaks === 1,
    }),
  );
  return {
    pin: { catalogueId: book.id, catalogueHash: book.hash },
    announcer: members.find((m) => m.role === "announcer")!,
    narrator: members.find((m) => m.role === "narrator")!,
    characters: members.filter((m) => m.role === "character"),
  };
}

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
  for (const m of members) validateMember(m);
}

function validateMember(m: CastMember): void {
  if (!ROLES.has(m.role)) throw new Error(`unknown cast role "${m.role}"`);
  if (!m.name.trim()) throw new Error("cast members need a name");
  if (m.role === "character" && m.speaks && !m.voiceId) throw new Error(`speaking character "${m.name}" has no voice`);
  if (m.role === "character" && !m.speaks && m.voiceId) throw new Error(`silent character "${m.name}" must not hold a voice`);
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

/** The Book has no Cast yet, or its Cast is pinned to a different voice catalogue. Nothing was changed. */
export class CastPinMismatchError extends Error {
  constructor(
    readonly bookId: string,
    message: string,
  ) {
    super(message);
    this.name = "CastPinMismatchError";
  }
}

/** A Cast change was refused by the stored Cast's rules; nothing was changed. The message is safe to show users. */
export class CastConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CastConflictError";
  }
}

function inTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

function requirePin(db: DatabaseSync, bookId: string, pin: CastPin): void {
  const book = db.prepare("SELECT voice_catalogue_id AS id, voice_catalogue_hash AS hash FROM books WHERE id = ?").get(bookId) as { id: string | null; hash: string | null } | undefined;
  if (!book) throw new Error(`unknown book ${bookId}`);
  if (book.hash === null) throw new CastPinMismatchError(bookId, `Book ${bookId} has no Cast yet.`);
  if (book.id !== pin.catalogueId || book.hash !== pin.catalogueHash) {
    throw new CastPinMismatchError(bookId, `Book ${bookId}'s Cast is pinned to another voice catalogue; reload the Cast and try again.`);
  }
}

const isUniqueViolation = (err: unknown) => err instanceof Error && /UNIQUE constraint failed/.test(err.message);

/**
 * Add characters a chapter introduced to a frozen Cast (Req 2.4), recording the chapter in
 * `added_in_chapter`. Existing members are not touched. Does not open a transaction: call it
 * inside `JobQueue.publish`, or use `addCastMembers`. A voice or name already in the Cast is
 * refused by the unique indexes, so a stale caller cannot share a voice.
 */
export function writeCastAdditions(
  db: DatabaseSync,
  bookId: string,
  pin: CastPin,
  additions: CastMember[],
  addedInChapterId: string | null,
  newId: () => string = randomUUID,
): void {
  requirePin(db, bookId, pin);
  for (const m of additions) {
    if (m.role !== "character") throw new Error(`only characters can be added to a Cast, not the ${m.role}`);
    validateMember(m);
  }
  if (addedInChapterId !== null) {
    const chapter = db.prepare("SELECT book_id AS bookId FROM chapters WHERE id = ?").get(addedInChapterId) as { bookId: string } | undefined;
    if (chapter?.bookId !== bookId) throw new Error(`chapter ${addedInChapterId} is not part of book ${bookId}`);
  }
  const insert = db.prepare(
    `INSERT INTO cast_members (id, book_id, name, aliases_json, role, gender_hint, age_band, voice_id, description, mention_count, speaks, voice_fit, added_in_chapter)
     VALUES (?, ?, ?, ?, 'character', ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const m of additions) {
    try {
      insert.run(newId(), bookId, m.name, JSON.stringify(m.aliases), m.genderPresentation, m.ageBand, m.voiceId, m.description, m.mentionCount, m.speaks ? 1 : 0, m.voiceFit, addedInChapterId);
    } catch (err) {
      if (isUniqueViolation(err)) throw new CastConflictError(`"${m.name}" or their voice is already in the Cast.`);
      throw err;
    }
  }
}

/** `writeCastAdditions` in its own transaction. */
export function addCastMembers(db: DatabaseSync, bookId: string, pin: CastPin, additions: CastMember[], addedInChapterId: string | null, newId?: () => string): void {
  inTransaction(db, () => writeCastAdditions(db, bookId, pin, additions, addedInChapterId, newId));
}

export interface VoiceChangeRecord {
  /** The stored character name. */
  name: string;
  voiceId: string;
  voiceFit: VoiceFitLevel;
}

export interface CastEditResult {
  /** Characters whose voice actually changed, in the order given. */
  changed: string[];
  /** Dialogue segments of those characters that now need rendering again. */
  segmentsInvalidated: number;
  /** Chapters with invalidated speech, in book order: re-render, then re-mix (audio, VTT, markers). */
  affectedChapterIds: string[];
}

/**
 * Change characters' voices (Req 2.5) and invalidate only their speech, in one transaction: their
 * dialogue segments lose cache key, audio and duration and go back to `pending` (every other
 * segment keeps its audio, and its cache key still hits), and the episodes of the chapters those
 * segments belong to are marked `stale`, so the mixer rebuilds the audio, VTT and chapter markers
 * from the new durations. Changes apply together, so two characters can swap voices; a voice
 * held by anyone else (the Announcer and Narrator included) is refused by the unique index.
 * Validate edits with `planVoiceEdits` first for friendly messages; this re-checks what it must.
 */
export function editCastVoices(db: DatabaseSync, bookId: string, pin: CastPin, changes: VoiceChangeRecord[]): CastEditResult {
  return inTransaction(db, () => writeVoiceChanges(db, bookId, pin, changes));
}

/** `editCastVoices` without its own transaction, for callers that already hold one. */
export function writeVoiceChanges(db: DatabaseSync, bookId: string, pin: CastPin, changes: VoiceChangeRecord[]): CastEditResult {
  requirePin(db, bookId, pin);
  const seen = new Set<string>();
  const get = db.prepare("SELECT id, role, speaks, voice_id AS voiceId FROM cast_members WHERE book_id = ? AND name = ?");
  const effective: (VoiceChangeRecord & { id: string })[] = [];
  for (const c of changes) {
    if (seen.has(c.name)) throw new CastConflictError(`"${c.name}" is edited twice in one change.`);
    seen.add(c.name);
    const row = get.get(bookId, c.name) as { id: string; role: CastRole; speaks: number; voiceId: string | null } | undefined;
    if (!row) throw new CastConflictError(`"${c.name}" is not in this Book's Cast.`);
    if (row.role !== "character") throw new CastConflictError(`The ${row.role} keeps its fixed voice.`);
    if (row.speaks !== 1 || row.voiceId === null) throw new CastConflictError(`"${c.name}" never speaks, so they have no voice to change.`);
    if (row.voiceId !== c.voiceId) effective.push({ ...c, id: row.id });
  }
  if (effective.length === 0) return { changed: [], segmentsInvalidated: 0, affectedChapterIds: [] };

  // Release the old voices first so that swaps within one change do not trip the unique index.
  const release = db.prepare("UPDATE cast_members SET voice_id = NULL WHERE id = ?");
  for (const c of effective) release.run(c.id);
  const assign = db.prepare("UPDATE cast_members SET voice_id = ?, voice_fit = ? WHERE id = ?");
  for (const c of effective) {
    try {
      assign.run(c.voiceId, c.voiceFit, c.id);
    } catch (err) {
      if (isUniqueViolation(err)) throw new CastConflictError(`Voice "${c.voiceId}" already belongs to someone else in the Cast.`);
      throw err;
    }
  }

  const names = effective.map((c) => c.name);
  const marks = names.map(() => "?").join(", ");
  const bookSegments = `SELECT g.id FROM segments g JOIN scripts s ON s.id = g.script_id JOIN chapters ch ON ch.id = s.chapter_id
    WHERE ch.book_id = ? AND g.kind = 'dialogue' AND g.speaker IN (${marks})`;
  const affected = db
    .prepare(
      `SELECT DISTINCT ch.id FROM segments g JOIN scripts s ON s.id = g.script_id JOIN chapters ch ON ch.id = s.chapter_id
       WHERE ch.book_id = ? AND g.kind = 'dialogue' AND g.speaker IN (${marks}) ORDER BY ch.idx, ch.part`,
    )
    .all(bookId, ...names) as { id: string }[];
  const invalidated = db
    .prepare(`UPDATE segments SET cache_key = NULL, audio_path = NULL, duration_ms = NULL, status = 'pending' WHERE id IN (${bookSegments})`)
    .run(bookId, ...names);
  const stale = db.prepare("UPDATE episodes SET stale = 1 WHERE chapter_id = ?");
  for (const ch of affected) stale.run(ch.id);
  return { changed: names, segmentsInvalidated: Number(invalidated.changes), affectedChapterIds: affected.map((r) => r.id) };
}

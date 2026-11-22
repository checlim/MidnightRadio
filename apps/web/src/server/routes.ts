import { join } from "node:path";
import type { ClonableCatalogue } from "@midnight-radio/core";
import { loadCast } from "@midnight-radio/db";
import { loadBookCatalogue, loadSeriesCatalogue } from "@midnight-radio/worker";
import type { WebConfig } from "./config";
import { HttpError, bookView, editCast, readCapped, startGeneration, toResponse, uploadBook } from "./books";
import { guarded } from "./guard";

/**
 * The generation API (Req 1.1, 2.5, 8.2, 8.5). Each handler goes through `guarded` first, so
 * with generation disabled every one of them answers 404 before reading the request.
 *
 *   POST /api/books                 upload an EPUB (raw body, file name in x-file-name)
 *   GET  /api/books/:id             the Book: chapters, episode progress, Cast and voices
 *   POST /api/books/:id/generate    { chapters, charBudget }: queue the chosen chapters
 *   POST /api/books/:id/cast        { changes: [{ name, voiceId }] }: change voices, re-render
 */

type Params = { params: Promise<{ id: string }> };
const BOOK_ID = /^bk-[0-9a-f]{16}$/;
const noStore = { "cache-control": "no-store" };

async function bookId(ctx: Params): Promise<string> {
  const { id } = await ctx.params;
  if (!BOOK_ID.test(id)) throw new HttpError(404, "There is no such book.");
  return id;
}

/** The voices a book can use: the catalogue its Cast is pinned to (its own designed voices, or the series voices for an older book). */
async function bookVoices(config: WebConfig, db: import("node:sqlite").DatabaseSync, bookId: string): Promise<ClonableCatalogue> {
  const series = loadSeriesCatalogue(config.repoRoot);
  const cast = loadCast(db, bookId);
  if (!cast) return series;
  return (await loadBookCatalogue(join(config.dataDir, "voices"), bookId, series, join(config.repoRoot, "assets/voices"), cast.pin)).catalogue;
}

async function jsonBody(request: Request): Promise<unknown> {
  const bytes = await readCapped(request, 64 * 1024);
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, "The request body is not JSON.");
  }
}

export const uploadRoute = (request: Request) =>
  guarded(request, "write", async ({ config, db }) => {
    try {
      const name = decodeURIComponent(request.headers.get("x-file-name") ?? "");
      const book = await uploadBook(db(), config, name, await readCapped(request));
      return Response.json(book, { status: 201, headers: noStore });
    } catch (err) {
      return toResponse(err);
    }
  });

export const bookRoute = (request: Request, ctx: Params) =>
  guarded(request, "read", async ({ config, db }) => {
    try {
      const id = await bookId(ctx);
      const book = bookView(db(), config, id);
      if (!book) throw new HttpError(404, "There is no such book.");
      const voices = (await bookVoices(config, db(), id)).voices.map(({ id, name, gender, ageBands, description }) => ({ id, name, gender, ageBands, description: description ?? null }));
      return Response.json({ ...book, voices }, { headers: noStore });
    } catch (err) {
      return toResponse(err);
    }
  });

export const generateRoute = (request: Request, ctx: Params) =>
  guarded(request, "write", async ({ config, db }) => {
    try {
      const id = await bookId(ctx);
      return Response.json(startGeneration(db(), config, id, await jsonBody(request)), { status: 202, headers: noStore });
    } catch (err) {
      return toResponse(err);
    }
  });

export const castRoute = (request: Request, ctx: Params) =>
  guarded(request, "write", async ({ config, db }) => {
    try {
      const id = await bookId(ctx);
      return Response.json(editCast(db(), await bookVoices(config, db(), id), id, await jsonBody(request)), { headers: noStore });
    } catch (err) {
      return toResponse(err);
    }
  });

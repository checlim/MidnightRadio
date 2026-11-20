/**
 * Turn an EPUB into radio-drama stations, with no choices left to a person.
 *
 *   pnpm generate <book.epub> [--chapters all|1,3-5] [--list]
 *
 * Reads settings from the environment or the repo's .env. Checks everything first (LLM key and
 * model, daily caps, the voice catalogue, Qwen3-TTS on LOCAL_AUDIO_URL, the sound library with a
 * pinned theme, ffmpeg) and stops with a list of what to fix before any paid call. Then casts the
 * whole book once, adapts each chosen chapter (with repair), renders its speech, mixes it and
 * publishes it to <DATA_DIR>/broadcast/ (episodes and stations.json, served at /broadcast/). Run it again to resume: the Cast,
 * valid Scripts, rendered lines and finished episodes are kept in DATA_DIR.
 *
 * --list prints the chapters and their numbers and exits (no checks, nothing written).
 * Exit status: 0 every chosen episode is on air, 1 some could not be produced, 2 stopped.
 */
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { BudgetLedger, openDb } from "@midnight-radio/db";
import { IngestError, ingestEpub } from "@midnight-radio/ingest";
import { BROADCAST_DIR, DB_FILE, RENDER_CACHE_DIR } from "../src/config.js";
import { BudgetStopError, GenerateError, generateBook, needsLlm } from "../src/generate/pipeline.js";
import { planBook, selectChapters } from "../src/generate/plan.js";
import { preflight } from "../src/generate/preflight.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
if (existsSync(join(root, ".env"))) process.loadEnvFile(join(root, ".env"));
// pnpm runs this from apps/worker; paths on the command line are relative to where it was typed.
const cwd = process.env.INIT_CWD ?? process.cwd();

function stop(message: string): never {
  console.error(`stopped: ${message}`);
  process.exit(2);
}

const { values, positionals } = parseArgs({ allowPositionals: true, options: { chapters: { type: "string", default: "all" }, list: { type: "boolean", default: false } } });
if (positionals.length !== 1) stop("usage: pnpm generate <book.epub> [--chapters all|1,3-5] [--list]");
const epubPath = resolve(cwd, positionals[0]!);
const bytes = new Uint8Array(await readFile(epubPath).catch(() => stop(`cannot read ${epubPath}`)));
const book = await ingestEpub(bytes).catch((err: unknown) => stop(err instanceof IngestError ? `this EPUB cannot be used: ${err.message}` : String(err)));
const plan = planBook(book, bytes);
const chapterCount = book.chapters.length;
if (chapterCount === 0) stop("the EPUB has no story chapters");

if (values.list) {
  console.log(`${plan.title}${plan.author ? ` by ${plan.author}` : ""}: ${chapterCount} chapters`);
  for (const ch of book.chapters) console.log(`${String(ch.idx + 1).padStart(4)}  ${ch.title}  (${ch.wordCount} words${ch.parts.length > 1 ? `, ${ch.parts.length} episodes` : ""})`);
  process.exit(0);
}

let chapters: Set<number>;
try {
  chapters = selectChapters(values.chapters, chapterCount);
} catch (err) {
  stop((err as Error).message);
}

const dataDir = resolve(root, process.env.DATA_DIR?.trim() || "/data");
await mkdir(dataDir, { recursive: true }).catch(() => stop(`cannot create DATA_DIR ${dataDir}; set DATA_DIR in .env (e.g. ./data)`));
const db = openDb(join(dataDir, DB_FILE));
try {
  const check = await preflight(
    process.env,
    { voiceCatalogue: join(root, "assets/voices/catalogue.json"), sfxIndex: join(root, "assets/sfx/index.json"), styleGuide: join(root, ".kiro/steering/radio-voice.md") },
    needsLlm(db, plan, { chapters, charBudget: 0 }),
  );
  if (!check.ok) stop(`fix these first, then run again:\n${check.problems.map((p) => `  - ${p}`).join("\n")}`);
  const { ready } = check;
  for (const n of ready.notes) console.log(`note: ${n}`);
  console.log(`${plan.title}: ${chapters.size} of ${chapterCount} chapters, voices by ${ready.tts.identity.model}${ready.llm ? `, script by ${ready.llm.id}` : ""}`);

  const results = await generateBook(plan, { chapters, charBudget: ready.budget.bookTtsCharCeiling }, {
    db,
    ledger: new BudgetLedger(db, ready.budget),
    llm: ready.llm,
    tts: ready.tts,
    voices: ready.voices,
    sfx: ready.sfx,
    sfxDir: join(root, "assets/sfx"),
    styleGuide: ready.styleGuide,
    cacheDir: join(dataDir, RENDER_CACHE_DIR),
    broadcastDir: join(dataDir, BROADCAST_DIR),
    log: (m) => console.log(m),
  });
  const failed = results.filter((r) => r.status === "failed");
  console.log(`\n${results.length - failed.length} of ${results.length} episode(s) on air; start the player with pnpm --filter @midnight-radio/web dev`);
  for (const f of failed) console.log(`  episode ${f.episodeNumber} (${f.title}): ${f.status === "failed" ? f.reason : ""}`);
  process.exitCode = failed.length > 0 ? 1 : 0;
} catch (err) {
  if (err instanceof GenerateError || err instanceof BudgetStopError) stop(err.message);
  throw err;
} finally {
  db.close();
}

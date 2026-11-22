import { setTimeout as sleep } from "node:timers/promises";
import { nameKey } from "@midnight-radio/core";
import { BudgetExceededError, type BudgetLedger } from "@midnight-radio/db";
import { z } from "zod";
import { providerSchema } from "./casting.js";
import { LlmError, estimateTokens, type LlmProvider, type LlmRequest, type LlmResponse } from "./provider.js";

/**
 * Voice briefs: for each speaking character, a short written description of the voice to design
 * (gender, age, pitch, pace, timbre, accent only where the book states it, temperament). The
 * voice-design model turns each brief into the character's reference clip. Briefs describe
 * voices, never people: a brief that points at a real person or another voice is refused and
 * asked for again (product rule: no cloning or imitation of real people).
 */

export const MIN_BRIEF_CHARS = 20;
export const MAX_BRIEF_CHARS = 300;
/** Characters per request, so a large cast does not crowd one reply. */
export const BRIEF_BATCH = 20;

export interface BriefCharacter {
  name: string;
  aliases: string[];
  genderPresentation: string | null;
  ageBand: string | null;
  description: string | null;
}

export interface VoiceBriefOptions {
  provider: LlmProvider;
  ledger: Pick<BudgetLedger, "withReservation">;
  bookId: string;
  book: { title: string; author: string | null };
  /** Speaking characters only. */
  characters: BriefCharacter[];
  jobId?: string;
  fence?: () => void;
  signal?: AbortSignal;
  maxAttempts?: number;
  delay?: (ms: number, signal?: AbortSignal) => Promise<unknown>;
}

export class VoiceBriefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VoiceBriefError";
  }
}

const BriefReplySchema = z.strictObject({
  voices: z.array(z.strictObject({ name: z.string().min(1).max(200), brief: z.string().min(1).max(1_000) })).max(BRIEF_BATCH * 2),
});
const SCHEMA = { name: "voice_briefs", schema: providerSchema(BriefReplySchema) };

/** Phrases that point a voice at someone else instead of describing it. */
const IMITATION = /\b(sounds?\s+like|in\s+the\s+style\s+of|impersonat\w*|imitat\w*|impression\s+of|reminiscent\s+of|à\s+la)\b/i;

/** Why a brief cannot be used, or null if it can. Pure. */
export function briefProblem(brief: string): string | null {
  const b = brief.trim();
  if (b.length < MIN_BRIEF_CHARS) return `is shorter than ${MIN_BRIEF_CHARS} characters`;
  if (b.length > MAX_BRIEF_CHARS) return `is longer than ${MAX_BRIEF_CHARS} characters`;
  if (IMITATION.test(b)) return "compares the voice to someone; describe the voice itself";
  if (/https?:\/\/|www\./i.test(b)) return "contains a link";
  return null;
}

export const VOICE_BRIEF_SYSTEM_PROMPT = `You cast voices for a 1940s radio drama made from a novel. For each character listed, write one voice brief: a single description of how their voice sounds, for a voice-design model.

Each brief, ${MIN_BRIEF_CHARS} to ${MAX_BRIEF_CHARS} characters, covers: gender and approximate age; pitch and register; pace and rhythm; timbre (e.g. gravelly, breathy, clear, nasal); temperament as it shows in the voice; an accent or dialect only if the book states the character's origin or speech. Plain English, no lists.

Rules:
- Describe the voice itself. Never name or compare to a real person, actor, singer or celebrity, and never say a voice "sounds like" anyone or anything else.
- Use only what the book supports; do not invent backstory. Do not reveal plot.
- Make the voices in one book clearly different from each other.
- Return every character listed, with the name exactly as given, and nothing else, as JSON only.`;

function userPrompt(book: VoiceBriefOptions["book"], batch: BriefCharacter[]): string {
  const lines = batch.map((c) => {
    const facts = [c.genderPresentation && c.genderPresentation !== "unstated" ? c.genderPresentation : null, c.ageBand && c.ageBand !== "unknown" ? c.ageBand : null].filter(Boolean).join(", ");
    return `- ${c.name}${c.aliases.length ? ` (also: ${c.aliases.join(", ")})` : ""}${facts ? `; ${facts}` : ""}${c.description ? `; ${c.description}` : ""}`;
  });
  return `Book: "${book.title}"${book.author ? ` by ${book.author}` : ""}.\nCharacters:\n${lines.join("\n")}`;
}

/** Check a reply against the batch: every name once, every brief usable. Pure. */
export function checkBriefReply(text: string, batch: readonly BriefCharacter[]): { ok: true; briefs: Map<string, string> } | { ok: false; error: string } {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "it was not JSON" };
  }
  const parsed = BriefReplySchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.issues.slice(0, 3).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ") };
  const wanted = new Map(batch.map((c) => [nameKey(c.name), c.name]));
  const briefs = new Map<string, string>();
  const problems: string[] = [];
  for (const v of parsed.data.voices) {
    const name = wanted.get(nameKey(v.name));
    if (!name) {
      problems.push(`"${v.name.slice(0, 60)}" is not one of the characters listed`);
      continue;
    }
    if (briefs.has(name)) {
      problems.push(`"${name}" appears twice`);
      continue;
    }
    const why = briefProblem(v.brief);
    if (why) problems.push(`the brief for "${name}" ${why}`);
    else briefs.set(name, v.brief.trim());
  }
  for (const name of wanted.values()) if (!briefs.has(name) && !problems.some((p) => p.includes(`"${name}"`))) problems.push(`"${name}" is missing`);
  return problems.length > 0 ? { ok: false, error: problems.slice(0, 8).join("; ") } : { ok: true, briefs };
}

/**
 * Write a brief for every character, in batches, each request reserved against the LLM budget.
 * Invalid replies are sent back with what was wrong (our own summary); transient failures retry.
 */
export async function writeVoiceBriefs(opts: VoiceBriefOptions): Promise<Map<string, string>> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const delay = opts.delay ?? ((ms: number, signal?: AbortSignal) => sleep(ms, undefined, { signal }));
  const out = new Map<string, string>();
  for (let i = 0; i < opts.characters.length; i += BRIEF_BATCH) {
    const batch = opts.characters.slice(i, i + BRIEF_BATCH);
    const user = userPrompt(opts.book, batch);
    let feedback = "";
    for (let attempt = 1; ; attempt++) {
      opts.signal?.throwIfAborted();
      const maxOutputTokens = 200 + 120 * batch.length;
      const request: LlmRequest = { system: VOICE_BRIEF_SYSTEM_PROMPT, user: feedback ? `${user}\n\n${feedback}` : user, jsonSchema: SCHEMA, maxOutputTokens, ...(opts.signal ? { signal: opts.signal } : {}) };
      let response: LlmResponse;
      try {
        response = await opts.ledger.withReservation(
          { bookId: opts.bookId, chapterId: null, jobId: opts.jobId ?? null, llmInputTokens: estimateTokens(request.system + request.user), llmMaxOutputTokens: maxOutputTokens },
          async () => {
            const r = await opts.provider.complete(request);
            return { value: r, usage: { ...(r.usage ? { llmInputTokens: r.usage.inputTokens, llmOutputTokens: r.usage.outputTokens } : {}), ...(r.requestId ? { providerRequestId: r.requestId } : {}) } };
          },
          opts.fence ? { fence: opts.fence } : {},
        );
      } catch (err) {
        if (err instanceof BudgetExceededError || !(err instanceof LlmError) || !err.retryable || attempt >= maxAttempts) throw err;
        await delay(1_000 * 2 ** (attempt - 1), opts.signal);
        continue;
      }
      const checked = checkBriefReply(response.text, batch);
      if (checked.ok) {
        for (const [name, brief] of checked.briefs) out.set(name, brief);
        break;
      }
      if (attempt >= maxAttempts) throw new VoiceBriefError(`The model gave no usable voice briefs for ${batch.length} character(s) after ${maxAttempts} attempts (${checked.error}).`);
      feedback = `Your previous reply was not accepted: ${checked.error}. Reply again with every character listed, as JSON only.`;
    }
  }
  return out;
}

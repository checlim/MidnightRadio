import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { SfxCatalogueSchema, VoiceCatalogueSchema, requireClonable, type SfxCatalogue, type VoiceCatalogue } from "@midnight-radio/core";
import { loadBudgetConfig, type BudgetConfig } from "@midnight-radio/db";
import { checkLlmAccess, createOpenAiCompatibleProvider, loadLlmConfig, loadStyleGuide, type LlmProvider } from "@midnight-radio/llm";
import { QwenTtsProvider, loadQwenConfig, type QwenTtsOptions, type TtsProvider } from "@midnight-radio/tts";

/**
 * Everything the run needs, checked before any paid call. Every check runs, so one message lists
 * every problem with what to set or start. Nothing here spends tokens: the LLM key is checked with
 * the endpoint's model list.
 */

export interface PreflightPaths {
  voiceCatalogue: string;
  sfxIndex: string;
  styleGuide: string;
}

export interface Ready {
  budget: BudgetConfig;
  llm: LlmProvider | null;
  tts: TtsProvider;
  voices: VoiceCatalogue;
  sfx: SfxCatalogue;
  styleGuide: string;
  /** Things worth knowing that do not stop the run. */
  notes: string[];
}

export interface PreflightHooks {
  connectTts?: (opts: QwenTtsOptions) => Promise<TtsProvider>;
  fetch?: typeof fetch;
  hasProgram?: (name: string) => boolean;
}

const programOnPath = (name: string) => spawnSync(name, ["-version"], { stdio: "ignore" }).status === 0;
const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err));

export async function preflight(env: Record<string, string | undefined>, paths: PreflightPaths, needsLlm: boolean, hooks: PreflightHooks = {}): Promise<{ ok: true; ready: Ready } | { ok: false; problems: string[] }> {
  const problems: string[] = [];
  const notes: string[] = [];

  let budget: BudgetConfig | null = null;
  try {
    budget = loadBudgetConfig(env);
    if (needsLlm && budget.dailyLlmTokens === 0) problems.push("LLM calls are switched off: set GLOBAL_DAILY_LLM_TOKEN_LIMIT in .env (tokens per UTC day, e.g. 2000000)");
    if (budget.dailyTtsChars === 0) problems.push("speech rendering is switched off: set GLOBAL_DAILY_TTS_CHAR_LIMIT in .env (characters per UTC day, e.g. 1000000)");
  } catch (err) {
    problems.push(messageOf(err));
  }

  let llm: LlmProvider | null = null;
  if (needsLlm) {
    try {
      const config = loadLlmConfig(env);
      if (!config) problems.push("no LLM configured: set LLM_API_KEY and LLM_MODEL in .env (and LLM_BASE_URL for an endpoint other than OpenAI)");
      else {
        try {
          const access = await checkLlmAccess(config, hooks.fetch);
          if (access.modelListed === false) notes.push(`the LLM endpoint does not list the model "${config.model}"; check LLM_MODEL if adaptation fails`);
          llm = createOpenAiCompatibleProvider(config, hooks.fetch);
        } catch (err) {
          problems.push(messageOf(err));
        }
      }
    } catch (err) {
      problems.push(messageOf(err));
    }
  }

  let voices: VoiceCatalogue | null = null;
  try {
    voices = requireClonable(VoiceCatalogueSchema.parse(JSON.parse(readFileSync(paths.voiceCatalogue, "utf8"))));
  } catch (err) {
    problems.push(`the voice catalogue ${paths.voiceCatalogue} cannot be used: ${messageOf(err).split("\n")[0]}`);
  }

  let sfx: SfxCatalogue | null = null;
  if (!existsSync(paths.sfxIndex)) problems.push(`no sound library at ${paths.sfxIndex}: run pnpm sfx:build (or pnpm --filter @midnight-radio/mix sfx:music for music only)`);
  else {
    try {
      sfx = SfxCatalogueSchema.parse(JSON.parse(readFileSync(paths.sfxIndex, "utf8")));
      if (!sfx.musicCues.theme) problems.push("the sound library has no theme music pinned: run pnpm --filter @midnight-radio/mix sfx:music");
      if (!sfx.entries.some((e) => e.kind === "sfx")) notes.push("the sound library has music but no sound effects yet, so scripts will use music cues only (run pnpm sfx:build to add foley)");
    } catch (err) {
      problems.push(`the sound library ${paths.sfxIndex} is invalid: ${messageOf(err).split("\n")[0]}`);
    }
  }

  let styleGuide: string | null = null;
  try {
    styleGuide = loadStyleGuide(paths.styleGuide);
  } catch {
    problems.push(`the style guide ${paths.styleGuide} is missing`);
  }

  const has = hooks.hasProgram ?? programOnPath;
  for (const p of ["ffmpeg", "ffprobe"]) if (!has(p)) problems.push(`${p} is not on the PATH (macOS: brew install ffmpeg)`);

  let tts: TtsProvider | null = null;
  if (voices) {
    try {
      const q = loadQwenConfig(env);
      tts = await (hooks.connectTts ?? QwenTtsProvider.connect.bind(QwenTtsProvider))({ baseUrl: q.baseUrl, token: q.token, catalogue: voices, seed: q.seed, timeoutMs: q.timeoutMs, msPerChar: q.msPerChar });
    } catch (err) {
      problems.push(`Qwen3-TTS is not ready: ${messageOf(err)}. Start services/local-audio with the qwen-mlx backend (see its README) and check LOCAL_AUDIO_URL`);
    }
  }

  if (problems.length > 0 || !budget || !voices || !sfx || !styleGuide || !tts) return { ok: false, problems };
  return { ok: true, ready: { budget, llm, tts, voices, sfx, styleGuide, notes } };
}

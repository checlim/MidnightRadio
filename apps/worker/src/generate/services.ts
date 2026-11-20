import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STUB_VOICE_CATALOGUE, SfxCatalogueSchema, VoiceCatalogueSchema, requireClonable, type VoiceCatalogue } from "@midnight-radio/core";
import { createOpenAiCompatibleProvider, loadLlmConfig, loadStyleGuide } from "@midnight-radio/llm";
import { QwenTtsProvider, StubProvider, loadQwenConfig, type TtsProvider } from "@midnight-radio/tts";
import type { WorkerConfig } from "../config.js";
import type { GenerationServices } from "../handlers.js";
import { stubLlm } from "./stub-llm.js";

/** The repository root (assets, style guide, web app), from this file's place in apps/worker. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The voice catalogue generation casts from: the real one, or the stub one with the stub providers. */
export function loadVoiceCatalogue(stubProviders: boolean, root = REPO_ROOT): VoiceCatalogue {
  if (stubProviders) return STUB_VOICE_CATALOGUE;
  return requireClonable(VoiceCatalogueSchema.parse(JSON.parse(readFileSync(join(root, "assets/voices/catalogue.json"), "utf8"))));
}

/**
 * Build what generation jobs need from the environment. Called only when generation is enabled.
 * Throws at boot if the sound library, voice catalogue or style guide cannot be used, so a
 * misconfigured worker fails fast instead of failing every job.
 *
 * `stubProviders` swaps in the offline model and the tone voices (tests and trying the flow
 * without a key or the audio models); what it makes is not fit to be heard as a drama.
 */
export function createGenerationServices(env: Record<string, string | undefined>, config: WorkerConfig, log: GenerationServices["log"], root = REPO_ROOT): GenerationServices {
  const sfxDir = join(root, "assets/sfx");
  const sfx = SfxCatalogueSchema.parse(JSON.parse(readFileSync(join(sfxDir, "index.json"), "utf8")));
  if (!sfx.musicCues.theme) throw new Error("the sound library has no theme music pinned; run pnpm --filter @midnight-radio/mix sfx:music");
  const styleGuide = loadStyleGuide(join(root, ".kiro/steering/radio-voice.md"));
  const common = { sfx, sfxDir, styleGuide, cacheDir: config.renderCacheDir, publicDir: config.publicDir, uploadsDir: join(config.dataDir, "uploads"), log };

  if (config.stubProviders) {
    const tts = new StubProvider();
    return { ...common, llm: stubLlm(), tts: async () => tts, voices: STUB_VOICE_CATALOGUE };
  }

  const voices = loadVoiceCatalogue(false, root);
  const llmConfig = loadLlmConfig(env);
  if (!llmConfig) log("no LLM configured (LLM_API_KEY); casting and adaptation jobs will fail until it is set");
  const qwen = loadQwenConfig(env);
  let connecting: Promise<TtsProvider> | null = null;
  const tts = () => {
    // One connection for the worker's life; a failed attempt is forgotten so the next job retries.
    connecting ??= QwenTtsProvider.connect({ baseUrl: qwen.baseUrl, token: qwen.token, catalogue: voices, seed: qwen.seed, timeoutMs: qwen.timeoutMs, msPerChar: qwen.msPerChar }).catch((err: unknown) => {
      connecting = null;
      throw new Error(`Qwen3-TTS is not ready: ${err instanceof Error ? err.message : String(err)}`);
    });
    return connecting;
  };
  return { ...common, llm: llmConfig ? createOpenAiCompatibleProvider(llmConfig) : null, tts, voices };
}

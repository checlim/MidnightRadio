import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SfxCatalogueSchema, VoiceCatalogueSchema, catalogueHash, requireClonable, type ClonableCatalogue } from "@midnight-radio/core";
import { createOpenAiCompatibleProvider, loadLlmConfig, loadStyleGuide } from "@midnight-radio/llm";
import { QwenTtsProvider, QwenVoiceDesigner, SfxClient, StubProvider, StubVoiceDesigner, VoiceDesignPinSchema, loadQwenConfig, loadSfxConfig, type TtsProvider, type VoiceDesignPin, type VoiceDesigner } from "@midnight-radio/tts";
import type { WorkerConfig } from "../config.js";
import type { GenerationServices } from "../handlers.js";
import { stubLlm } from "./stub-llm.js";

/** The repository root (assets, style guide, web app), from this file's place in apps/worker. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The series voice catalogue (Announcer, Narrator and the voice-clone pin), from `assets/voices`. */
export function loadSeriesCatalogue(root = REPO_ROOT): ClonableCatalogue {
  return requireClonable(VoiceCatalogueSchema.parse(JSON.parse(readFileSync(join(root, "assets/voices/catalogue.json"), "utf8"))));
}

/** The voice-design build every book's voices are designed with (`assets/voices/voice-design.json`). */
export function loadDesignPin(root = REPO_ROOT): VoiceDesignPin {
  return VoiceDesignPinSchema.parse(JSON.parse(readFileSync(join(root, "assets/voices/voice-design.json"), "utf8")));
}

export interface Connectors {
  /** The speech provider for a catalogue, connected once per catalogue; a failed attempt is forgotten so the next call retries. */
  ttsFor: (catalogue: ClonableCatalogue, clipDir: string) => Promise<TtsProvider>;
  /** The voice designer, connected once; a failed attempt is forgotten. */
  designer: () => Promise<VoiceDesigner>;
}

/** How to reach the speech server, from the environment (`LOCAL_AUDIO_URL`, `LOCAL_AUDIO_TOKEN`, …), or the offline stand-ins. */
export function createConnectors(env: Record<string, string | undefined>, stubProviders: boolean, designPin: VoiceDesignPin): Connectors {
  if (stubProviders) {
    const designer = new StubVoiceDesigner();
    return { ttsFor: async (catalogue) => new StubProvider(catalogue.voices), designer: async () => designer };
  }
  const q = loadQwenConfig(env);
  const providers = new Map<string, Promise<TtsProvider>>();
  let designing: Promise<VoiceDesigner> | null = null;
  return {
    ttsFor: (catalogue, clipDir) => {
      const key = `${catalogueHash(catalogue)}\0${clipDir}`;
      let p = providers.get(key);
      if (!p) {
        p = QwenTtsProvider.connect({ baseUrl: q.baseUrl, token: q.token, catalogue, clipDir, seed: q.seed, timeoutMs: q.timeoutMs, msPerChar: q.msPerChar }).catch((err: unknown) => {
          providers.delete(key);
          throw err;
        });
        providers.set(key, p);
      }
      return p;
    },
    designer: () => {
      designing ??= QwenVoiceDesigner.connect({ baseUrl: q.baseUrl, token: q.token, pin: designPin, timeoutMs: q.timeoutMs }).catch((err: unknown) => {
        designing = null;
        throw err;
      });
      return designing;
    },
  };
}

/**
 * Build what generation jobs need from the environment. Called only when generation is enabled.
 * Throws at boot if the sound library, voice catalogue, voice-design pin or style guide cannot be
 * used, so a misconfigured worker fails fast instead of failing every job.
 *
 * `stubProviders` swaps in the offline model, the tone voices and the tone voice designer (tests and
 * trying the flow without a key or the audio models); what it makes is not fit to be heard as a drama.
 */
export function createGenerationServices(env: Record<string, string | undefined>, config: WorkerConfig, log: GenerationServices["log"], root = REPO_ROOT): GenerationServices {
  const sfxDir = join(root, "assets/sfx");
  const sfx = SfxCatalogueSchema.parse(JSON.parse(readFileSync(join(sfxDir, "index.json"), "utf8")));
  if (!sfx.musicCues.theme) throw new Error("the sound library has no theme music pinned; run pnpm --filter @midnight-radio/mix sfx:music");
  const styleGuide = loadStyleGuide(join(root, ".kiro/steering/radio-voice.md"));
  const series = loadSeriesCatalogue(root);
  const designPin = loadDesignPin(root);
  const connectors = createConnectors(env, config.stubProviders, designPin);
  // The sound-effect server is used only to build the shared library for sound-designed jobs; with
  // no SFX_SERVICE_URL those jobs use the library already built, or fail saying what to set.
  const sfxService = loadSfxConfig(env);
  let llm = null;
  if (config.stubProviders) llm = stubLlm();
  else {
    const llmConfig = loadLlmConfig(env);
    if (!llmConfig) log("no LLM configured (LLM_API_KEY); casting and adaptation jobs will fail until it is set");
    llm = llmConfig ? createOpenAiCompatibleProvider(llmConfig) : null;
  }
  return {
    llm,
    ...connectors,
    series,
    seriesDir: join(root, "assets/voices"),
    designPin,
    voicesRoot: join(config.dataDir, "voices"),
    sfx,
    sfxDir,
    styleGuide,
    cacheDir: config.renderCacheDir,
    broadcastDir: config.broadcastDir,
    uploadsDir: join(config.dataDir, "uploads"),
    library: {
      root: join(config.dataDir, "sfx-library"),
      sourceDir: sfxDir,
      musicDir: join(root, "music-candidates"),
      connect: sfxService ? () => SfxClient.connect(sfxService) : null,
    },
    log,
  };
}

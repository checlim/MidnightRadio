import { join } from "node:path";
import type { ClonableCatalogue } from "@midnight-radio/core";
import { StubProvider, StubVoiceDesigner, type SynthesisRequest, type TtsProvider } from "@midnight-radio/tts";
import { clonableStubCatalogue, writeClips } from "@midnight-radio/tts/src/test-support/clonable-catalogue.js";

/** Test helpers: the series catalogue with its clips on disk, and offline speech and design that record what they were asked. */

export const STUB_DESIGN_PIN = { name: "stub-voice-design", revision: "stub-1" };

export async function seriesFixture(dir: string): Promise<{ series: ClonableCatalogue; seriesDir: string }> {
  const series = clonableStubCatalogue();
  const seriesDir = join(dir, "series-voices");
  await writeClips(seriesDir, series);
  return { series, seriesDir };
}

/** A speech connector whose providers (one per catalogue) all record into `requests`. */
export function speechSpy(wrap: (p: StubProvider) => TtsProvider = (p) => p) {
  const requests: SynthesisRequest[] = [];
  const ttsFor = async (catalogue: ClonableCatalogue): Promise<TtsProvider> => {
    const p = new StubProvider(catalogue.voices);
    const synthesize = p.synthesize.bind(p);
    p.synthesize = async (req, opts) => {
      requests.push(req);
      return synthesize(req, opts);
    };
    return wrap(p);
  };
  return { requests, ttsFor };
}

/** The voice-related dependencies of the pipeline, for a test folder. */
export async function voiceDeps(dir: string) {
  const { series, seriesDir } = await seriesFixture(dir);
  const designer = new StubVoiceDesigner();
  return { series, seriesDir, designPin: STUB_DESIGN_PIN, voicesRoot: join(dir, "voices"), designer, designerFn: async () => designer };
}

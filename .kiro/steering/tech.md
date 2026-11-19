---
inclusion: always
---

# Tech Conventions

- TypeScript strict mode everywhere; Node 24; pnpm workspaces. The one exception is `services/local-audio`, a Python (3.10+) service that hosts the audio models on the generation machine only; it uses the standard library for its server, is tested with `unittest`, runs through `uv`, and is never part of the deployed container.
- Validate every external/LLM boundary with Zod; never trust model output unparsed.
- All LLM and TTS access goes through `packages/llm` and `packages/tts` interfaces — no direct SDK calls elsewhere.
- Secrets only from environment variables; never log request headers or keys.
- Audio intermediate format: WAV 24 kHz mono, 16-bit, written atomically via unique same-directory temp files + full PCM format/data-length/frame validation + flush + `fs.rename`; validate existing hits and coalesce identical requests. Final: MP3 192 kbps.
- ffmpeg is invoked via a single wrapper in `packages/mix` that logs the full filter graph on failure.
- Tests: Vitest + `fast-check` (Property-Based Testing) for unit/invariant suites, Playwright for E2E. CI uses `StubProvider` — tests must never call paid APIs.
- Deployment target: single container (`apps/web` + `apps/worker` + `ffmpeg`) with persistent `/data` volume (Fly.io/Railway/VPS), never split across stateless serverless lambdas.
- Keep functions small and pure in `packages/core`; side effects belong in worker steps.

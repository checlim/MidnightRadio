# Sound-effect service API (version 1)

Midnight Radio generates foley while building its sound library, never at playback time. It does
not care which model makes the sounds or where that model runs: any server that implements this API
works, whether that is `services/local-audio` on your own machine, a notebook on a rented or free
cloud GPU behind a tunnel, or your own GPU box. Tests use an offline fake; nothing here runs on the
live site.

There are two clients. The worker's library stage (`packages/tts/src/sfx-client.ts`, used by
`apps/worker/src/generate/library.ts`) builds the shared library under `<DATA_DIR>/sfx-library`
for jobs with sound design; it sends an `Idempotency-Key` with every take. The command-line tool
(`services/local-audio/tools/generate_sfx.py`, run by `pnpm sfx:build`) builds the committed
`assets/sfx/`. Both read `assets/sfx/prompts.json`, check every clip and record what the server
says about its model, so each sound's origin and licence end up in the library's `index.json` and
`ATTRIBUTION.md`.

## Connecting

| Setting | Meaning |
|---|---|
| `SFX_SERVICE_URL` | Base URL, e.g. `https://example.trycloudflare.com` or `http://127.0.0.1:8765`. |
| `SFX_SERVICE_TOKEN` | Access token, at least 16 characters. Sent as `Authorization: Bearer <token>`. |

Both are read from the environment only. The client enforces:

- **Plain `http` only on loopback** (`127.0.0.1`, `localhost`, `[::1]`). Any other host must use
  `https` **and** a token, so a token never crosses a network unencrypted.
- No credentials in the URL, and no redirects followed (a redirect is an error), so the token is
  never sent to a host you did not name.
- The token is never printed or logged; error messages from the server are shown with it masked.

A server reachable from the internet (any tunnel) **must** require the token on every endpoint,
including `/health`, and compare it in constant time.

## `GET /health`

Answers `200` with JSON. Fields the client reads (others are ignored):

```json
{
  "apiVersion": 1,
  "sfx": {
    "model": "MOSS-SoundEffect-v2.0",
    "revision": "e35df4d82fbe87fcd5d14e5d100e349c0c3c076d",
    "weightsSha256": "bda86e4d…",
    "license": "Apache-2.0",
    "sampleRate": 48000,
    "ready": true
  }
}
```

| Field | Rule |
|---|---|
| `apiVersion` | Must be `1`. |
| `sfx` | Object, or `null` if the server has no sound-effect model (the client then stops). |
| `sfx.model` | 1–100 characters: the model's name. |
| `sfx.revision` | 1–100 characters: the exact weights revision (e.g. a Hugging Face commit). |
| `sfx.weightsSha256` | Optional: 64 lowercase hex characters, the hash of the main weights file. |
| `sfx.license` | 1–100 characters: the licence of the model's **output** as the operator understands it, preferably an SPDX id (`Apache-2.0`, `CC0-1.0`, `MIT`). Recorded with every clip. |
| `sfx.sampleRate` | Integer from 24000 to 96000: the rate of the WAVs it returns. |
| `sfx.ready` | `true` once the model is loaded; the client waits and retries while it is `false`. |
| `sfx.idempotency` | Optional: `true` when the server supports `Idempotency-Key` on `POST /sfx` (see "Idempotent requests (optional)"). Omitted when it does not; clients that do not know it ignore it. |

The client checks `/health` before the first request and again whenever it reconnects. If the
model, revision or weights hash changes during a run, it stops instead of mixing takes from two
models in one sound library.

## `POST /sfx`

Request: `Content-Type: application/json`, with a `Content-Length` (no chunked bodies), at most 64 KB.

```json
{ "prompt": "A heavy old wooden door creaks open slowly on rusty iron hinges.", "durationSec": 5, "seed": 1940 }
```

| Field | Rule |
|---|---|
| `prompt` | 1–500 characters, not blank. A description of the sound, what makes it, where, and how it changes. |
| `durationSec` | Number from 0.5 to 30. |
| `seed` | Optional integer from 0 to 2147483647. With the same prompt, duration, seed and weights, a server **should** return the same audio, but the client does not rely on it: chosen takes are kept as files, not re-rendered. |

Unknown fields are refused (`400`).

Answer: `200` with `Content-Type: audio/wav`, a complete RIFF/WAVE file:

- PCM, **mono, 16-bit**, at the `sampleRate` `/health` reported;
- between `durationSec − 0.05` and `durationSec + 0.05` seconds long;
- not silent (some sample other than zero), and at most 20 MB;
- header `X-Model-Revision` equal to `sfx.revision` from `/health`. `X-Render-Ms` (integer) is optional.

The client refuses anything else (wrong format, truncated, padded, streamed with no length) and
counts it as a failed attempt.

## Errors

Any non-`200` answer is JSON `{"error": {"code": "...", "message": "..."}}`. The message must not
contain the token or the request body.

| Status | Code | Client behaviour |
|---|---|---|
| 400 | `bad_request` | Stops: the prompt list needs fixing. |
| 401 | `unauthorized` | Stops: wrong or missing token. |
| 404 / 405 | `not_found` / `method_not_allowed` | Stops: not a server for this API. |
| 409 | `in_progress` | Only with `Idempotency-Key`: waits `Retry-After` seconds and retries with the **same** key. |
| 422 | `idempotency_mismatch` | Only with `Idempotency-Key`: stops; the key was used for a different request (a client bug). |
| 503 | `busy` or `not_ready` | Waits and retries (back-off up to 60 s, at most 10 times). |
| 500, other 5xx, timeout, dropped connection | any | Retries the take up to 3 times, then records it as failed and moves on. |

A request may take minutes on a slow GPU; the client waits up to `SFX_SERVICE_TIMEOUT_MS`
(default 15 minutes) per request. Servers should handle one render at a time and answer `503 busy`
to others rather than queue them for long.

## Idempotent requests (optional)
A client that sent `POST /sfx` and then crashed or lost the connection does not know whether the
server rendered the take. This optional extension lets it ask again without a second render.
It is **additive within `apiVersion` 1**: servers without it ignore the header, and clients that do
not send it see no change.

**Advertising.** A supporting server adds `"idempotency": true` to the `sfx` object of `/health`.
A server without support omits the field.

**Request header.** `Idempotency-Key: <64 lowercase hex characters>` (for example a random 32-byte
value, hex-encoded). Anything else is `400 bad_request`. Authentication, `Origin` and `Host` checks
come first. A supporting server:
- keys the request by the header value and stores a fingerprint of the body: the sha256 of the
  canonical JSON (sorted keys, no whitespace) of `prompt`, `durationSec` (as a number) and `seed`
  (`null` if absent);
- while a request with that key is rendering, answers any other request with that key
  `409 {"error":{"code":"in_progress",...}}` and a `Retry-After` header (integer seconds);
- after a successful render, answers a repeat with the same key and the same fingerprint with
  the **same WAV bytes** and the same `X-Model-Revision` and `X-Render-Ms` as the original render,
  plus `X-Idempotent-Replay: true`, without rendering again. The stored revision header is
  returned as it was stored;
- answers a repeat with the same key and a different fingerprint
  `422 {"error":{"code":"idempotency_mismatch",...}}`;
- forgets the key after a failed render (any error status), so a retry renders again;
- keeps finished results for the life of the process (so at least until restart) in bounded memory:
  at most 32 results, evicting the oldest finished ones first. A key that is rendering is never
  evicted. After eviction a repeat renders again. Keys are never logged.

**Client behaviour.**
- A client that sent a request with a key and did not get an answer (timeout, dropped connection,
  its own restart) **must** retry with the **same** key, and must wait and retry on `409`
  (honouring `Retry-After`). It **must not** generate a new key for the same take.
- Use a new key for each new take (a different seed or prompt is a different request).
- Against a server that does not report `idempotency: true`, a client **must** count an uncertain
  request as a used attempt, so retries stay bounded.
- A replayed answer (`X-Idempotent-Replay: true`) is validated like any other answer.

## Writing a server

The smallest conforming server is the two endpoints above around a model call, e.g. with the
Python standard library's `http.server` or any web framework, behind a tunnel. Checklist:

1. Require `Authorization: Bearer <token>` on both endpoints; compare with `hmac.compare_digest`.
2. Load pinned weights once at start-up; report their exact revision (and hash if you can).
3. Report the output licence honestly in `sfx.license`.
4. Return mono 16-bit PCM WAV of the requested length (crop or pad to it); resampling is optional,
   the client converts to 24 kHz.
5. Never log request bodies, headers or the token.

`services/local-audio` implements this API on loopback (see its README); its `fake` backend
returns noise and is what the tests use.

## Versioning

The client sends no version and requires `apiVersion: 1`. A change that would break a version-1
client gets a new `apiVersion`; adding optional fields does not.

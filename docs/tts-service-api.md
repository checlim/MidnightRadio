# Speech service API (version 1)

Midnight Radio speaks every line by **cloning a reference clip**: each voice in
`assets/voices/catalogue.json` is a short clip and its transcript, and the service is asked to say
a new line in that voice. The service is a plain speech engine. It holds no voices, catalogue or
rules: every request carries the reference clip, and **all control stays with the client**
(`packages/tts`), which decides which clip a voice uses, checks every clip against its recorded
hash before sending it, checks that the server runs the exact model build the catalogue pins,
caches renders, meters them against the speech budget and checks every WAV it gets back.

Any server that implements this API works: `services/local-audio` on your own machine, or
`services/local-audio/kaggle/qwen_tts_server.py` on a cloud GPU behind a tunnel. It is used only
while generating episodes, never at playback time, in tests or on the live site.

## Connecting

| Setting | Meaning |
|---|---|
| `LOCAL_AUDIO_URL` | Base URL, e.g. `http://127.0.0.1:8765` or `https://example.trycloudflare.com`. |
| `LOCAL_AUDIO_TOKEN` | Access token, at least 16 characters. Sent as `Authorization: Bearer <token>`. |

Both are read from the environment only. The client enforces:

- **Plain `http` only on loopback** (`127.0.0.1`, `localhost`, `[::1]`). Any other host must use
  `https` **and** a token, so neither the token nor the reference clips cross a network unencrypted.
- No credentials in the URL, and no redirects followed (a redirect is an error), so the token and
  the clips are never sent to a host you did not name.
- The token is never printed or logged.

A server reachable from the internet (any tunnel) **must** require the token on every endpoint,
including `/health`, and compare it in constant time.

## `GET /health`

Answers `200` with JSON. Fields the client reads (others are ignored):

```json
{
  "apiVersion": 1,
  "tts": {
    "model": "Qwen3-TTS-12Hz-1.7B-Base",
    "revision": "fd4b254389122332181a7c3db7f27e918eec64e3",
    "weightsSha256": "38fc7fc51c5e776e840414b6fd443962e9411b9654888fd7913e4da643cb857c",
    "sampleRate": 24000,
    "ready": true
  }
}
```

- `model`, `revision`: the model and the exact revision of its weights (e.g. the Hugging Face commit).
- `weightsSha256`: SHA-256 of the main weights file (`model.safetensors`), computed by the server
  from the file it loaded. The client refuses a server whose revision or weights hash differs from
  the catalogue's `voice-clone` pin, so one book never mixes audio from different weights.
- `sampleRate`: must be `24000`.
- `ready`: `false` while the model is loading; the client waits and asks again.

## `POST /tts`

Request body (`application/json`, at most 4 MB):

```json
{
  "text": "Welcome to my house! Enter freely and of your own will!",
  "language": "English",
  "seed": 0,
  "reference": { "audio": "<base64 of a WAV file>", "text": "Good evening. The night is cold…" }
}
```

| Field | Rules |
|---|---|
| `text` | 1 to 4,000 characters, not blank. |
| `language` | The language to speak, e.g. `English`. |
| `seed` | Integer 0 to 2,147,483,647. The same request with the same seed should give the same audio. |
| `reference.audio` | Base64 of a WAV file: PCM 16-bit, mono, at most 30 seconds. The voice to clone. |
| `reference.text` | The words spoken in the reference clip, 1 to 500 characters. |

Unknown fields are refused (`400`). A server may remember references it has seen (by content
hash) to skip re-encoding them; that must never change the result.

**Success:** `200`, `Content-Type: audio/wav`, a complete WAV file: 24,000 Hz, mono, 16-bit PCM,
not silent. Headers:

- `X-Model-Revision`: the revision that rendered it (the client refuses audio if it changed).
- `X-Render-Ms` (optional): how long the render took.

## Errors

Every error is JSON: `{"error": {"code": "<code>", "message": "<text>"}}`. Messages must not
contain the request text, the reference or the token.

| Status | Code | Meaning | Client |
|---|---|---|---|
| 400 | `bad_request` | Invalid field, bad base64 or a reference that is not a usable WAV. | Stops: a bug to fix. |
| 401 | `unauthorized` | Missing or wrong token. | Stops: check `LOCAL_AUDIO_TOKEN`. |
| 404 / 405 | `not_found` / `method_not_allowed` | Not a speech server. | Stops. |
| 413 | `too_large` | Body over the limit. | Stops. |
| 415 | `unsupported_media_type` | Not JSON. | Stops. |
| 502 | `model_failed` | The model could not render this line. | Retries the line. |
| 503 | `busy` / `not_ready` | Rendering another line, or still loading. | Waits and retries. |

One model renders one line at a time; a server may queue requests and answer `busy` when a request
has waited too long.

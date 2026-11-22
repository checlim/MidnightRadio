# Speech service on a Kaggle GPU

`qwen_tts_server.py` runs Qwen3-TTS (voice cloning) on a Kaggle GPU and implements the speech service API in `docs/tts-service-api.md`. A cloudflared quick tunnel makes it reachable from your Mac over https. It is used only while generating episodes.

Requirements checked when this guide was written:

- `qwen-tts` 0.1.1 on PyPI (https://pypi.org/project/qwen-tts/), Python >= 3.9. It pins `transformers==4.57.3` and `accelerate==1.12.0`, and pulls in `gradio`, `librosa`, `torchaudio`, `soundfile`, `sox`, `onnxruntime` and `einops`. `torch` comes with the Kaggle image. `flash-attn` is not needed: the server defaults to `--attn sdpa`.
- cloudflared release 2026.11.1 (https://github.com/cloudflare/cloudflared/releases) has the asset `cloudflared-linux-amd64` (a plain binary). The stable URL is `https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64`.

## 1. Create the notebook

1. On kaggle.com choose Create, then New Notebook.
2. In the right-hand Session options set Accelerator to **GPU T4 x2** (or P100) and turn **Internet** on. Internet needs a phone-verified account.
3. Add a secret under Add-ons, then Secrets: label `TTS_SERVICE_TOKEN`, value a random string of at least 16 characters (for example `openssl rand -hex 24` on your Mac). Attach it to the notebook. Keep the same value for `LOCAL_AUDIO_TOKEN` on the Mac. Never type the token into a notebook cell.

## 2. Cells

Cell 1: install.

```python
!pip install -q qwen-tts
```

Cell 2: upload `qwen_tts_server.py` (Add Input, Upload, or File, Upload) so it sits in `/kaggle/working/`, or paste it into a cell that starts with `%%writefile /kaggle/working/qwen_tts_server.py`. Then load the token into the environment:

```python
import os
from kaggle_secrets import UserSecretsClient
os.environ["TTS_SERVICE_TOKEN"] = UserSecretsClient().get_secret("TTS_SERVICE_TOKEN")
```

Cell 3: start the server in the background and wait until the model is loaded (the first start downloads about 4 GB and hashes the weights, so allow several minutes).

```python
import subprocess, time, json, urllib.request

log = open("/kaggle/working/server.log", "w")
server = subprocess.Popen(
    ["python", "/kaggle/working/qwen_tts_server.py", "serve", "--port", "8765"],
    stdout=log, stderr=subprocess.STDOUT, env=os.environ.copy(),
)

def health():
    req = urllib.request.Request("http://127.0.0.1:8765/health",
                                 headers={"Authorization": "Bearer " + os.environ["TTS_SERVICE_TOKEN"]})
    return json.load(urllib.request.urlopen(req, timeout=10))

for _ in range(120):
    time.sleep(10)
    if server.poll() is not None:
        print(open("/kaggle/working/server.log").read()[-3000:]); raise SystemExit("server exited")
    try:
        info = health()["tts"]
        if info["ready"]:
            print(info); break
    except Exception:
        pass
else:
    print(open("/kaggle/working/server.log").read()[-3000:])
```

The printed `weightsSha256` should be `38fc7fc51c5e776e840414b6fd443962e9411b9654888fd7913e4da643cb857c`. The server log prints a warning if it is not. The log never contains the token or request text.

Cell 4: install and start the tunnel.

```python
!wget -q -O /kaggle/working/cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64
!chmod +x /kaggle/working/cloudflared
```

```python
import re
tunnel_log = open("/kaggle/working/tunnel.log", "w")
tunnel = subprocess.Popen(
    ["/kaggle/working/cloudflared", "tunnel", "--no-autoupdate", "--url", "http://127.0.0.1:8765"],
    stdout=tunnel_log, stderr=subprocess.STDOUT,
)
url = None
for _ in range(30):
    time.sleep(2)
    m = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", open("/kaggle/working/tunnel.log").read())
    if m:
        url = m.group(0); break
print(url)
```

## 3. Point the Mac at it

In the repository's `.env`:

```
LOCAL_AUDIO_URL=https://<words>.trycloudflare.com
LOCAL_AUDIO_TOKEN=<the same token as the Kaggle secret>
```

Then `pnpm generate …` (or `pnpm studio`) renders on Kaggle. The client sends each voice's reference clip from `assets/voices` with every line; nothing about the voices needs to be uploaded to Kaggle.

The client refuses a server whose model name, `revision` or `weightsSha256` differs from the catalogue's `voice-clone` pin in `assets/voices/catalogue.json`, which is `Qwen3-TTS-12Hz-1.7B-Base (float32)` at revision `fd4b254…` with weights `38fc7fc5…`. The server reports its dtype in the `model` string, so the pin also fixes the precision: one book never mixes float32 and float16 renders. To render at another precision, change the pin in `services/local-audio/tools/assemble_catalogue.py`, rerun it and update the catalogue hash in `packages/tts/src/voice-catalogue.test.ts` (a deliberate, reviewed change).

## 4. Benchmark and listen first (optional cell)

Upload one project clip, for example `assets/voices/clips/narrator.wav`, then run `bench`. Stop the server first if the GPU memory is tight (`server.terminate()`), because the benchmark loads its own copy of the model.

```python
!python /kaggle/working/qwen_tts_server.py bench \
    --reference /kaggle/input/<your-dataset>/narrator.wav \
    --reference-text "Good evening. The night is cold, the road is long, and the old house waits at the end of it." \
    --out /kaggle/working/bench
```

It renders three English lines (short, medium, about 200 characters), each twice (the first run is a warm-up), prints characters, milliseconds, ms per character and real-time factor, and ends with `median X ms/char at dtype Y on <GPU>`. For comparison the Mac measured 118 ms/char. The WAVs are in `/kaggle/working/bench/`. Download and listen to them before generating a book.

## Notes

- **Precision.** The default is `--dtype float32` because a T4 has no native bfloat16. `--dtype float16` is faster and may produce noise; listen to the bench WAVs before using it. `--dtype bfloat16` suits newer GPUs only.
- **Two T4s.** You can start a second server with `--device cuda:1 --port 8766` and a second tunnel. The client uses one URL today, so the second GPU stays idle unless you run two generation jobs.
- **Quick tunnels change URL every session.** Update `LOCAL_AUDIO_URL` after each restart.
- **Sessions end** after inactivity and at the weekly GPU quota. Keep the notebook tab open while generating, and expect to rerun cells 2 to 4 afterwards. The model download is repeated unless you keep it in a Kaggle dataset and pass `--model-dir`.
- **Security.** The server listens on 127.0.0.1 only, requires the token on every endpoint, and refuses browser requests (any `Origin` header). Anyone with the tunnel URL and the token can use your GPU, so keep both private and stop the tunnel when you finish (`tunnel.terminate()`).
- **Tests** (no GPU needed): `cd services/local-audio && uv run --no-project --python 3.10 python -m unittest discover -s kaggle/tests -t kaggle`.

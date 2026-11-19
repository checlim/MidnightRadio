"""python -m local_audio --catalogue <catalogue.json> --backend <name>

Prints one JSON line when it is ready, `{"listening": "http://127.0.0.1:PORT"}`, then serves until
it receives SIGTERM or SIGINT.
"""

import json
import logging
import os
import signal
import sys
import threading
import time

from .backends import BackendUnavailable, create_backend
from .catalogue import CatalogueError, load_catalogue
from .config import ConfigError, parse_config
from .server import LocalAudioServer


def main(argv: list[str]) -> int:
    logging.basicConfig(level=logging.INFO, stream=sys.stderr, format="%(asctime)s %(levelname)s %(message)s")
    try:
        config = parse_config(argv, os.environ)
        clips = load_catalogue(config.catalogue_path)
        backend = create_backend(config.backend, config.fake_delay_ms, config.tts_model)
    except (ConfigError, CatalogueError, BackendUnavailable) as err:
        print(f"local_audio: {err}", file=sys.stderr)
        return 2

    server = LocalAudioServer(config, backend, clips)
    stopping = False

    # A signal handler runs on the main thread, between bytecodes, possibly while that thread is
    # inside a lock (for example a threading.Event's). If the handler took a lock too, the thread
    # could deadlock with itself and ignore SIGTERM forever; this happened with Event.set(). So the
    # handler only flips a plain flag, and the main thread sleeps in short steps and checks it.
    def shut_down(_signum, _frame) -> None:
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, shut_down)
    signal.signal(signal.SIGINT, shut_down)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    print(json.dumps({"listening": f"http://{config.host}:{server.port}"}), flush=True)
    while not stopping:
        time.sleep(0.1)
    server.shutdown()
    server.server_close()
    backend.close()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

"""Command-line and environment configuration.

The service listens on the loopback interface only. The optional access token comes from the
environment, never from the command line, where other users' `ps` output could show it.
"""

import argparse
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping, Optional, Sequence

LOOPBACK_HOSTS = ("127.0.0.1", "localhost")
MIN_TOKEN_CHARS = 16


class ConfigError(Exception):
    """Invalid configuration. The message never contains the token."""


@dataclass(frozen=True)
class Config:
    host: str
    port: int
    catalogue_path: Path
    backend: str
    token: Optional[str] = None
    max_text_chars: int = 4_000
    queue_timeout_s: float = 600.0
    fake_delay_ms: int = 0


def parse_config(argv: Sequence[str], env: Mapping[str, str]) -> Config:
    parser = argparse.ArgumentParser(prog="local_audio", description=__doc__.splitlines()[0])
    parser.add_argument("--host", default="127.0.0.1", help="loopback address only (default 127.0.0.1)")
    parser.add_argument("--port", type=int, default=8765, help="0 picks a free port")
    parser.add_argument("--catalogue", required=True, type=Path, help="path to catalogue.json")
    parser.add_argument("--backend", required=True, help="model backend; 'fake' returns tones for tests")
    parser.add_argument("--fake-delay-ms", type=int, default=0, help="slow the fake backend down, for timeout tests")
    parser.add_argument("--queue-timeout-s", type=float, default=600.0, help="how long a request waits for the model")
    try:
        args = parser.parse_args(list(argv))
    except SystemExit as exit_:
        raise ConfigError("invalid arguments") from exit_

    if args.host not in LOOPBACK_HOSTS:
        raise ConfigError(f"refusing to listen on '{args.host}': this service only listens on 127.0.0.1")
    if not 0 <= args.port <= 65_535:
        raise ConfigError("port must be between 0 and 65535")
    if args.fake_delay_ms < 0 or args.queue_timeout_s <= 0:
        raise ConfigError("delays must be positive")

    token = (env.get("LOCAL_AUDIO_TOKEN") or "").strip() or None
    if token is not None and len(token) < MIN_TOKEN_CHARS:
        raise ConfigError(f"LOCAL_AUDIO_TOKEN must be at least {MIN_TOKEN_CHARS} characters")

    return Config(
        host="127.0.0.1" if args.host == "localhost" else args.host,
        port=args.port,
        catalogue_path=args.catalogue,
        backend=args.backend,
        token=token,
        queue_timeout_s=args.queue_timeout_s,
        fake_delay_ms=args.fake_delay_ms,
    )

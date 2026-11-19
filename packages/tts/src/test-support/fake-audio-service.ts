import { createServer, type IncomingHttpHeaders, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { transcriptHash, type ClonableCatalogue } from "@midnight-radio/core";
import { StubProvider } from "../stub.js";

export interface Recorded {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: unknown;
}

export interface FakeState {
  revision: string;
  model: string;
  apiVersion: number;
  service: string;
  tts: { sampleRate: number; ready: boolean; weightsSha256?: string } | null;
  /** Overrides what /health reports for voices. */
  voices?: Record<string, { clipSha256: string; transcriptSha256: string }>;
  token?: string;
  /** Takes over /tts. Return true if the response was handled. */
  tts_handler?: (req: IncomingMessage, res: ServerResponse, body: { voiceId: string; text: string; delivery?: string; seed?: number }) => boolean | Promise<boolean>;
  healthStatus?: number;
  healthBody?: string;
}

export interface FakeService {
  url: string;
  port: number;
  requests: Recorded[];
  state: FakeState;
  close(): Promise<void>;
}

const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });

/** An in-process stand-in for services/local-audio that speaks the same HTTP contract. */
export async function startFakeService(catalogue: ClonableCatalogue, initial: Partial<FakeState> = {}): Promise<FakeService> {
  const state: FakeState = { revision: "fake-1", model: "fake-tts", apiVersion: 1, service: "midnight-radio-local-audio", tts: { sampleRate: 24_000, ready: true }, ...initial };
  const requests: Recorded[] = [];
  const stub = new StubProvider();

  const server: Server = createServer(async (req, res) => {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = raw ? JSON.parse(raw) : undefined;
    } catch {
      body = raw;
    }
    requests.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });

    if (state.token && req.headers.authorization !== `Bearer ${state.token}`) {
      res.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "unauthorized", message: "a valid access token is required" } }));
      return;
    }
    if (req.url === "/health") {
      res.writeHead(state.healthStatus ?? 200, { "content-type": "application/json" });
      res.end(
        state.healthBody ??
          JSON.stringify({
            service: state.service,
            apiVersion: state.apiVersion,
            backend: "fake",
            tts: state.tts && { model: state.model, revision: state.revision, ...state.tts },
            sfx: null,
            voices:
              state.voices ??
              Object.fromEntries(catalogue.voices.map((v) => [v.id, { clipSha256: v.clip.sha256, transcriptSha256: transcriptHash(v.clip.transcript) }])),
          }),
      );
      return;
    }
    if (req.url === "/tts" && req.method === "POST") {
      const b = body as { voiceId: string; text: string; delivery?: string; seed?: number };
      if (state.tts_handler && (await state.tts_handler(req, res, b))) return;
      const wav = await stub.synthesize({ voiceId: b.voiceId, text: b.text, ...(b.delivery ? { delivery: b.delivery as never } : {}) });
      res.writeHead(200, { "content-type": "audio/wav", "content-length": String(wav.length), "x-model-revision": state.revision }).end(wav);
      return;
    }
    res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ error: { code: "not_found", message: "no such endpoint" } }));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    state,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A loopback port with nothing listening on it. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

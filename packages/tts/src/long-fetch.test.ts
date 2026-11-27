import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { fetchWithTimeouts } from "./long-fetch.js";

let server: Server | null = null;
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

describe("fetchWithTimeouts", () => {
  it("behaves like fetch for the parts the clients use: status, headers, JSON, streamed bodies, redirects refused, abort", async () => {
    server = createServer((req, res) => {
      if (req.url === "/redirect") return res.writeHead(302, { location: "/elsewhere" }).end();
      if (req.url === "/slow") return setTimeout(() => res.writeHead(200).end("late"), 2_000);
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => res.writeHead(201, { "content-type": "application/json", "x-request-id": "r1" }).end(JSON.stringify({ got: Buffer.concat(chunks).toString(), auth: req.headers.authorization ?? null })));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    const f = fetchWithTimeouts(5_000);
    const res = await f(`${base}/echo`, { method: "POST", headers: { authorization: "Bearer t" }, body: JSON.stringify({ a: 1 }) });
    expect([res.status, res.ok, res.headers.get("x-request-id")]).toEqual([201, true, "r1"]);
    expect(await res.json()).toEqual({ got: '{"a":1}', auth: "Bearer t" });
    await expect(f(`${base}/redirect`, { redirect: "error" })).rejects.toThrow();
    const started = Date.now();
    await expect(f(`${base}/slow`, { signal: AbortSignal.timeout(300) })).rejects.toMatchObject({ name: expect.stringMatching(/TimeoutError|AbortError/) });
    expect(Date.now() - started).toBeLessThan(1_500); // the caller's signal still decides
  });
});

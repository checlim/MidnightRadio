import { describe, expect, it } from "vitest";
import { SECRET_ENV_VARS, errorFields, jsonLogger, secretsFrom } from "./log.js";

const capture = (secrets: string[] = []) => {
  const out: Record<string, unknown>[] = [];
  return { log: jsonLogger((l) => out.push(JSON.parse(l) as Record<string, unknown>), secrets), out };
};

describe("jsonLogger", () => {
  it("writes one JSON object per line with time, level, message and fields", () => {
    const { log, out } = capture();
    log.info("worker started", { jobKinds: ["render"], dataDir: "/data", n: 3, ok: true });
    expect(out[0]).toMatchObject({ level: "info", msg: "worker started", jobKinds: ["render"], dataDir: "/data", n: 3, ok: true });
    expect(typeof out[0]!.time).toBe("string");
  });

  it("masks the configured secrets and credential patterns in the message and every string field", () => {
    const key = "sk-proj-AbCdEfGhIjKlMnOpQrStUv0123";
    const passkey = "moonlit-ravens-1897";
    const { log, out } = capture([key, passkey]);
    log.error(`request failed with key ${key}`, { message: `Authorization: Bearer abcdefghijklmnop`, tried: [passkey, "plain"], code: 401 });
    const line = JSON.stringify(out[0]);
    expect(line).not.toContain(key);
    expect(line).not.toContain(passkey);
    expect(line).not.toContain("abcdefghijklmnop");
    expect(out[0]).toMatchObject({ code: 401, tried: ["[redacted]", "plain"] });
  });

  it("masks errors logged through errorFields", () => {
    const token = "local-audio-token-0123456789";
    const { log, out } = capture([token]);
    log.error("job error", errorFields(new Error(`service said: bad token ${token}`)));
    expect(JSON.stringify(out[0])).not.toContain(token);
  });

  it("leaves ordinary text alone", () => {
    const { log, out } = capture(["unrelated-secret-value"]);
    log.info("rendered chapter", { chapterId: "3f2c9a1e-7b44-4c1a-9d1e-2a6b5c4d3e2f", path: "/data/render-cache" });
    expect(out[0]).toMatchObject({ msg: "rendered chapter", chapterId: "3f2c9a1e-7b44-4c1a-9d1e-2a6b5c4d3e2f", path: "/data/render-cache" });
  });
});

describe("secretsFrom", () => {
  it("collects the values of the secret variables that are set", () => {
    expect(SECRET_ENV_VARS).toContain("LLM_API_KEY");
    expect(secretsFrom({ LLM_API_KEY: " k-123456 ", UPLOAD_PASSKEY: "", LOCAL_AUDIO_TOKEN: undefined, OTHER: "x" })).toEqual(["k-123456"]);
  });
});

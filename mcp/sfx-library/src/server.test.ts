import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CATALOGUE } from "./test-fixture.js";
import { MAX_SCRIPT_CHARS, createServer } from "./server.js";

const here = dirname(fileURLToPath(import.meta.url));

type ToolResult = { content: { type: string; text: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };

describe("sfx-library over MCP (in memory)", () => {
  let dir: string;
  let indexPath: string;
  let client: Client;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mr-mcp-"));
    indexPath = join(dir, "index.json");
    await writeFile(indexPath, JSON.stringify(CATALOGUE));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await createServer(indexPath).connect(serverSide);
    client = new Client({ name: "test", version: "1" });
    await client.connect(clientSide);
  });
  afterEach(async () => {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  });
  const call = (name: string, args: Record<string, unknown> = {}) => client.callTool({ name, arguments: args }) as Promise<ToolResult>;

  it("offers exactly the four read-only tools", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["audit_script_sfx", "get_sfx", "list_music_cues", "search_sfx"]);
    for (const t of tools) expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  });

  it("search_sfx, get_sfx and list_music_cues answer with structured results", async () => {
    const search = await call("search_sfx", { query: "door", limit: 1 });
    expect(search.structuredContent).toEqual({ results: [expect.objectContaining({ id: "door_creak" })] });
    expect(JSON.parse(search.content[0]!.text)).toEqual(search.structuredContent);
    const beds = await call("search_sfx", { query: "", loopable: true, kind: "sfx" });
    expect((beds.structuredContent!.results as { id: string }[]).map((r) => r.id)).toEqual(["hearth", "rain"]);
    expect((await call("get_sfx", { id: "rain" })).structuredContent).toMatchObject({ path: "assets/sfx/beds/rain.wav", loopable: true });
    expect((await call("list_music_cues")).structuredContent).toMatchObject({ cues: { theme: { id: "main_theme" }, sting: null, transition: null } });
  });

  it("audit_script_sfx reports problems with their location", async () => {
    const script = { bookId: "b", chapterId: "c", episodeNumber: 1, coldOpen: [{ kind: "announcer", text: "Hi." }, { kind: "music", cue: "sting" }], scenes: [{ id: "s1", ambience: { kind: "sfx", id: "door_creak" }, segments: [{ kind: "narration", text: "x" }] }], close: [{ kind: "announcer", text: "Bye." }, { kind: "music", cue: "theme" }] };
    const r = await call("audit_script_sfx", { scriptJson: JSON.stringify(script) });
    expect(r.structuredContent).toMatchObject({ ok: false, schemaErrors: [] });
    expect((r.structuredContent!.issues as { path: string; code: string }[]).map((i) => [i.path, i.code])).toEqual([["coldOpen[1]", "unmapped_cue"], ["scenes[0].ambience", "not_loopable"]]);
  });

  it("answers bad requests with tool errors, not crashes", async () => {
    const unknown = await call("get_sfx", { id: "ghost" });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]!.text).toMatch(/not in the sound library; use search_sfx/);
    const tooBig = await call("audit_script_sfx", { scriptJson: "x".repeat(MAX_SCRIPT_CHARS + 1) });
    expect(tooBig.isError).toBe(true);
    expect((await call("search_sfx", { query: "door", limit: 0 })).isError).toBe(true);
    await writeFile(indexPath, "{broken");
    const broken = await call("search_sfx", { query: "door" });
    expect(broken.isError).toBe(true);
    expect(broken.content[0]!.text).toMatch(/index\.json is not valid JSON/);
    // and the server keeps working once the file is fixed
    await writeFile(indexPath, JSON.stringify({ ...CATALOGUE, id: "fixed" }));
    expect((await call("search_sfx", { query: "door" })).isError).toBeFalsy();
  });
});

describe("the stdio launcher", () => {
  let client: Client;
  let elsewhere: string;
  const stderr: string[] = [];

  beforeAll(async () => {
    // Started from an unrelated directory, as an MCP host might, it still finds its sources and the library.
    elsewhere = await mkdtemp(join(tmpdir(), "mr-mcp-cwd-"));
    const transport = new StdioClientTransport({ command: process.execPath, args: [resolve(here, "../bin/sfx-library.mjs")], cwd: elsewhere, stderr: "pipe" });
    transport.stderr?.on("data", (d: Buffer) => stderr.push(d.toString()));
    client = new Client({ name: "test", version: "1" });
    await client.connect(transport);
  }, 30_000);
  afterAll(async () => {
    await client?.close();
    await rm(elsewhere, { recursive: true, force: true });
  });

  it("speaks MCP on stdout, logs only to stderr, and serves the repository's library", async () => {
    expect(client.getServerVersion()).toMatchObject({ name: "sfx-library" });
    expect((await client.listTools()).tools).toHaveLength(4);
    const r = (await client.callTool({ name: "list_music_cues", arguments: {} })) as ToolResult;
    expect(r.isError).toBeFalsy();
    expect(stderr.join("")).toContain(resolve(here, "../../../assets/sfx/index.json"));
  });
});

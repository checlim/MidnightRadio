import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CatalogueFile, auditScript, getSfx, listMusicCues, searchSfx } from "./library.js";

/**
 * The `sfx-library` MCP server: four read-only tools over `assets/sfx/index.json` for Kiro and
 * custom agents during development (finding sounds, checking a Script's foley). The running app
 * does not use it; adaptation reads the same catalogue in-process. A library that cannot be read
 * (e.g. invalid index.json) is reported by the SDK as a tool error with the message.
 */

export const SERVER_NAME = "sfx-library";
export const SERVER_VERSION = "1.0.0";
/** Longest Script accepted by `audit_script_sfx`. A chapter's Script is far smaller. */
export const MAX_SCRIPT_CHARS = 1_000_000;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const json = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> });
const failure = (message: string) => ({ content: [{ type: "text" as const, text: message }], isError: true });

const summary = z.object({ id: z.string(), kind: z.enum(["sfx", "music"]), title: z.string(), tags: z.array(z.string()), durationMs: z.number(), loopable: z.boolean(), licence: z.string() });

export function createServer(indexPath: string): McpServer {
  const file = new CatalogueFile(indexPath);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    "search_sfx",
    {
      title: "Search the sound library",
      description: "Find sound effects and music in assets/sfx/index.json by words in their id, title, tags or generation prompt. Use the returned ids in Scripts; never invent ids. An empty query lists everything.",
      inputSchema: {
        query: z.string().max(200).describe("Words to look for, e.g. 'door creak' or 'rain'"),
        limit: z.number().int().min(1).max(50).optional().describe("Most results to return (default 10)"),
        kind: z.enum(["sfx", "music"]).optional().describe("Only sound effects or only music"),
        loopable: z.boolean().optional().describe("true: only beds that can be a scene's ambience; false: only one-off sounds"),
      },
      outputSchema: { results: z.array(summary) },
      annotations: READ_ONLY,
    },
    (args) => json({ results: searchSfx(file.load(), args) }),
  );

  server.registerTool(
    "get_sfx",
    {
      title: "Details of one sound",
      description: "File path, length, peak level, whether it loops, music cues it is pinned to, and its source and licence (attribution) for one sound id.",
      inputSchema: { id: z.string().max(100).describe("A sound id from search_sfx") },
      outputSchema: { ...summary.shape, path: z.string(), sha256: z.string(), peakDb: z.number(), attribution: z.string(), musicCues: z.array(z.string()) },
      annotations: READ_ONLY,
    },
    ({ id }) => {
      const details = getSfx(file.load(), id);
      return details ? json(details) : failure(`"${id}" is not in the sound library; use search_sfx to find a valid id`);
    },
  );

  server.registerTool(
    "list_music_cues",
    {
      title: "Music cues and ambience beds",
      description: "Which music each Script cue (theme, sting, transition) plays, or null if none is pinned yet, and every loopable bed that can be a scene's ambience.",
      outputSchema: { cues: z.object({ theme: summary.nullable(), sting: summary.nullable(), transition: summary.nullable() }), beds: z.array(summary) },
      annotations: READ_ONLY,
    },
    () => json(listMusicCues(file.load())),
  );

  server.registerTool(
    "audit_script_sfx",
    {
      title: "Check a Script's sounds",
      description: "Validate a Script (JSON text) against the Script schema, then check every sfx id, scene ambience bed, music cue and requested duration against the sound library, with the same rules the pipeline applies. Reports each problem with its location in the Script.",
      inputSchema: { scriptJson: z.string().max(MAX_SCRIPT_CHARS).describe("The whole Script as JSON text") },
      outputSchema: {
        ok: z.boolean(),
        catalogueId: z.string(),
        schemaErrors: z.array(z.string()),
        issues: z.array(z.object({ code: z.string(), id: z.string(), path: z.string(), message: z.string() })),
        note: z.string(),
      },
      annotations: READ_ONLY,
    },
    ({ scriptJson }) => json(auditScript(file.load(), scriptJson)),
  );

  return server;
}

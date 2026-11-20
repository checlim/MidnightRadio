import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";

/**
 * stdio entry point. stdout carries only MCP messages, so nothing here prints to it.
 * The library is found relative to this file, whatever the working directory is.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const indexPath = resolve(root, "assets/sfx/index.json");

const server = createServer(indexPath);
await server.connect(new StdioServerTransport());
process.stderr.write(`sfx-library: serving ${indexPath}\n`);

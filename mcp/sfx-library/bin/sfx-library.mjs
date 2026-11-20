#!/usr/bin/env node
// Launcher for the sfx-library MCP server. Loads the TypeScript sources through tsx, resolved
// from this file's location, so the server starts the same from any working directory.
import { register } from "tsx/esm/api";

register();
await import("../src/main.ts");

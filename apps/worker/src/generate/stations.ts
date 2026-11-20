import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { StationListSchema, type Station } from "@midnight-radio/core";

/**
 * Put stations into the list, replacing any with the same id and keeping the rest in place; new
 * ones go at the end in the order given. The result is checked against the player's schema. Pure.
 */
export function mergeStations(existing: readonly Station[], updates: readonly Station[]): Station[] {
  const byId = new Map(updates.map((s) => [s.id, s]));
  const merged = existing.map((s) => byId.get(s.id) ?? s);
  const known = new Set(existing.map((s) => s.id));
  for (const s of updates) if (!known.has(s.id)) merged.push(s);
  return StationListSchema.parse({ stations: merged }).stations;
}

/** The station list at `path`, or an empty list if there is none yet. A malformed file is an error, never silently replaced. */
export async function readStations(path: string): Promise<Station[]> {
  if (!existsSync(path)) return [];
  const parsed = StationListSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
  if (!parsed.success) throw new Error(`${path} is not a valid station list; fix or remove it`);
  return parsed.data.stations;
}

/** Write the list atomically (unique temp file in the same folder, flushed, renamed). */
export async function writeStations(path: string, stations: readonly Station[]): Promise<void> {
  const body = `${JSON.stringify(StationListSchema.parse({ stations }), null, 2)}\n`;
  const tmp = join(dirname(path), `.stations.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fh = await open(tmp, "wx");
    try {
      await fh.writeFile(body);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true });
  }
}

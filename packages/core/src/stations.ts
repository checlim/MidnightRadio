import { z } from "zod";

/**
 * The player's station list (`apps/web/public/stations.json`, Req 7.1, 7.5): each rendered
 * Episode is a station; a chapter still rendering is a "warming up" station with progress. Shared
 * by the player, which validates the fetched list, and the generator, which writes it. Imports
 * only zod, so the browser bundle can use it (`@midnight-radio/core/stations`).
 */

/** A path on this site: starts with one "/" (so not "//host/…"), plain characters, no "." or ".." segments. */
const url = z
  .string()
  .min(1)
  .max(500)
  .regex(/^\/(?!\/)[\w\-./]*$/, "station files must be same-site paths")
  .refine((p) => !p.split("/").slice(1).some((seg) => seg === "" || seg === "." || seg === ".."), "station files must be same-site paths");

export const StationSchema = z.discriminatedUnion("status", [
  z.strictObject({
    status: z.literal("ready"),
    id: z.string().regex(/^[\w-]{1,80}$/),
    book: z.string().min(1).max(200),
    author: z.string().min(1).max(200),
    episodeNumber: z.number().int().min(1),
    title: z.string().min(1).max(200),
    durationMs: z.number().int().positive(),
    cleanUrl: url,
    amUrl: url,
    vttUrl: url,
  }),
  z.strictObject({
    status: z.literal("warming"),
    id: z.string().regex(/^[\w-]{1,80}$/),
    book: z.string().min(1).max(200),
    author: z.string().min(1).max(200),
    episodeNumber: z.number().int().min(1),
    title: z.string().min(1).max(200),
    rendered: z.number().int().min(0),
    total: z.number().int().min(1),
  }),
]);
export type Station = z.infer<typeof StationSchema>;

export const StationListSchema = z.strictObject({ stations: z.array(StationSchema).max(200) }).superRefine((l, ctx) => {
  const ids = new Set<string>();
  l.stations.forEach((s, i) => {
    if (ids.has(s.id)) ctx.addIssue({ code: "custom", path: ["stations", i, "id"], message: `duplicate station "${s.id}"` });
    ids.add(s.id);
  });
});

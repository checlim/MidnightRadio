import { z } from "zod";

/** Configured bounds. Keep in sync with design.md "Script Schema". */
export const LIMITS = {
  maxCueDurationMs: 60_000,
  maxPauseMs: 10_000,
  minGainDb: -40,
  maxGainDb: 0,
  defaultBedGainDb: -14,
} as const;

export const DELIVERIES = ["neutral", "whisper", "urgent", "fearful", "sinister", "warm"] as const;
export const MUSIC_CUES = ["theme", "sting", "transition"] as const;

const text = z.string().trim().min(1, "text must not be empty");
const id = z.string().trim().min(1);
const durationMs = z.number().int().min(0).max(LIMITS.maxCueDurationMs);

export const DeliverySchema = z.enum(DELIVERIES);

export const SegmentSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("announcer"), text, delivery: DeliverySchema.optional() }),
  z.strictObject({
    kind: z.literal("narration"),
    text,
    delivery: DeliverySchema.optional(),
    containsVerbatimQuote: z.boolean().optional(),
  }),
  z.strictObject({
    kind: z.literal("dialogue"),
    speaker: id,
    text,
    delivery: DeliverySchema.optional(),
  }),
  z.strictObject({ kind: z.literal("sfx"), sfxId: id, durationMs: durationMs.optional() }),
  z.strictObject({
    kind: z.literal("music"),
    cue: z.enum(MUSIC_CUES),
    durationMs: durationMs.optional(),
  }),
  z.strictObject({
    kind: z.literal("pause"),
    ms: z.number().int().min(1).max(LIMITS.maxPauseMs),
  }),
]);

export const SceneBedSchema = z.strictObject({
  kind: z.enum(["sfx", "music"]),
  id,
  gainDb: z.number().min(LIMITS.minGainDb).max(LIMITS.maxGainDb).optional(),
});

export const SceneSchema = z.strictObject({
  id,
  title: z.string().trim().min(1).optional(),
  ambience: SceneBedSchema.optional(),
  segments: z.array(SegmentSchema).min(1),
});

export const ScriptSchema = z
  .strictObject({
    bookId: id,
    chapterId: id,
    episodeNumber: z.number().int().min(1),
    coldOpen: z.array(SegmentSchema).min(1),
    scenes: z.array(SceneSchema).min(1),
    close: z.array(SegmentSchema).min(1),
  })
  .superRefine((script, ctx) => {
    if (script.coldOpen[0]?.kind !== "announcer") {
      ctx.addIssue({
        code: "custom",
        path: ["coldOpen", 0],
        message: "first cold-open segment must be an announcer",
      });
    }
    if (!script.close.some((s) => s.kind === "announcer")) {
      ctx.addIssue({
        code: "custom",
        path: ["close"],
        message: "close must contain an announcer line",
      });
    }
    if (!script.close.some((s) => s.kind === "music" && s.cue === "theme")) {
      ctx.addIssue({
        code: "custom",
        path: ["close"],
        message: "close must contain a theme music cue",
      });
    }
    const seen = new Set<string>();
    script.scenes.forEach((scene, i) => {
      if (seen.has(scene.id)) {
        ctx.addIssue({
          code: "custom",
          path: ["scenes", i, "id"],
          message: `duplicate scene id "${scene.id}"`,
        });
      }
      seen.add(scene.id);
    });
  });

export type Delivery = z.infer<typeof DeliverySchema>;
export type Segment = z.infer<typeof SegmentSchema>;
export type SceneBed = z.infer<typeof SceneBedSchema>;
export type Scene = z.infer<typeof SceneSchema>;
export type Script = z.infer<typeof ScriptSchema>;

/** JSON Schema (draft 2020-12) for the Script, used for LLM structured output and tooling. */
export function scriptJsonSchema(): Record<string, unknown> {
  return z.toJSONSchema(ScriptSchema, { target: "draft-2020-12" }) as Record<string, unknown>;
}

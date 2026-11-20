/**
 * Static ↔ broadcast cross-fade (Req 7.2). Pure. Within `captureWidth` of a station the needle is
 * "close": the broadcast fades in and the static out along an equal-power curve, so the total
 * loudness stays steady while turning. Beyond it there is only static. On the station itself a
 * faint residue of static stays, like a real set.
 */

export interface CrossfadeGains {
  broadcast: number;
  static: number;
}

/** Dial units (0–1) over which a station comes in. */
export const CAPTURE_WIDTH = 0.035;
/** Static left on a perfectly tuned station. */
export const STATIC_FLOOR = 0.04;

export function crossfadeGains(distance: number, captureWidth = CAPTURE_WIDTH, floor = STATIC_FLOOR): CrossfadeGains {
  const x = Math.min(1, Math.max(0, Number.isFinite(distance) ? distance / captureWidth : 1));
  // Exact at the ends: beyond the capture width the broadcast is truly silent.
  const broadcast = x >= 1 ? 0 : Math.cos((x * Math.PI) / 2);
  const noise = x >= 1 ? 1 : Math.sin((x * Math.PI) / 2);
  return { broadcast, static: floor + (1 - floor) * noise };
}

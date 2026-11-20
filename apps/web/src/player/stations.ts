
/**
 * Stations on the dial (Req 7.1, 7.5). Each rendered Episode is a station; a chapter still
 * rendering is a "warming up" station with progress. The list is fetched JSON, so it is validated
 * here before the player uses it. Pure.
 */

import type { Station } from "@midnight-radio/core/stations";
export { StationListSchema, StationSchema, type Station } from "@midnight-radio/core/stations";

/** The AM broadcast band printed on the dial. */
export const BAND_KHZ = { low: 540, high: 1600 } as const;
/** Stations sit between these dial positions, leaving room at both ends to tune past them. */
const MARGIN = 0.1;

/** Where each station sits on the dial, 0–1, evenly spaced in list order. */
export function stationPositions(count: number): number[] {
  if (count === 0) return [];
  if (count === 1) return [0.5];
  return Array.from({ length: count }, (_, i) => MARGIN + ((1 - 2 * MARGIN) * i) / (count - 1));
}

/** The frequency shown for a dial position, rounded to the 10 kHz channel spacing. */
export const frequencyAt = (position: number): number => Math.round((BAND_KHZ.low + (BAND_KHZ.high - BAND_KHZ.low) * clamp01(position)) / 10) * 10;

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, Number.isFinite(x) ? x : 0));

export interface Tuning {
  /** Index of the station nearest the needle, or -1 if there are none. */
  index: number;
  /** Distance from the needle to that station, in dial units (0–1). */
  distance: number;
}

/** The station nearest a dial position; ties go to the lower one. */
export function nearestStation(positions: readonly number[], position: number): Tuning {
  let index = -1;
  let distance = Infinity;
  positions.forEach((p, i) => {
    const d = Math.abs(p - position);
    if (d < distance) {
      index = i;
      distance = d;
    }
  });
  return { index, distance: index === -1 ? Infinity : distance };
}

/** The dial position of the next station up or down from where the needle is, for arrow-key tuning. */
export function stepStation(positions: readonly number[], position: number, direction: 1 | -1): number {
  if (positions.length === 0) return clamp01(position);
  const eps = 1e-6;
  if (direction === 1) return positions.find((p) => p > position + eps) ?? positions[positions.length - 1]!;
  for (let i = positions.length - 1; i >= 0; i--) if (positions[i]! < position - eps) return positions[i]!;
  return positions[0]!;
}

/** Words for screen readers: the slider's `aria-valuetext`. */
export function describeTuning(stations: readonly Station[], positions: readonly number[], position: number, captureWidth: number): string {
  const t = nearestStation(positions, position);
  const khz = `${frequencyAt(position)} kilocycles`;
  if (t.index === -1 || t.distance > captureWidth) return `${khz}, static`;
  const s = stations[t.index]!;
  const what = `${s.book}, episode ${s.episodeNumber}: ${s.title}`;
  return s.status === "warming" ? `${khz}, ${what}, warming up, ${s.rendered} of ${s.total} lines rendered` : `${khz}, ${what}`;
}

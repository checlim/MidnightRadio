/**
 * Player keyboard shortcuts (Req 7.4). Pure. Space toggles play/pause and the arrow keys tune to
 * the previous or next station, but only while focus is on a player control, never while the
 * listener is typing into a field (the transcript search, the upload form), and never with a
 * modifier held (so browser and screen-reader shortcuts keep working).
 */

export type PlayerAction = "toggle" | "previous" | "next";

export interface KeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  /** The focused element: its tag name, `contentEditable` state, `role` and whether it is inside the player. */
  target: { tagName: string; isContentEditable?: boolean; role?: string | null; inPlayer: boolean };
}

const TYPING = new Set(["INPUT", "TEXTAREA", "SELECT"]);

export function playerKeyAction(e: KeyInput): PlayerAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  if (!e.target.inPlayer) return null;
  if (TYPING.has(e.target.tagName.toUpperCase()) || e.target.isContentEditable) return null;
  if (e.key === " " || e.key === "Spacebar") {
    // A button already toggles on Space by itself; acting here as well would toggle twice.
    if (e.target.tagName.toUpperCase() === "BUTTON") return null;
    return "toggle";
  }
  if (e.key === "ArrowLeft" || e.key === "ArrowDown") return "previous";
  if (e.key === "ArrowRight" || e.key === "ArrowUp") return "next";
  return null;
}

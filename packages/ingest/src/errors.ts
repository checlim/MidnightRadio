export type IngestErrorCode =
  | "too_large" // over the upload limit
  | "not_epub" // not a ZIP / EPUB container at all
  | "malformed" // a ZIP, but the EPUB structure is broken
  | "unsafe_archive" // path traversal, ZIP bomb, symlinks, entity declarations…
  | "drm" // encrypted or rights-managed content
  | "no_text" // parsed, but no readable chapter text
  | "timeout"; // parsing took too long

/** Rejection with a specific, human-readable reason (Req 1.2). Messages are safe to show users. */
export class IngestError extends Error {
  constructor(
    readonly code: IngestErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "IngestError";
  }
}

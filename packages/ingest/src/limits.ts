import { IngestError } from "./errors.js";

export interface IngestLimits {
  /** Upload limit (Req 1.1: "at most 20 MB"). */
  maxEpubBytes: number;
  maxEntries: number;
  /** Largest single text file (container, OPF, nav, XHTML) we will inflate. */
  maxEntryBytes: number;
  /** Total bytes we will inflate across all text files. */
  maxTotalInflatedBytes: number;
  /** Largest inflated/compressed ratio allowed for entries above `ratioCheckMinBytes`. */
  maxCompressionRatio: number;
  ratioCheckMinBytes: number;
  /** Wall-clock budget for the whole ingest. */
  deadlineMs: number;
}

export const DEFAULT_LIMITS: IngestLimits = {
  maxEpubBytes: 20 * 1024 * 1024,
  maxEntries: 5_000,
  maxEntryBytes: 16 * 1024 * 1024,
  maxTotalInflatedBytes: 64 * 1024 * 1024,
  maxCompressionRatio: 100,
  ratioCheckMinBytes: 1024 * 1024,
  deadlineMs: 15_000,
};

/** Shared budget for one ingest run. */
export class Budget {
  private inflated = 0;
  private readonly deadline: number;

  constructor(
    readonly limits: IngestLimits,
    private readonly now: () => number = Date.now,
  ) {
    this.deadline = now() + limits.deadlineMs;
  }

  checkDeadline(): void {
    if (this.now() > this.deadline) {
      throw new IngestError("timeout", "This EPUB took too long to read. It may be unusually large or complex.");
    }
  }

  chargeInflated(bytes: number): void {
    this.inflated += bytes;
    if (this.inflated > this.limits.maxTotalInflatedBytes) {
      throw new IngestError("unsafe_archive", "This EPUB expands to far more text than a book would. It was rejected as unsafe.");
    }
  }
}

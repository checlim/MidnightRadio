import { TtsError } from "./provider.js";

/** First-come first-served limit on concurrent renders. Waiting can be abandoned with a signal. */
export class Semaphore {
  private free: number;
  private readonly waiting: { grant: () => void; cancel: () => void }[] = [];

  constructor(readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) throw new Error("concurrency must be a positive integer");
    this.free = limit;
  }

  get inUse(): number {
    return this.limit - this.free;
  }

  acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(aborted());
    if (this.free > 0) {
      this.free--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const waiter = {
        grant: () => {
          signal?.removeEventListener("abort", waiter.cancel);
          resolve();
        },
        cancel: () => {
          const i = this.waiting.indexOf(waiter);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(aborted());
        },
      };
      signal?.addEventListener("abort", waiter.cancel, { once: true });
      this.waiting.push(waiter);
    });
  }

  release(): void {
    const next = this.waiting.shift();
    if (next) next.grant(); // the slot passes straight to the next in line
    else this.free++;
  }
}

export const aborted = () => new TtsError("aborted", "render aborted", false, false);

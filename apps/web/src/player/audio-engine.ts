import { crossfadeGains } from "./crossfade";

/**
 * The radio's sound (Req 7.1, 7.2). Browser-only, but it reaches Web Audio and `<audio>` only
 * through the narrow interfaces below, so tests drive it with fakes.
 *
 * Graph: each Episode variant (clean, AM) is an `<audio>` element → its variant gain → broadcast
 * gain; looped pink noise → band-pass → static gain; both → master → speakers. `powerOn` must run
 * inside the listener's gesture (the POWER switch): it creates or resumes the AudioContext, plays
 * a short tube-warmup hum and lets the static come up as the "valves" warm. Tuning moves the
 * broadcast/static gains along the equal-power curve. Switching variant keeps the playback
 * position: the other file seeks there, starts, the two cross-fade, and the old one pauses.
 */

export interface ParamLike {
  value: number;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  cancelScheduledValues(startTime: number): unknown;
}
export interface NodeLike {
  connect(dest: NodeLike): unknown;
  disconnect(): unknown;
}
export interface GainLike extends NodeLike {
  gain: ParamLike;
}
export interface FilterLike extends NodeLike {
  type: string;
  frequency: ParamLike;
  Q: ParamLike;
}
export interface BufferLike {
  getChannelData(channel: number): Float32Array;
}
export interface SourceLike extends NodeLike {
  buffer: BufferLike | null;
  loop: boolean;
  start(when?: number): unknown;
  stop(when?: number): unknown;
}
export interface OscillatorLike extends NodeLike {
  type: string;
  frequency: ParamLike;
  start(when?: number): unknown;
  stop(when?: number): unknown;
}
export interface ContextLike {
  readonly currentTime: number;
  readonly sampleRate: number;
  readonly state: string;
  readonly destination: NodeLike;
  createGain(): GainLike;
  createBiquadFilter(): FilterLike;
  createBuffer(channels: number, length: number, sampleRate: number): BufferLike;
  createBufferSource(): SourceLike;
  createOscillator(): OscillatorLike;
  createMediaElementSource(el: unknown): NodeLike;
  resume(): Promise<unknown>;
  suspend(): Promise<unknown>;
}
export interface MediaLike {
  src: string;
  currentTime: number;
  readonly paused: boolean;
  /** Set after a failed load or decode; the element stays broken until `load()`. */
  readonly error: unknown;
  crossOrigin: string | null;
  preload: string;
  play(): Promise<unknown>;
  pause(): unknown;
  load(): unknown;
  addEventListener(type: string, fn: () => void): unknown;
}

export interface EngineDeps {
  createContext(): ContextLike;
  createMedia(): MediaLike;
}

export type Variant = "clean" | "am";

export interface EngineState {
  power: "off" | "warming" | "on";
  /** The listener wants the station playing (they can pause it with Space or the play button). */
  wantsPlay: boolean;
  /** The browser refused to start playback: show a retry button. */
  blocked: boolean;
  variant: Variant;
  /** The ready station whose files are loaded, if any. */
  stationId: string | null;
}

export const WARMUP_SECONDS = 1.5;
const SMOOTH = 0.03; // seconds; gain changes while turning the dial
const VARIANT_FADE = 0.08;

/** Two seconds of seeded pink noise (Paul Kellet's filter), looped as the static. */
export function pinkNoise(length: number, seed = 1940): Float32Array {
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (s * 1_664_525 + 1_013_904_223) >>> 0) / 0xffffffff) * 2 - 1;
  const out = new Float32Array(length);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < length; i++) {
    const w = rand();
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return out;
}

export interface StationFiles {
  id: string;
  cleanUrl: string;
  amUrl: string;
}

export class RadioEngine {
  private ctx: ContextLike | undefined;
  private master: GainLike | undefined;
  private broadcast: GainLike | undefined;
  private staticGain: GainLike | undefined;
  private media: Record<Variant, { el: MediaLike; gain: GainLike }> | undefined;
  private noise: SourceLike | undefined;
  private distance = Infinity;
  private listeners = new Set<(s: EngineState) => void>();
  private state: EngineState = { power: "off", wantsPlay: true, blocked: false, variant: "clean", stationId: null };

  constructor(private readonly deps: EngineDeps) {}

  getState(): EngineState {
    return this.state;
  }

  onChange(fn: (s: EngineState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<EngineState>) {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  /** The playing element (the current variant). */
  currentMedia(): MediaLike | undefined {
    return this.media?.[this.state.variant].el;
  }

  /** Build the graph on first use. Must run inside a user gesture. */
  private build(): ContextLike {
    if (this.ctx) return this.ctx;
    const ctx = this.deps.createContext();
    const master = ctx.createGain();
    master.gain.value = 0;
    master.connect(ctx.destination);
    const broadcast = ctx.createGain();
    broadcast.gain.value = 0;
    broadcast.connect(master);
    const staticGain = ctx.createGain();
    staticGain.gain.value = 0;
    const band = ctx.createBiquadFilter();
    band.type = "bandpass";
    band.frequency.value = 1800;
    band.Q.value = 0.6;
    band.connect(staticGain);
    staticGain.connect(master);
    const variant = (v: Variant) => {
      const el = this.deps.createMedia();
      el.preload = "auto";
      el.crossOrigin = "anonymous";
      el.addEventListener("ended", () => this.set({ wantsPlay: false }));
      const gain = ctx.createGain();
      gain.gain.value = v === this.state.variant ? 1 : 0;
      ctx.createMediaElementSource(el).connect(gain);
      gain.connect(broadcast);
      return { el, gain };
    };
    this.media = { clean: variant("clean"), am: variant("am") };
    const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
    buf.getChannelData(0).set(pinkNoise(ctx.sampleRate * 2));
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    noise.connect(band);
    noise.start();
    Object.assign(this, { ctx, master, broadcast, staticGain, noise });
    return ctx;
  }

  /** The POWER switch, on. Call it from the click or key handler itself. */
  async powerOn(): Promise<void> {
    if (this.state.power !== "off") return;
    const ctx = this.build();
    this.set({ power: "warming", blocked: false });
    const resumed = ctx.state === "suspended" ? ctx.resume() : Promise.resolve();
    const t = ctx.currentTime;
    // Tube warmup hum: mains hum and harmonics swelling and dying away.
    const hum = ctx.createGain();
    hum.gain.setValueAtTime(0, t);
    hum.gain.linearRampToValueAtTime(0.05, t + 0.25);
    hum.gain.linearRampToValueAtTime(0, t + WARMUP_SECONDS);
    hum.connect(this.master!);
    for (const [f, type] of [[60, "sine"], [120, "sine"], [180, "triangle"]] as const) {
      const osc = ctx.createOscillator();
      osc.type = type;
      osc.frequency.value = f;
      osc.connect(hum);
      osc.start(t);
      osc.stop(t + WARMUP_SECONDS + 0.05);
    }
    // The set comes up as the valves warm.
    this.master!.gain.cancelScheduledValues(t);
    this.master!.gain.setValueAtTime(0, t);
    this.master!.gain.linearRampToValueAtTime(1, t + WARMUP_SECONDS);
    this.applyTuning();
    await resumed;
    this.set({ power: "on" });
    if (this.state.wantsPlay) await this.startPlayback();
  }

  /** The POWER switch, off: fade out, stop playback, suspend the context. */
  async powerOff(): Promise<void> {
    if (!this.ctx || this.state.power === "off") return;
    const t = this.ctx.currentTime;
    this.master!.gain.cancelScheduledValues(t);
    this.master!.gain.setTargetAtTime(0, t, 0.05);
    for (const v of Object.values(this.media!)) v.el.pause();
    this.set({ power: "off", blocked: false });
    await this.ctx.suspend();
  }

  /**
   * Where the needle is: `distance` from the nearest station, and that station's files if it is
   * ready (null for static or a station still warming up).
   */
  tune(distance: number, station: StationFiles | null): void {
    this.distance = distance;
    if (this.media && station && station.id !== this.state.stationId) {
      this.media.clean.el.src = station.cleanUrl;
      this.media.am.el.src = station.amUrl;
      this.set({ stationId: station.id, wantsPlay: true, blocked: false });
      if (this.state.power === "on") void this.startPlayback();
    } else if (!station && this.state.stationId !== null) {
      for (const v of Object.values(this.media ?? {})) v.el.pause();
      this.set({ stationId: null });
    }
    this.applyTuning();
  }

  private applyTuning(): void {
    if (!this.ctx) return;
    const g = crossfadeGains(this.state.stationId ? this.distance : Infinity);
    const t = this.ctx.currentTime;
    this.broadcast!.gain.setTargetAtTime(g.broadcast, t, SMOOTH);
    this.staticGain!.gain.setTargetAtTime(g.static * 0.35, t, SMOOTH);
  }

  private async startPlayback(): Promise<void> {
    const el = this.currentMedia();
    if (!el || !this.state.stationId || this.state.power !== "on") return;
    try {
      await el.play();
      this.set({ wantsPlay: true, blocked: false });
    } catch {
      // Autoplay policy, a decode error or a network failure: let the listener retry.
      this.set({ blocked: true });
    }
  }

  /** Space / the play button. */
  async togglePlay(): Promise<void> {
    const el = this.currentMedia();
    if (!el || this.state.power !== "on" || !this.state.stationId) return;
    if (el.paused) await this.startPlayback();
    else {
      el.pause();
      this.set({ wantsPlay: false });
    }
  }

  /** The retry button after a refused `play()`. Call it from the click itself. */
  async retry(): Promise<void> {
    if (this.ctx?.state === "suspended") await this.ctx.resume();
    // A failed download leaves the element broken: fetch the file again before playing.
    for (const v of Object.values(this.media ?? {})) if (v.el.error) v.el.load();
    await this.startPlayback();
  }

  /** The Vintage AM / Clean switch: same position, a short cross-fade. */
  async setVariant(variant: Variant): Promise<void> {
    if (variant === this.state.variant) return;
    const from = this.state.variant;
    this.set({ variant });
    if (!this.ctx || !this.media) return;
    const old = this.media[from];
    const next = this.media[variant];
    const t = this.ctx.currentTime;
    const playing = !old.el.paused;
    next.el.currentTime = old.el.currentTime;
    if (playing) {
      try {
        await next.el.play();
      } catch {
        this.set({ blocked: true });
        return;
      }
    }
    old.gain.gain.setTargetAtTime(0, t, VARIANT_FADE / 3);
    next.gain.gain.setTargetAtTime(1, t, VARIANT_FADE / 3);
    if (playing) setTimeout(() => old.el.pause(), VARIANT_FADE * 4000);
  }

  /** Jump to a point in the episode (a transcript line was chosen). */
  seek(ms: number): void {
    const el = this.currentMedia();
    if (el) el.currentTime = Math.max(0, ms / 1000);
  }
}

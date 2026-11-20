import { describe, expect, it } from "vitest";
import { RadioEngine, WARMUP_SECONDS, pinkNoise, type ContextLike, type MediaLike, type ParamLike } from "./audio-engine";
import { CAPTURE_WIDTH, STATIC_FLOOR } from "./crossfade";

/** A Web Audio stand-in that records every gain change, so the graph's behaviour can be checked. */
class FakeParam implements ParamLike {
  value = 0;
  events: [string, number, number][] = [];
  setTargetAtTime(v: number, t: number) {
    this.events.push(["target", v, t]);
    this.value = v;
  }
  setValueAtTime(v: number, t: number) {
    this.events.push(["set", v, t]);
    this.value = v;
  }
  linearRampToValueAtTime(v: number, t: number) {
    this.events.push(["ramp", v, t]);
    this.value = v;
  }
  cancelScheduledValues() {}
}
class FakeNode {
  connected: FakeNode[] = [];
  connect(n: FakeNode) {
    this.connected.push(n);
  }
  disconnect() {}
}
class FakeGain extends FakeNode {
  gain = new FakeParam();
}
class FakeContext implements ContextLike {
  currentTime = 10;
  sampleRate = 8000;
  state = "suspended";
  destination = new FakeNode();
  gains: FakeGain[] = [];
  oscillators: { frequency: FakeParam; started: number; stopped: number }[] = [];
  resumed = 0;
  createGain() {
    const g = new FakeGain();
    this.gains.push(g);
    return g;
  }
  createBiquadFilter() {
    return Object.assign(new FakeNode(), { type: "", frequency: new FakeParam(), Q: new FakeParam() });
  }
  createBuffer(_c: number, length: number) {
    const data = new Float32Array(length);
    return { getChannelData: () => data };
  }
  createBufferSource() {
    return Object.assign(new FakeNode(), { buffer: null, loop: false, started: false, start() {}, stop() {} });
  }
  createOscillator() {
    const o = { frequency: new FakeParam(), started: -1, stopped: -1 };
    this.oscillators.push(o);
    return Object.assign(new FakeNode(), { type: "", frequency: o.frequency, start: (t = 0) => void (o.started = t), stop: (t = 0) => void (o.stopped = t) });
  }
  createMediaElementSource() {
    return new FakeNode();
  }
  async resume() {
    this.resumed++;
    this.state = "running";
  }
  async suspend() {
    this.state = "suspended";
  }
}
class FakeMedia implements MediaLike {
  src = "";
  currentTime = 0;
  paused = true;
  crossOrigin: string | null = null;
  preload = "";
  refuse = false;
  error: unknown = null;
  loads = 0;
  plays = 0;
  listeners: Record<string, () => void> = {};
  async play() {
    this.plays++;
    if (this.refuse) throw new Error("NotAllowedError");
    this.paused = false;
  }
  pause() {
    this.paused = true;
  }
  load() {
    this.loads++;
    this.error = null;
  }
  addEventListener(type: string, fn: () => void) {
    this.listeners[type] = fn;
  }
}

function setup() {
  const ctx = new FakeContext();
  const media: FakeMedia[] = [];
  const engine = new RadioEngine({ createContext: () => ctx, createMedia: () => (media.push(new FakeMedia()), media.at(-1)!) });
  return { ctx, media, engine, gains: () => ({ master: ctx.gains[0]!, broadcast: ctx.gains[1]!, static: ctx.gains[2]!, clean: ctx.gains[3]!, am: ctx.gains[4]! }) };
}
const STATION = { id: "dracula-1", cleanUrl: "/episodes/dracula-1/episode.mp3", amUrl: "/episodes/dracula-1/episode-am.mp3" };

describe("RadioEngine", () => {
  it("creates nothing before the POWER switch, then warms up with a hum and resumes the context", async () => {
    const { ctx, engine, gains } = setup();
    expect(ctx.gains).toHaveLength(0);
    await engine.powerOn();
    expect(ctx.resumed).toBe(1);
    expect(engine.getState().power).toBe("on");
    expect(ctx.oscillators.map((o) => o.frequency.value)).toEqual([60, 120, 180]);
    expect(ctx.oscillators.every((o) => o.started === 10 && o.stopped > 10 + WARMUP_SECONDS)).toBe(true);
    expect(gains().master.gain.events).toEqual([["set", 0, 10], ["ramp", 1, 10 + WARMUP_SECONDS]]);
    // static only until a station is tuned
    expect(gains().static.gain.value).toBeCloseTo(0.35, 5);
    expect(gains().broadcast.gain.value).toBe(0);
  });

  it("brings a station in along the cross-fade as the needle closes on it, and loads its files", async () => {
    const { engine, gains, media } = setup();
    await engine.powerOn();
    engine.tune(CAPTURE_WIDTH / 2, STATION);
    expect([media[0]!.src, media[1]!.src]).toEqual([STATION.cleanUrl, STATION.amUrl]);
    expect(gains().broadcast.gain.value).toBeCloseTo(Math.cos(Math.PI / 4), 5);
    engine.tune(0, STATION);
    expect(gains().broadcast.gain.value).toBe(1);
    expect(gains().static.gain.value).toBeCloseTo(STATIC_FLOOR * 0.35, 5);
    await Promise.resolve();
    expect(media[0]!.paused).toBe(false); // the clean variant plays
    expect(media[1]!.paused).toBe(true);
  });

  it("goes back to static and stops the episode when tuned away", async () => {
    const { engine, gains, media } = setup();
    await engine.powerOn();
    engine.tune(0, STATION);
    await Promise.resolve();
    engine.tune(0.3, null);
    expect(gains().broadcast.gain.value).toBe(0);
    expect(gains().static.gain.value).toBeCloseTo(0.35, 5);
    expect(media[0]!.paused).toBe(true);
    expect(engine.getState().stationId).toBeNull();
  });

  it("switches Vintage AM and Clean at the same position with a cross-fade", async () => {
    const { engine, gains, media } = setup();
    await engine.powerOn();
    engine.tune(0, STATION);
    await Promise.resolve();
    media[0]!.currentTime = 42.5;
    await engine.setVariant("am");
    expect(media[1]!.currentTime).toBe(42.5);
    expect(media[1]!.paused).toBe(false);
    expect([gains().clean.gain.value, gains().am.gain.value]).toEqual([0, 1]);
    expect(engine.getState().variant).toBe("am");
    expect(engine.currentMedia()).toBe(media[1]);
  });

  it("pauses and resumes with Space, and shows a retry when the browser refuses to play", async () => {
    const { engine, media } = setup();
    await engine.powerOn();
    engine.tune(0, STATION);
    await Promise.resolve();
    await engine.togglePlay();
    expect(media[0]!.paused).toBe(true);
    expect(engine.getState().wantsPlay).toBe(false);
    media[0]!.refuse = true;
    await engine.togglePlay();
    expect(engine.getState().blocked).toBe(true);
    media[0]!.refuse = false;
    await engine.retry();
    expect(engine.getState()).toMatchObject({ blocked: false, wantsPlay: true });
    expect(media[0]!.paused).toBe(false);
  });

  it("reloads a file that failed to download before retrying", async () => {
    const { engine, media } = setup();
    await engine.powerOn();
    media[0]!.refuse = true;
    media[0]!.error = { code: 2 };
    engine.tune(0, STATION);
    await Promise.resolve();
    await Promise.resolve();
    expect(engine.getState().blocked).toBe(true);
    media[0]!.refuse = false;
    await engine.retry();
    expect(media[0]!.loads).toBe(1);
    expect(media[1]!.loads).toBe(0); // the healthy variant is left alone
    expect(engine.getState().blocked).toBe(false);
  });

  it("does not play a station tuned before power-on until the set is on", async () => {
    const { engine, media } = setup();
    engine.tune(0, STATION); // no graph yet: nothing loads or plays
    expect(media).toHaveLength(0);
    await engine.powerOn();
    engine.tune(0, STATION);
    await Promise.resolve();
    expect(media[0]!.plays).toBe(1);
  });

  it("powers off: fades out, pauses, suspends", async () => {
    const { ctx, engine, gains, media } = setup();
    await engine.powerOn();
    engine.tune(0, STATION);
    await Promise.resolve();
    await engine.powerOff();
    expect(engine.getState().power).toBe("off");
    expect(gains().master.gain.value).toBe(0);
    expect(media.every((m) => m.paused)).toBe(true);
    expect(ctx.state).toBe("suspended");
  });

  it("reports state changes to listeners", async () => {
    const { engine } = setup();
    const seen: string[] = [];
    const off = engine.onChange((s) => seen.push(s.power));
    await engine.powerOn();
    off();
    await engine.powerOff();
    expect(seen).toEqual(["warming", "on"]);
  });
});

describe("pinkNoise", () => {
  it("is repeatable, bounded and not silent", () => {
    const a = pinkNoise(8000);
    expect(pinkNoise(8000)).toEqual(a);
    expect(pinkNoise(8000, 7)).not.toEqual(a);
    const peak = a.reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    expect(peak).toBeGreaterThan(0.05);
    expect(peak).toBeLessThan(1);
  });
});

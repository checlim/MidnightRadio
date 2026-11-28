"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { RadioEngine, type EngineState, type Variant } from "../player/audio-engine";
import { CAPTURE_WIDTH } from "../player/crossfade";
import { playerKeyAction } from "../player/keyboard";
import { BAND_KHZ, StationListSchema, clamp01, describeTuning, frequencyAt, nearestStation, stationPositions, stepStation, type Station } from "../player/stations";
import { clock, cueIndexAt, parseVtt, scrollTopToReveal, searchCues, type Cue } from "../player/vtt";
import { Cabinet } from "./Cabinet";

/**
 * The player (Req 7.1–7.5). The cabinet is a picture; the controls laid over its knobs are real
 * HTML: a POWER toggle button, a tuning slider and a tone switch, so keyboards and screen readers
 * get proper widgets. Space and the arrow keys work while focus is anywhere in the player, except
 * in the transcript search box.
 */

type LoadState = { kind: "loading" } | { kind: "ready"; stations: Station[] } | { kind: "error"; message: string };

function browserEngine(): RadioEngine {
  return new RadioEngine({
    createContext: () => new (window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)() as never,
    createMedia: () => new Audio() as never,
  });
}

export function Radio() {
  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [position, setPosition] = useState(0.1);
  const [engineState, setEngineState] = useState<EngineState>({ power: "off", wantsPlay: true, blocked: false, variant: "clean", stationId: null });
  const [cues, setCues] = useState<Cue[]>([]);
  const [cueIndex, setCueIndex] = useState(-1);
  const [announce, setAnnounce] = useState(false);
  const [query, setQuery] = useState("");
  const engine = useRef<RadioEngine | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);

  // Stations: fetched and validated, never trusted as-is.
  useEffect(() => {
    let live = true;
    fetch("/broadcast/stations.json", { cache: "no-cache" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`stations: HTTP ${r.status}`))))
      .then((json: unknown) => {
        const parsed = StationListSchema.safeParse(json);
        if (!live) return;
        if (parsed.success) {
          setLoad({ kind: "ready", stations: parsed.data.stations });
          // Start the needle on the first station, wherever the dial places it (a lone station sits mid-dial).
          const first = stationPositions(parsed.data.stations.length)[0];
          if (first !== undefined) setPosition(first);
        }
        else setLoad({ kind: "error", message: "The station list could not be read." });
      })
      .catch(() => live && setLoad({ kind: "error", message: "The station list could not be loaded." }));
    return () => {
      live = false;
    };
  }, []);

  const stations = load.kind === "ready" ? load.stations : [];
  const positions = useMemo(() => stationPositions(stations.length), [stations.length]);
  const tuning = nearestStation(positions, position);
  const on = engineState.power !== "off";
  // What the needle is near; nothing is "received" while the set is off.
  const near = on && tuning.index !== -1 && tuning.distance <= CAPTURE_WIDTH ? stations[tuning.index]! : null;
  const readyStation = near?.status === "ready" ? near : null;

  const getEngine = useCallback(() => {
    if (!engine.current) {
      engine.current = browserEngine();
      engine.current.onChange(setEngineState);
    }
    return engine.current;
  }, []);

  // Tell the engine where the needle is.
  useEffect(() => {
    if (!engine.current) return;
    engine.current.tune(tuning.distance, readyStation ? { id: readyStation.id, cleanUrl: readyStation.cleanUrl, amUrl: readyStation.amUrl } : null);
  }, [tuning.distance, readyStation, engineState.power]);

  // Transcript of the tuned station.
  const vttUrl = readyStation?.vttUrl;
  useEffect(() => {
    setCues([]);
    setCueIndex(-1);
    if (!vttUrl) return;
    let live = true;
    fetch(vttUrl)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error("transcript"))))
      .then((t) => live && setCues(parseVtt(t)))
      .catch(() => live && setCues([]));
    return () => {
      live = false;
    };
  }, [vttUrl]);

  // Follow playback: the current line, for the now-playing card and the transcript.
  useEffect(() => {
    if (engineState.power !== "on" || cues.length === 0) return;
    const id = window.setInterval(() => {
      const el = engine.current?.currentMedia();
      if (el) setCueIndex(cueIndexAt(cues, el.currentTime * 1000));
    }, 200);
    return () => window.clearInterval(id);
  }, [cues, engineState.power, engineState.variant]);

  useEffect(() => {
    if (cueIndex < 0) return;
    // Scroll the transcript list only: scrollIntoView would also scroll the page to follow each line.
    const list = listRef.current;
    const item = list?.querySelector<HTMLElement>(`[data-cue="${cueIndex}"]`);
    if (!list || !item) return;
    const top = item.getBoundingClientRect().top - list.getBoundingClientRect().top + list.scrollTop;
    const next = scrollTopToReveal({ scrollTop: list.scrollTop, height: list.clientHeight }, { top, height: item.offsetHeight });
    if (next !== list.scrollTop) list.scrollTop = next;
  }, [cueIndex]);

  const togglePower = () => {
    const e = getEngine();
    if (e.getState().power === "off") void e.powerOn();
    else void e.powerOff();
  };
  const toggleTone = () => {
    const e = getEngine();
    void e.setVariant(e.getState().variant === "clean" ? "am" : "clean");
  };
  const step = (dir: 1 | -1) => setPosition((p) => stepStation(positions, p, dir));

  const onKeyDown = (ev: KeyboardEvent<HTMLDivElement>) => {
    const t = ev.target as HTMLElement;
    const action = playerKeyAction({ key: ev.key, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey, altKey: ev.altKey, target: { tagName: t.tagName, isContentEditable: t.isContentEditable, role: t.getAttribute("role"), inPlayer: true } });
    if (!action) {
      if (t.getAttribute("role") === "slider" && (ev.key === "Home" || ev.key === "End")) {
        ev.preventDefault();
        setPosition(ev.key === "Home" ? 0 : 1);
      }
      return;
    }
    ev.preventDefault();
    if (action === "toggle") void engine.current?.togglePlay();
    else step(action === "next" ? 1 : -1);
  };

  // Dragging on the dial window (or the tuning knob) moves the needle.
  const dragFrom = useRef<{ el: HTMLElement } | null>(null);
  const moveTo = (ev: PointerEvent<HTMLElement>) => {
    const dial = rootRef.current?.querySelector<HTMLElement>(".dial-hit");
    if (!dial) return;
    const r = dial.getBoundingClientRect();
    // The scale on the dial is inset from the window's edges (24 of 460 units each side).
    const inset = (24 / 460) * r.width;
    setPosition(clamp01((ev.clientX - r.left - inset) / (r.width - 2 * inset)));
  };
  const pointerDown = (ev: PointerEvent<HTMLElement>) => {
    dragFrom.current = { el: ev.currentTarget };
    ev.currentTarget.setPointerCapture(ev.pointerId);
    moveTo(ev);
  };

  const current = cueIndex >= 0 ? cues[cueIndex] : undefined;
  const matches = useMemo(() => new Set(searchCues(cues, query)), [cues, query]);
  const valueText = describeTuning(stations, positions, position, CAPTURE_WIDTH);
  const variantLabel: Record<Variant, string> = { clean: "Clean", am: "Vintage AM" };

  return (
    <div
      className="radio-layout"
      ref={rootRef}
      onKeyDown={onKeyDown}
      data-power={engineState.power}
      data-station={engineState.stationId ?? ""}
      data-variant={engineState.variant}
      data-wants-play={String(engineState.wantsPlay)}
      data-blocked={String(engineState.blocked)}
    >
      <section className="cabinet" aria-label="Valve radio">
        <Cabinet position={position} power={engineState.power} variant={engineState.variant} markers={stations.map((s, i) => ({ position: positions[i]!, warming: s.status === "warming", label: `${s.book}, episode ${s.episodeNumber}` }))} />
        <button type="button" className="control control-power" aria-pressed={engineState.power !== "off"} onClick={togglePower}>
          Power
        </button>
        <div
          className="control control-tuning"
          role="slider"
          tabIndex={0}
          aria-label="Tuning"
          aria-valuemin={BAND_KHZ.low}
          aria-valuemax={BAND_KHZ.high}
          aria-valuenow={frequencyAt(position)}
          aria-valuetext={valueText}
          onPointerDown={pointerDown}
          onPointerMove={(ev) => dragFrom.current && moveTo(ev)}
          onPointerUp={() => (dragFrom.current = null)}
        />
        <div className="dial-hit" aria-hidden="true" onPointerDown={pointerDown} onPointerMove={(ev) => dragFrom.current && moveTo(ev)} onPointerUp={() => (dragFrom.current = null)} />
        <button type="button" className="control control-tone" role="switch" aria-checked={engineState.variant === "am"} aria-label="Vintage AM sound" onClick={toggleTone}>
          Tone
        </button>
        <span className="engraving" style={{ left: "25.6%" }} aria-hidden="true">
          Power
        </span>
        <span className="engraving" style={{ left: "50%" }} aria-hidden="true">
          Tuning
        </span>
        <span className="engraving" style={{ left: "74.4%" }} aria-hidden="true">
          {variantLabel[engineState.variant]}
        </span>
        {engineState.blocked && (
          <button type="button" className="retry" onClick={() => void engine.current?.retry()}>
            The broadcast did not start. Try again
          </button>
        )}
      </section>

      <aside className="guide" aria-label="Programme guide">
        <div className="card now-playing">
          <h2>Now playing</h2>
          {load.kind === "loading" && <p className="muted">Finding stations…</p>}
          {load.kind === "error" && <p role="alert">{load.message}</p>}
          {load.kind === "ready" && engineState.power === "off" && <p className="muted">Switch on the set with the POWER knob, then turn the dial to a station.</p>}
          {load.kind === "ready" && engineState.power !== "off" && !near && <p className="muted">Static… {frequencyAt(position)} kc. Turn the dial to find a station.</p>}
          {near && (
            <>
              <p className="station">
                {near.book} — Episode {near.episodeNumber}
              </p>
              <p className="muted">
                {near.title} · {near.author}
              </p>
              {near.status === "warming" ? (
                <div className="warming">
                  <span className="filament" aria-hidden="true" />
                  <div style={{ flex: 1 }}>
                    <p style={{ margin: 0 }}>Warming up: {near.rendered} of {near.total} lines rendered</p>
                    <progress max={near.total} value={near.rendered} aria-label="Lines rendered" />
                  </div>
                </div>
              ) : (
                <>
                  <p className="speaker">{current?.speaker ?? "\u00a0"}</p>
                  <p className="line">{current ? current.text : "\u00a0"}</p>
                  {/* Paused is shown whether or not a line is on screen, with how to resume. */}
                  <p className="muted pause-hint">{engineState.power === "on" && !engineState.wantsPlay ? "Paused. Press Space to listen." : "\u00a0"}</p>
                </>
              )}
            </>
          )}
          <p className="sr-only" aria-live="polite">
            {announce && current ? `${current.speaker ?? ""}: ${current.text}` : ""}
          </p>
        </div>

        {readyStation && cues.length > 0 && (
          <div className="card">
            <h2>Transcript</h2>
            <div className="transcript-tools">
              <label>
                <span className="sr-only">Search the transcript</span>
                <input type="search" placeholder="Search the transcript" value={query} onChange={(e) => setQuery(e.target.value)} />
              </label>
              <label>
                <input type="checkbox" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} /> Announce lines for screen readers
              </label>
              {query.trim() && (
                <span role="status">
                  {matches.size} {matches.size === 1 ? "match" : "matches"}
                </span>
              )}
            </div>
            <ol className="transcript" ref={listRef}>
              {cues.map((c, i) => (
                <li key={i} data-cue={i} aria-current={i === cueIndex ? "true" : undefined} className={matches.has(i) ? "match" : undefined}>
                  <button type="button" onClick={() => engine.current?.seek(c.startMs)}>
                    <time>{clock(c.startMs)}</time>
                    <span>
                      {c.speaker && <span className="who">{c.speaker}</span>}
                      {c.text}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          </div>
        )}
      </aside>
    </div>
  );
}


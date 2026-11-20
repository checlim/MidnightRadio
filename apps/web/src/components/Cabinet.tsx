import type { Variant } from "../player/audio-engine";
import { BAND_KHZ } from "../player/stations";

/**
 * The cathedral-style valve radio, drawn in SVG (800 × 560). Decorative: every control is a real
 * HTML element laid over its knob (see Radio), so it is hidden from assistive technology.
 */

export interface CabinetProps {
  /** Needle position 0–1. */
  position: number;
  power: "off" | "warming" | "on";
  variant: Variant;
  /** Dial positions of the stations, and whether each is still warming up. */
  markers: { position: number; warming: boolean; label: string }[];
}

const DIAL = { x: 180, y: 326, w: 440, h: 62 };
const dialX = (p: number) => DIAL.x + 24 + (DIAL.w - 48) * p;

function Knob({ cx, cy, r, angle, label }: { cx: number; cy: number; r: number; angle: number; label: string }) {
  return (
    <g>
      <circle cx={cx} cy={cy + 4} r={r + 3} fill="#1c0a03" opacity="0.6" />
      <circle cx={cx} cy={cy} r={r} fill="url(#brass-knob)" stroke="#5a3a10" strokeWidth="2" />
      <g className="knob-rot" style={{ transform: `rotate(${angle}deg)`, transformOrigin: `${cx}px ${cy}px`, transition: "transform 160ms ease-out" }}>
        {Array.from({ length: 24 }, (_, i) => {
          const a = (i * Math.PI) / 12;
          return <line key={i} x1={cx + Math.cos(a) * (r - 6)} y1={cy + Math.sin(a) * (r - 6)} x2={cx + Math.cos(a) * (r - 1)} y2={cy + Math.sin(a) * (r - 1)} stroke="#7a5418" strokeWidth="1.4" />;
        })}
        <circle cx={cx} cy={cy} r={r * 0.62} fill="url(#brass-cap)" stroke="#8a6020" />
        <line x1={cx} y1={cy - r * 0.55} x2={cx} y2={cy - r * 0.2} stroke="#3a2306" strokeWidth="3" strokeLinecap="round" />
      </g>
      <title>{label}</title>
    </g>
  );
}

export function Cabinet({ position, power, variant, markers }: CabinetProps) {
  const lit = power !== "off";
  const glow = power === "on" ? 1 : power === "warming" ? 0.55 : 0;
  const ticks = Array.from({ length: 54 }, (_, i) => i / 53);
  const labels = [550, 700, 900, 1100, 1300, 1600];
  return (
    <svg viewBox="0 0 800 560" role="presentation" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="walnut" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7a3618" />
          <stop offset="0.35" stopColor="#5a2410" />
          <stop offset="0.6" stopColor="#843d1b" />
          <stop offset="1" stopColor="#3a1608" />
        </linearGradient>
        <radialGradient id="walnut-sheen" cx="0.3" cy="0.15" r="0.8">
          <stop offset="0" stopColor="#ffcf9a" stopOpacity="0.35" />
          <stop offset="0.5" stopColor="#ffcf9a" stopOpacity="0" />
        </radialGradient>
        <filter id="grain" x="0" y="0" width="1" height="1">
          <feTurbulence type="fractalNoise" baseFrequency="0.006 0.09" numOctaves="3" seed="7" />
          <feColorMatrix values="0 0 0 0 0.25  0 0 0 0 0.1  0 0 0 0 0.03  0 0 0 0.35 0" />
          <feComposite in2="SourceGraphic" operator="in" />
        </filter>
        <linearGradient id="brass" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#6e4a17" />
          <stop offset="0.45" stopColor="#f0c870" />
          <stop offset="0.6" stopColor="#c8973f" />
          <stop offset="1" stopColor="#5e3c10" />
        </linearGradient>
        <radialGradient id="brass-knob" cx="0.35" cy="0.3" r="0.8">
          <stop offset="0" stopColor="#ffe2a0" />
          <stop offset="0.45" stopColor="#c8973f" />
          <stop offset="1" stopColor="#5a3a10" />
        </radialGradient>
        <radialGradient id="brass-cap" cx="0.4" cy="0.35" r="0.7">
          <stop offset="0" stopColor="#fff0c8" />
          <stop offset="0.6" stopColor="#d6a650" />
          <stop offset="1" stopColor="#8a6020" />
        </radialGradient>
        <pattern id="cloth" width="6" height="6" patternUnits="userSpaceOnUse">
          <rect width="6" height="6" fill="#4a3018" />
          <path d="M0 1.5h6M0 4.5h6" stroke="#8c6a3c" strokeWidth="1.1" />
          <path d="M1.5 0v6M4.5 0v6" stroke="#7a5830" strokeWidth="0.9" />
        </pattern>
        <radialGradient id="cloth-glow" cx="0.5" cy="0.75" r="0.7">
          <stop offset="0" stopColor="#ffb347" stopOpacity="0.85" />
          <stop offset="0.6" stopColor="#ff9a2e" stopOpacity="0.25" />
          <stop offset="1" stopColor="#ff9a2e" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="dial-glass" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffd98a" />
          <stop offset="0.5" stopColor="#ffb347" />
          <stop offset="1" stopColor="#c86a12" />
        </linearGradient>
        <linearGradient id="dial-dark" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#3a2a16" />
          <stop offset="1" stopColor="#1c1208" />
        </linearGradient>
        <filter id="soft-glow" x="-30%" y="-60%" width="160%" height="220%">
          <feGaussianBlur stdDeviation="10" />
        </filter>
        <clipPath id="grille-clip">
          <path d="M150 300 L150 200 Q150 90 400 70 Q650 90 650 200 L650 300 Z" />
        </clipPath>
      </defs>

      {/* Feet and plinth */}
      <rect x="110" y="520" width="120" height="22" rx="8" fill="url(#brass)" />
      <rect x="570" y="520" width="120" height="22" rx="8" fill="url(#brass)" />
      {/* Cabinet: a cathedral dome on a deep base */}
      <path d="M70 520 L70 250 Q70 40 400 26 Q730 40 730 250 L730 520 Q730 534 716 534 L84 534 Q70 534 70 520 Z" fill="url(#walnut)" />
      <path d="M70 520 L70 250 Q70 40 400 26 Q730 40 730 250 L730 520 Q730 534 716 534 L84 534 Q70 534 70 520 Z" fill="url(#walnut)" filter="url(#grain)" />
      <path d="M70 520 L70 250 Q70 40 400 26 Q730 40 730 250 L730 520 Q730 534 716 534 L84 534 Q70 534 70 520 Z" fill="url(#walnut-sheen)" />
      {/* Brass bands following the dome */}
      <path d="M96 505 L96 252 Q96 64 400 52 Q704 64 704 252 L704 505" fill="none" stroke="url(#brass)" strokeWidth="5" />
      <path d="M118 505 L118 256 Q118 84 400 74 Q682 84 682 256 L682 505" fill="none" stroke="#3a1608" strokeWidth="2" opacity="0.7" />

      {/* Speaker grille: cloth, backlit when the set is on */}
      <g clipPath="url(#grille-clip)">
        <rect x="140" y="60" width="520" height="250" fill="url(#cloth)" />
        <rect x="140" y="60" width="520" height="250" fill="url(#cloth-glow)" opacity={glow} style={{ transition: "opacity 1.2s ease" }} />
      </g>
      <path d="M150 300 L150 200 Q150 90 400 70 Q650 90 650 200 L650 300" fill="none" stroke="url(#brass)" strokeWidth="6" />
      {/* Brass fins over the grille */}
      <g fill="none" stroke="url(#brass)" strokeLinecap="round">
        <path d="M400 70 L400 300" strokeWidth="9" />
        <path d="M372 74 L372 300" strokeWidth="5" />
        <path d="M428 74 L428 300" strokeWidth="5" />
        <path d="M352 80 Q250 150 230 300" strokeWidth="6" />
        <path d="M448 80 Q550 150 570 300" strokeWidth="6" />
      </g>
      <rect x="150" y="296" width="500" height="12" rx="3" fill="url(#brass)" />

      {/* Dial window */}
      <rect x={DIAL.x - 10} y={DIAL.y - 10} width={DIAL.w + 20} height={DIAL.h + 20} rx="18" fill="url(#brass)" />
      <rect x={DIAL.x} y={DIAL.y} width={DIAL.w} height={DIAL.h} rx="12" fill="url(#dial-dark)" />
      <rect x={DIAL.x} y={DIAL.y} width={DIAL.w} height={DIAL.h} rx="12" fill="url(#dial-glass)" opacity={glow} style={{ transition: "opacity 1.2s ease" }} />
      {lit && <rect x={DIAL.x + 20} y={DIAL.y + 6} width={DIAL.w - 40} height={DIAL.h - 12} rx="12" fill="#ffb347" opacity={0.35 * glow} filter="url(#soft-glow)" />}
      <g stroke="#3a1a04" opacity={lit ? 0.85 : 0.45}>
        {ticks.map((t, i) => (
          <line key={i} x1={dialX(t)} y1={DIAL.y + 8} x2={dialX(t)} y2={DIAL.y + (i % 5 === 0 ? 24 : 16)} strokeWidth={i % 5 === 0 ? 1.6 : 0.9} />
        ))}
      </g>
      <g fontFamily="Georgia, serif" fontSize="11" fill="#3a1a04" textAnchor="middle" opacity={lit ? 0.9 : 0.45}>
        {labels.map((k) => (
          <text key={k} x={dialX((k - BAND_KHZ.low) / (BAND_KHZ.high - BAND_KHZ.low))} y={DIAL.y + 38}>
            {k / 10}
          </text>
        ))}
      </g>
      {/* Stations: brass pips on the dial; a warming station flickers */}
      {markers.map((m, i) => (
        <g key={i}>
          <circle cx={dialX(m.position)} cy={DIAL.y + DIAL.h - 12} r="4.5" fill={m.warming ? "#ff7a1a" : "#2a1204"} stroke="#f0c870" strokeWidth="1">
            {m.warming && lit && <animate attributeName="opacity" values="0.4;1;0.4" dur="1.6s" repeatCount="indefinite" />}
          </circle>
          <title>{m.label}</title>
        </g>
      ))}
      {/* Needle */}
      <g className="needle" style={{ transform: `translateX(${dialX(position) - dialX(0)}px)`, transition: "transform 90ms linear" }}>
        <line x1={dialX(0)} y1={DIAL.y + 2} x2={dialX(0)} y2={DIAL.y + DIAL.h - 2} stroke="#8b0000" strokeWidth="2.2" />
      </g>
      <rect x={DIAL.x} y={DIAL.y} width={DIAL.w} height={DIAL.h / 2} rx="12" fill="#ffffff" opacity="0.08" />

      {/* Knobs: power, tuning, tone */}
      <Knob cx={205} cy={452} r={34} angle={power === "off" ? -40 : 40} label="Power" />
      <Knob cx={400} cy={452} r={52} angle={position * 300 - 150} label="Tuning" />
      <Knob cx={595} cy={452} r={34} angle={variant === "am" ? -40 : 40} label="Tone" />
      {/* Pilot lamp */}
      <circle cx="300" cy="452" r="7" fill={lit ? "#ffb347" : "#3a2410"} stroke="#c8973f" strokeWidth="2" />
      {lit && <circle cx="300" cy="452" r="14" fill="#ffb347" opacity="0.4" filter="url(#soft-glow)" />}
    </svg>
  );
}

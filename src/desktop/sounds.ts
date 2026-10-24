// Tiny synthesized UI sounds (WebAudio, no files). One AudioContext, created on the first sound,
// suspended after 10 s of silence and closed after a minute, so an idle desktop holds no audio
// stream. Off by default (settings.animation.sounds); never while a fullscreen app is in front.

export type SoundName = "open" | "close" | "drop" | "merge" | "delete" | "page" | "jiggleOn" | "jiggleOff" | "error";

type Config = { enabled: boolean; volume: number; muted: boolean };

let config: Config = { enabled: false, volume: 0.5, muted: false };

/** The desktop keeps this in step with its settings and quiet state (effects.ts). */
export function setSoundConfig(c: Config) {
  config = c;
  if (!c.enabled || c.muted) shutdown();
}

let ctx: AudioContext | null = null;
let noiseBuf: AudioBuffer | null = null;
let suspendTimer: number | undefined;
let closeTimer: number | undefined;
const lastPlayed = new Map<SoundName, number>();

function context(): AudioContext | null {
  if (typeof AudioContext === "undefined") return null;
  if (!ctx || ctx.state === "closed") {
    try {
      ctx = new AudioContext({ latencyHint: "interactive" });
    } catch {
      return null;
    }
    noiseBuf = null;
  }
  if (ctx.state === "suspended") void ctx.resume().catch(() => {});
  window.clearTimeout(suspendTimer);
  window.clearTimeout(closeTimer);
  suspendTimer = window.setTimeout(() => void ctx?.suspend().catch(() => {}), 10_000);
  closeTimer = window.setTimeout(shutdown, 60_000);
  return ctx;
}

function shutdown() {
  window.clearTimeout(suspendTimer);
  window.clearTimeout(closeTimer);
  const c = ctx;
  ctx = null;
  noiseBuf = null;
  if (c && c.state !== "closed") void c.close().catch(() => {});
}

function noise(c: AudioContext): AudioBuffer {
  if (!noiseBuf) {
    noiseBuf = c.createBuffer(1, Math.round(c.sampleRate * 0.4), c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

type Tone = { type?: OscillatorType; f0: number; f1?: number; at?: number; dur: number; gain: number; attack?: number };

function tone(c: AudioContext, out: AudioNode, o: Tone) {
  const t0 = c.currentTime + (o.at ?? 0);
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = o.type ?? "sine";
  osc.frequency.setValueAtTime(o.f0, t0);
  if (o.f1) osc.frequency.exponentialRampToValueAtTime(o.f1, t0 + o.dur * 0.7);
  const attack = o.attack ?? 0.008;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.gain, t0 + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  osc.connect(g).connect(out);
  osc.start(t0);
  osc.stop(t0 + o.dur + 0.02);
}

type Hiss = { at?: number; dur: number; gain: number; f0: number; f1?: number; q?: number; filter?: BiquadFilterType };

function hiss(c: AudioContext, out: AudioNode, o: Hiss) {
  const t0 = c.currentTime + (o.at ?? 0);
  const src = c.createBufferSource();
  src.buffer = noise(c);
  const f = c.createBiquadFilter();
  f.type = o.filter ?? "bandpass";
  f.Q.value = o.q ?? 1.2;
  f.frequency.setValueAtTime(o.f0, t0);
  if (o.f1) f.frequency.exponentialRampToValueAtTime(o.f1, t0 + o.dur);
  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.gain, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + o.dur);
  src.connect(f).connect(g).connect(out);
  src.start(t0);
  src.stop(t0 + o.dur + 0.02);
}

const RECIPES: Record<SoundName, (c: AudioContext, out: AudioNode) => void> = {
  open: (c, o) => {
    tone(c, o, { f0: 520, f1: 880, dur: 0.16, gain: 0.32 });
    tone(c, o, { type: "triangle", f0: 1040, f1: 1560, dur: 0.1, gain: 0.06 });
  },
  close: (c, o) => {
    tone(c, o, { f0: 760, f1: 420, dur: 0.14, gain: 0.26 });
  },
  drop: (c, o) => {
    tone(c, o, { type: "triangle", f0: 310, f1: 170, dur: 0.12, gain: 0.32, attack: 0.004 });
    hiss(c, o, { dur: 0.04, gain: 0.05, f0: 2400, q: 0.8 });
  },
  merge: (c, o) => {
    tone(c, o, { f0: 660, dur: 0.14, gain: 0.24 });
    tone(c, o, { f0: 990, at: 0.07, dur: 0.2, gain: 0.22 });
  },
  delete: (c, o) => {
    hiss(c, o, { dur: 0.24, gain: 0.22, f0: 2600, f1: 380, q: 0.9 });
    tone(c, o, { f0: 240, f1: 120, dur: 0.18, gain: 0.12 });
  },
  page: (c, o) => {
    hiss(c, o, { dur: 0.05, gain: 0.08, f0: 3200, filter: "highpass", q: 0.7 });
    tone(c, o, { f0: 1250, f1: 1100, dur: 0.05, gain: 0.07, attack: 0.003 });
  },
  jiggleOn: (c, o) => {
    tone(c, o, { f0: 600, dur: 0.09, gain: 0.2 });
    tone(c, o, { f0: 900, at: 0.08, dur: 0.12, gain: 0.2 });
  },
  jiggleOff: (c, o) => {
    tone(c, o, { f0: 900, dur: 0.09, gain: 0.2 });
    tone(c, o, { f0: 600, at: 0.08, dur: 0.12, gain: 0.2 });
  },
  error: (c, o) => {
    tone(c, o, { type: "square", f0: 190, dur: 0.07, gain: 0.07, attack: 0.004 });
    tone(c, o, { type: "square", f0: 160, at: 0.1, dur: 0.09, gain: 0.07, attack: 0.004 });
  },
};

function synth(name: SoundName, volume: number) {
  const now = performance.now();
  // the same sound twice within 40 ms (wheel paging, several drops) is played once
  if (now - (lastPlayed.get(name) ?? -1e9) < 40) return;
  lastPlayed.set(name, now);
  const c = context();
  if (!c) return;
  const master = c.createGain();
  master.gain.value = Math.min(1, Math.max(0, volume)) * 0.9;
  master.connect(c.destination);
  RECIPES[name](c, master);
}

/** A UI sound, when sounds are on (settings) and no fullscreen app is in front. */
export function playSound(name: SoundName) {
  if (!config.enabled || config.muted || config.volume <= 0) return;
  synth(name, config.volume);
}

/** The settings window's "Dinle": plays regardless of the on / off switch. */
export function previewSound(name: SoundName, volume: number) {
  if (volume > 0) synth(name, volume);
}

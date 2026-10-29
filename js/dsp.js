/**
 * dsp.js — small building blocks shared by every synth: lookup tables,
 * filters, a resonant pipe, noise and soft clipping. Plain math, so it runs in
 * the AudioWorklet, the ScriptProcessor fallback and Node tests alike.
 */

export const TWO_PI = Math.PI * 2;
export const TABLE = 2048;

export const SINE = new Float32Array(TABLE + 1);
for (let i = 0; i <= TABLE; i++) SINE[i] = Math.sin((TWO_PI * i) / TABLE);

/** Linear-interpolated lookup for x in [0, 1). */
export function lookup(table, x) {
  const p = x * TABLE;
  const i = p | 0;
  return table[i] + (table[i + 1] - table[i]) * (p - i);
}

/** Sine of a phase given in cycles (any real number). */
export function sinCycles(ph) {
  return lookup(SINE, ph - Math.floor(ph));
}

/** Soft saturation (Padé approximation of tanh, clamped). */
export function soft(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

export const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Per-sample one-pole coefficient for a time constant of `seconds`. */
export const coef = (sr, seconds) => 1 - Math.exp(-1 / (sr * seconds));

/** RBJ biquad, transposed direct form II. */
export class Biquad {
  constructor() {
    this.b0 = 1;
    this.b1 = 0;
    this.b2 = 0;
    this.a1 = 0;
    this.a2 = 0;
    this.z1 = 0;
    this.z2 = 0;
  }

  bandpass(sr, f, q) {
    const w = (TWO_PI * Math.min(f, sr * 0.45)) / sr;
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = alpha / a0;
    this.b1 = 0;
    this.b2 = -alpha / a0;
    this.a1 = (-2 * Math.cos(w)) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  lowpass(sr, f, q = 0.707) {
    const w = (TWO_PI * Math.min(f, sr * 0.45)) / sr;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 - cw) / 2 / a0;
    this.b1 = (1 - cw) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  highpass(sr, f, q = 0.707) {
    const w = (TWO_PI * Math.min(f, sr * 0.45)) / sr;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (1 + cw) / 2 / a0;
    this.b1 = -(1 + cw) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cw) / a0;
    this.a2 = (1 - alpha) / a0;
    return this;
  }

  /** RBJ low shelf (slope 1). */
  lowshelf(sr, f, gainDb) {
    const A = Math.pow(10, gainDb / 40);
    const w = (TWO_PI * f) / sr;
    const cw = Math.cos(w);
    const alpha = (Math.sin(w) / 2) * Math.SQRT2;
    const sa = 2 * Math.sqrt(A) * alpha;
    const a0 = A + 1 + (A - 1) * cw + sa;
    this.b0 = (A * (A + 1 - (A - 1) * cw + sa)) / a0;
    this.b1 = (2 * A * (A - 1 - (A + 1) * cw)) / a0;
    this.b2 = (A * (A + 1 - (A - 1) * cw - sa)) / a0;
    this.a1 = (-2 * (A - 1 + (A + 1) * cw)) / a0;
    this.a2 = (A + 1 + (A - 1) * cw - sa) / a0;
    return this;
  }

  run(x) {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  reset() {
    this.z1 = this.z2 = 0;
  }
}

/** Feedback comb with a damping low-pass in the loop: a resonant pipe (or a room echo). */
export class Pipe {
  constructor(sr, seconds, feedback, damping) {
    this.size = Math.max(2, Math.round(sr * seconds));
    this.buf = new Float32Array(this.size);
    this.i = 0;
    this.fb = feedback;
    this.lpCoef = 1 - Math.exp((-TWO_PI * damping) / sr);
    this.lp = 0;
  }

  run(x) {
    const delayed = this.buf[this.i];
    this.lp += (delayed - this.lp) * this.lpCoef;
    const y = x + this.fb * this.lp;
    this.buf[this.i] = y;
    if (++this.i >= this.size) this.i = 0;
    return y;
  }

  reset() {
    this.buf.fill(0);
    this.lp = 0;
  }
}

/** xorshift32 noise in [-1, 1). */
export class Noise {
  constructor(seed = 0x9e3779b9) {
    this.s = seed >>> 0 || 1;
  }

  next() {
    let x = this.s;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.s = x >>> 0;
    return this.s / 2147483648 - 1;
  }

  unit() {
    return (this.next() + 1) * 0.5;
  }
}

/**
 * A decaying sine: a bell partial, a thump, a resonant knock. `hit` adds
 * energy; `run` returns the next sample.
 */
export class Ring {
  constructor(sr, freq, seconds) {
    this.sr = sr;
    this.set(freq, seconds);
    this.phase = 0;
    this.env = 0;
  }

  set(freq, seconds) {
    this.inc = freq / this.sr;
    this.decay = Math.exp(-1 / (this.sr * seconds));
  }

  hit(amp) {
    this.env = Math.max(this.env, amp);
  }

  run() {
    if (this.env < 1e-5) return 0;
    this.phase += this.inc;
    if (this.phase >= 1) this.phase -= 1;
    const y = sinCycles(this.phase) * this.env;
    this.env *= this.decay;
    return y;
  }
}

/** Band-limited sawtooth (polyBLEP), for voices and sci-fi oscillators. */
export class Saw {
  constructor() {
    this.phase = 0;
  }

  run(inc) {
    this.phase += inc;
    if (this.phase >= 1) this.phase -= 1;
    const t = this.phase;
    let y = 2 * t - 1;
    if (t < inc) {
      const x = t / inc;
      y -= x + x - x * x - 1;
    } else if (t > 1 - inc) {
      const x = (t - 1) / inc;
      y -= x * x + x + x + 1;
    }
    return y;
  }
}

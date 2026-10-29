/**
 * engine-worklet.js — procedural flat-six engine sound (no samples).
 *
 * Runs inside an AudioWorklet (registered as 'flat-six'); the same
 * FlatSixSynth class also powers the ScriptProcessor fallback and the
 * offline renderer used in tests.
 *
 * How the sound is built, per sample:
 *
 *  1. Crankshaft. A 4-stroke cycle is 720°. Six cylinders fire every 120° in
 *     the boxer order 1-6-2-4-3-5, alternating between the left bank (1-3)
 *     and the right bank (4-6).
 *  2. Exhaust pulses. Each firing releases a pressure pulse (a sharp
 *     blowdown peak followed by a scavenging dip). Its size follows the
 *     load; each cylinder is slightly different and every event jitters a
 *     little, which gives the engine its organic, lumpy character.
 *  3. Pipes. Each bank's pulses ring through its own header (a delay line
 *     with feedback, i.e. a resonant pipe). The two banks have different
 *     lengths, which brings out the half-orders typical of a flat-six.
 *     A short tailpipe comb adds the metallic edge.
 *  4. Body. A bank of fixed resonances (body boom, muffler, rasp) colours
 *     the sound. They don't move with RPM, so different harmonics light up
 *     as the revs climb, as in a real car.
 *  5. Intake. Individual-throttle-body howl: intake pulses through plenum
 *     and runner resonances, plus air rush that grows with throttle.
 *  6. Mechanics, sub-bass, starter motor, and pops/bangs on the overrun.
 *  7. Tone, drive and a soft limiter.
 */

const TWO_PI = Math.PI * 2;
const FIRING_ORDER = [0, 5, 1, 3, 2, 4]; // cylinders 1-6-2-4-3-5 (0-based)
const BANK_OF = [0, 0, 0, 1, 1, 1]; // 1-3 left bank, 4-6 right bank
const CYL_GAIN = [1.0, 0.92, 1.06, 0.96, 1.04, 0.9]; // static imbalance
const TABLE = 2048;

/**
 * Voicing: the knobs that give the engine its character. Tuned deep and
 * hollow, GT3-style: the two banks' pulses reach the tailpipes slightly out
 * of step and with different strength, which brings out the boxer's 1.5
 * engine order an octave below the firing note. It survives mono playback,
 * so the car's subwoofer gets it too.
 */
const VOICE = {
  blowdownMs: 9.5, // exhaust pulse length: longer is rounder and deeper
  scavenge: 0.18, // depth of the dip after each pulse (more = thinner, less bass)
  bankLag: 0.24, // right bank arrives this many firing intervals late...
  bankLagHigh: 0.12, // ...plus this much more at the redline
  bankGain: 0.78, // ...and this much weaker (left bank = 1)
  crack: 0.25, // combustion bite on top of each pulse
  flowNoise: 0.6, // turbulence riding on the pulses
  headers: [0.0058, 0.0069], // header pipe round trips (s): low resonances
  headerFeedback: -0.45,
  headerDamping: 2400, // Hz
  tails: [0.0021, 0.0024], // tailpipe combs (s)
  tailFeedback: 0.2,
  tailDamping: 4200, // Hz
  // Body / muffler resonances: [Hz, Q, gain].
  body: [
    [82, 1.0, 1.0],
    [178, 1.5, 0.78],
    [385, 2.2, 0.45],
    [900, 2.6, 0.2],
    [2100, 2.2, 0.08],
  ],
  dry: 0.45, // unresonated exhaust in the mix
  pan: 0.6, // bank stereo spread (0.5 = mono)
  intake: { plenum: 120, runner: 380, howl: 900, rush: 1200, level: 0.7 },
  sub: { order3: 0.22, order15: 0.2, order1: 0.05 }, // sine layer levels
  bassShelf: { freq: 150, gainDb: 5 },
  toneMin: 600, // Hz: closed exhaust, idle
  toneRange: 5600, // Hz added at full throttle and revs
};

// ---------------------------------------------------------------------------
// Lookup tables
// ---------------------------------------------------------------------------

const SINE = new Float32Array(TABLE + 1);
for (let i = 0; i <= TABLE; i++) SINE[i] = Math.sin((TWO_PI * i) / TABLE);

/** Exhaust pressure pulse (x in 0..1) and its sharp "crack" derivative. */
const PULSE = new Float32Array(TABLE + 1);
const CRACK = new Float32Array(TABLE + 1);
/** Intake suction pulse. */
const INTAKE = new Float32Array(TABLE + 1);
(() => {
  const peak = 0.1;
  const k = 2.0;
  let maxP = 0;
  let maxD = 0;
  const bump = new Float64Array(TABLE + 1);
  for (let i = 0; i <= TABLE; i++) {
    const x = i / TABLE;
    const g = Math.pow(x / peak, k) * Math.exp(k * (1 - x / peak));
    const taper = x < 0.8 ? 1 : 0.5 + 0.5 * Math.cos((Math.PI * (x - 0.8)) / 0.2);
    bump[i] = g * taper;
    const dip = VOICE.scavenge * Math.exp(-Math.pow((x - 0.48) / 0.13, 2)) * taper;
    PULSE[i] = bump[i] - dip;
    maxP = Math.max(maxP, Math.abs(PULSE[i]));
  }
  for (let i = 0; i <= TABLE; i++) {
    PULSE[i] /= maxP;
    const d = i > 0 && i < TABLE ? bump[i + 1] - bump[i - 1] : 0;
    CRACK[i] = d;
    maxD = Math.max(maxD, Math.abs(d));
  }
  for (let i = 0; i <= TABLE; i++) {
    CRACK[i] /= maxD;
    const x = i / TABLE;
    const s = Math.sin(Math.PI * Math.pow(x, 0.75));
    INTAKE[i] = s * s - 0.5;
  }
})();

/** Linear-interpolated lookup for x in [0, 1). */
function lookup(table, x) {
  const p = x * TABLE;
  const i = p | 0;
  return table[i] + (table[i + 1] - table[i]) * (p - i);
}

/** Sine of a phase given in cycles (any real number). */
function sinCycles(ph) {
  return lookup(SINE, ph - Math.floor(ph));
}

/** Soft saturation (Padé approximation of tanh, clamped). */
function soft(x) {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

// ---------------------------------------------------------------------------
// Small DSP building blocks
// ---------------------------------------------------------------------------

/** RBJ biquad, transposed direct form II. */
class Biquad {
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

/** Feedback comb with a damping low-pass in the loop: a resonant pipe. */
class Pipe {
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
class Noise {
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

// ---------------------------------------------------------------------------
// The synth
// ---------------------------------------------------------------------------

export class FlatSixSynth {
  constructor(sampleRate, seed = 1234567) {
    const sr = (this.sr = sampleRate);
    this.noise = new Noise(seed);

    // Targets set from the main thread, and their smoothed per-sample values.
    this.target = { rpm: 0, load: 0, overrun: 0, cut: 0, ignition: 0, starter: 0, crackle: 0.8, exhaust: 1, cold: 0 };
    this.rpm = 0;
    this.load = 0;
    this.overrun = 0;
    this.exhaust = 1;
    this.starter = 0;
    this.gate = 0; // overall on/off fade

    // Crank state.
    this.cycle = 0; // 0..1 over 720°
    this.slot = 0; // which of the 6 firing slots we are in
    this.bankEv = [this._event(), this._event()]; // current exhaust pulse per bank
    this.intakeAmp = 0;
    this.cylDrift = new Float32Array(6).fill(1);

    // Pipes: headers per bank (different lengths), then tailpipes per side.
    const V = VOICE;
    this.header = V.headers.map((d) => new Pipe(sr, d, V.headerFeedback, V.headerDamping));
    this.tail = V.tails.map((d) => new Pipe(sr, d, V.tailFeedback, V.tailDamping));

    // Fixed body/exhaust resonances (per channel).
    this.formantSpec = V.body;
    this.formants = [0, 1].map(() => this.formantSpec.map(([f, q]) => new Biquad().bandpass(sr, f, q)));
    this.tone = [new Biquad(), new Biquad()];
    this.bass = [0, 1].map(() => new Biquad().lowshelf(sr, V.bassShelf.freq, V.bassShelf.gainDb));
    this.dc = [new Biquad().highpass(sr, 24, 0.6), new Biquad().highpass(sr, 24, 0.6)];

    // Intake.
    this.plenum = new Biquad().bandpass(sr, V.intake.plenum, 2);
    this.runner = new Biquad().bandpass(sr, V.intake.runner, 3);
    this.howl = new Biquad().bandpass(sr, V.intake.howl, 2.8);
    this.airRush = new Biquad().bandpass(sr, V.intake.rush, 0.7);

    // Mechanical ticking and starter.
    this.tickEnv = 0;
    this.tickDecay = Math.exp(-1 / (sr * 0.0004));
    this.tickHp = 0;
    this.whinePhase = 0;
    // Cranking: low compression chug plus a quiet mechanical whirr.
    this.chugLp = new Biquad().lowpass(sr, 170, 0.8);
    this.starterBp = new Biquad().bandpass(sr, 340, 2.2);

    // Pops and bangs.
    this.popEnv = 0;
    this.popDecay = 0;
    this.popPan = 0.5;
    this.popBank = 0;
    this.thumpEnv = 0;
    this.thumpDecay = 0;
    this.thumpPhase = 0;
    this.thumpFreq = 70;
    this.lastCut = 0;
    this.stopThumped = true;
    this.popCooldown = 0;

    // Block-rate parameter update.
    this.blockCounter = 0;
    this.formantGain = new Float32Array(5);
    this.drive = 1;
    this.loudness = 0;

    /** Called with {type:'pop', amp} so the UI can flash exhaust flames. */
    this.onEvent = null;
  }

  _event() {
    return { age: 99, amp: 0, crack: 0, width: 1 };
  }

  /** Update targets: {rpm, load, overrun, cut, ignition, starter, crackle, exhaust}. */
  setParams(p) {
    for (const k in p) if (k in this.target && Number.isFinite(p[k])) this.target[k] = p[k];
  }

  /** Recompute slow-moving filter settings (every 32 samples). */
  _block() {
    const sr = this.sr;
    const rpmN = Math.min(1, this.rpm / 9000);
    const load = this.load;
    const open = this.exhaust;

    const cutoff = VOICE.toneMin + VOICE.toneRange * (0.3 + 0.7 * open) * (0.3 + 0.7 * load) * (0.35 + 0.65 * rpmN);
    this.tone[0].lowpass(sr, cutoff, 0.6);
    this.tone[1].lowpass(sr, cutoff, 0.6);

    const fg = this.formantGain;
    const spec = this.formantSpec;
    fg[0] = spec[0][2] * (1.2 - 0.4 * rpmN);
    fg[1] = spec[1][2] * (0.9 + 0.35 * rpmN); // keep the low-mid body at high revs
    fg[2] = spec[2][2] * (0.7 + 0.5 * open) * (1.1 - 0.4 * rpmN);
    fg[3] = spec[3][2] * (0.4 + 0.9 * load) * (0.6 + 0.4 * open);
    fg[4] = spec[4][2] * (0.2 + 1.1 * load * rpmN) * open;

    this.drive = 1.2 + 1.8 * load * (0.5 + 0.5 * rpmN);
    // Loudness follows revs and throttle: a quiet idle, a loud wide-open wail.
    const db = Math.min(0, -27.5 + 16.5 * Math.pow(rpmN, 0.7) + 7 * load);
    this.loudness = Math.pow(10, db / 20);

    // Each cylinder's strength drifts slowly (no two cycles are the same).
    for (let c = 0; c < 6; c++) {
      this.cylDrift[c] += (1 - this.cylDrift[c]) * 0.02 + this.noise.next() * 0.004;
    }
  }

  /** A new firing event in `slot` (0..5): set up that bank's pulse. */
  _fire(slot) {
    const t = this.target;
    const cyl = FIRING_ORDER[slot];
    const bank = BANK_OF[cyl];
    const ev = this.bankEv[bank];
    const n = this.noise;
    const rpmN = Math.min(1, this.rpm / 9000);
    const load = this.load;
    const combustion = t.ignition > 0.5 && !(t.cut > 0.5);

    let amp;
    if (combustion) {
      amp = (0.3 + 0.7 * Math.pow(load, 0.8)) * CYL_GAIN[cyl] * this.cylDrift[cyl];
      // Off throttle (or still cold) the mixture burns unevenly: burble and
      // the odd weak firing, which gives a cold start its lumpy idle.
      const burble = this.overrun * (1 - load);
      const cold = Math.min(1, t.cold) * (1 - rpmN);
      amp *= 1 + n.next() * (0.05 + 0.5 * burble + 0.16 * cold);
      if (cold > 0.2 && n.unit() < 0.05 * cold) amp *= 0.5;
      if (burble > 0.1 && n.unit() < 0.12 * burble) amp *= 0.15;
    } else {
      // Just air being pumped: a little louder while the starter cranks.
      amp = (t.starter > 0.5 ? 0.14 : 0.07) * CYL_GAIN[cyl];
    }
    // The right bank's pulses arrive a little later and weaker (unequal
    // paths to the tailpipes): that is what makes the deep 1.5-order note.
    const lag = bank === 1 ? VOICE.bankLag + VOICE.bankLagHigh * rpmN : 0;
    ev.amp = amp * (bank === 1 ? VOICE.bankGain : 1);
    ev.crack = combustion ? 0.2 + 1.0 * load : 0;
    // The blowdown takes about the same time whatever the revs, so at low RPM
    // the pulses are separate beats; at high RPM they merge into a wail.
    ev.width = Math.min(1.6, Math.max(0.42, ((VOICE.blowdownMs / 1000) * Math.max(this.rpm, 100)) / 20));
    // Timing jitter: more at idle, tiny at high revs.
    ev.age = -lag - n.unit() * (0.03 - 0.022 * rpmN);

    // Strength of this cylinder's intake stroke.
    this.intakeAmp = (0.25 + 0.75 * load) * (t.ignition > 0.5 ? 1 : 0.4);

    // Valve-train tick.
    this.tickEnv = 0.6 + 0.4 * n.unit();

    // Pops: unburnt fuel igniting in the hot exhaust.
    if (t.ignition > 0.5 && this.popCooldown <= 0) {
      const eventsPerSecond = Math.max(this.rpm, 300) / 20;
      let chance = 0;
      if (this.overrun > 0.02) chance = (t.crackle * this.overrun * 13) / eventsPerSecond;
      if (t.cut > 0.5 && this.rpm > 3500) chance += 0.12 * t.crackle;
      if (n.unit() < chance) this._pop(bank);
    }
  }

  _pop(bank) {
    const n = this.noise;
    const bang = n.unit() < 0.12;
    const amp = (0.35 + 0.65 * n.unit()) * (bang ? 1.6 : 1);
    const tau = bang ? 0.028 : 0.004 + 0.012 * n.unit();
    this.popEnv = Math.max(this.popEnv, amp);
    this.popDecay = Math.exp(-1 / (this.sr * tau));
    this.popBank = bank;
    this.popPan = bank === 0 ? 0.3 + 0.2 * n.unit() : 0.5 + 0.2 * n.unit();
    this.thumpEnv = Math.max(this.thumpEnv, amp * (bang ? 0.9 : 0.45));
    this.thumpDecay = Math.exp(-1 / (this.sr * (bang ? 0.06 : 0.025)));
    this.thumpFreq = 55 + 35 * n.unit();
    this.popCooldown = this.sr * 0.012;
    if (this.onEvent) this.onEvent({ type: 'pop', amp: Math.min(1, amp) });
  }

  /** Render `end - start` samples into the two channel arrays. */
  render(outL, outR, start = 0, end = outL.length) {
    const t = this.target;
    const sr = this.sr;
    const n = this.noise;

    // Per-sample smoothing coefficients.
    const kRpm = 1 - Math.exp(-1 / (sr * 0.012));
    const kLoad = 1 - Math.exp(-1 / (sr * 0.015));
    const kSlow = 1 - Math.exp(-1 / (sr * 0.2));
    const kOver = 1 - Math.exp(-1 / (sr * 0.03));
    const kGate = 1 - Math.exp(-1 / (sr * 0.02));
    const pumping = t.ignition > 0.5 || t.starter > 0.5 || t.rpm > 30;

    // Fully silent: skip the work and keep the state clean.
    if (!pumping && this.gate < 1e-4 && this.rpm < 1) {
      for (let i = start; i < end; i++) outL[i] = outR[i] = 0;
      return;
    }

    const hp = this.header;
    const tp = this.tail;
    const fL = this.formants[0];
    const fR = this.formants[1];
    const fg = this.formantGain;

    for (let i = start; i < end; i++) {
      if (this.blockCounter-- <= 0) {
        this.blockCounter = 32;
        this._block();
      }

      // --- smooth parameters ---
      this.rpm += (t.rpm - this.rpm) * kRpm;
      this.load += (t.load - this.load) * kLoad;
      this.overrun += (t.overrun - this.overrun) * kOver;
      this.exhaust += (t.exhaust - this.exhaust) * kSlow;
      this.starter += (t.starter - this.starter) * kLoad;
      this.gate += ((pumping ? 1 : 0) - this.gate) * kGate;
      if (this.popCooldown > 0) this.popCooldown--;

      const rpm = this.rpm;
      const rpmN = Math.min(1, rpm / 9000);
      const load = this.load;

      // --- crankshaft ---
      const dCycle = rpm / 120 / sr; // 720° per cycle
      const dSlot = dCycle * 6;
      this.cycle += dCycle;
      if (this.cycle >= 1) this.cycle -= 1;
      const slot = (this.cycle * 6) | 0;
      if (slot !== this.slot) {
        this.slot = slot;
        this._fire(slot);
      }

      // --- exhaust pulses per bank ---
      let bankL = 0;
      let bankR = 0;
      for (let b = 0; b < 2; b++) {
        const ev = this.bankEv[b];
        ev.age += dSlot;
        if (ev.age >= 0 && ev.age < ev.width) {
          const x = ev.age / ev.width;
          const v = ev.amp * (lookup(PULSE, x) + ev.crack * VOICE.crack * lookup(CRACK, x));
          if (b === 0) bankL = v;
          else bankR = v;
        }
      }
      // Turbulent flow noise rides on the pulses.
      const flow = n.next() * (0.05 + 0.18 * load) * rpmN * VOICE.flowNoise;
      bankL += flow * Math.abs(bankL);
      bankR += flow * Math.abs(bankR);

      // Pops enter the exhaust so the pipes colour them.
      let pop = 0;
      if (this.popEnv > 1e-4) {
        pop = n.next() * this.popEnv;
        this.popEnv *= this.popDecay;
        if (this.popBank === 0) bankL += pop * 0.8;
        else bankR += pop * 0.8;
      }

      // --- pipes ---
      const hL = hp[0].run(bankL);
      const hR = hp[1].run(bankR);
      const pan = VOICE.pan;
      let exL = tp[0].run(pan * hL + (1 - pan) * hR);
      let exR = tp[1].run((1 - pan) * hL + pan * hR);

      // --- body resonances ---
      let rL = exL * VOICE.dry;
      let rR = exR * VOICE.dry;
      for (let k = 0; k < 5; k++) {
        rL += fL[k].run(exL) * fg[k] * 4;
        rR += fR[k].run(exR) * fg[k] * 4;
      }
      exL = rL;
      exR = rR;

      // --- intake howl: one suction pulse per slot, half a slot after firing ---
      const ip = this.cycle * 6 + 0.5;
      const intake = lookup(INTAKE, ip - Math.floor(ip)) * this.intakeAmp;
      const inGain = (0.12 + 0.88 * load) * (0.08 + 0.92 * Math.pow(rpmN, 1.3));
      // Air rush pulses with each intake stroke rather than hissing steadily.
      const env = Math.max(0, intake) * 1.6 + 0.15;
      const rush = this.airRush.run(n.next() * env) * Math.pow(load, 1.5) * Math.pow(rpmN, 1.2) * 0.6;
      const inSig =
        ((this.plenum.run(intake) * 1.0 + this.runner.run(intake) * 0.7 + this.howl.run(intake) * 0.35) * inGain + rush * 0.6) *
        VOICE.intake.level;

      // --- sub-bass: firing order (3rd) and the boxer's 1.5 order ---
      const S = VOICE.sub;
      const sub =
        (sinCycles(this.cycle * 6) * S.order3 +
          sinCycles(this.cycle * 3 + 0.13) * S.order15 +
          sinCycles(this.cycle * 2 + 0.31) * S.order1) *
        (0.45 + 0.55 * load) *
        (1.4 - 0.8 * rpmN) *
        (t.ignition > 0.5 ? 1 : 0.3);

      // --- mechanical: valve-train ticks and a faint gear whine ---
      this.tickEnv *= this.tickDecay;
      const tickRaw = n.next() * this.tickEnv;
      const tick = tickRaw - this.tickHp;
      this.tickHp += (tickRaw - this.tickHp) * 0.3;
      this.whinePhase += (rpm / 60) * 26 / sr;
      if (this.whinePhase > 1) this.whinePhase -= 1;
      const mech = tick * 0.012 * (0.4 + 0.6 * rpmN) + sinCycles(this.whinePhase) * 0.004 * rpmN * rpmN;

      // --- starter motor ---
      let starter = 0;
      if (this.starter > 1e-3) {
        // Each compression stroke is a low "chug"; the starter whirrs underneath.
        const stroke = Math.max(0, sinCycles(this.cycle * 6));
        const chug = this.chugLp.run(stroke * stroke * stroke - 0.2);
        const whirr = this.starterBp.run(n.next()) * (0.55 + 0.45 * (1 - stroke));
        starter = (chug * 0.6 + whirr * 0.1) * this.starter;
      }

      // --- thump (bangs, and the engine settling at shutdown) ---
      let thump = 0;
      if (t.ignition < 0.5 && rpm < 150 && !this.stopThumped && this.gate > 0.1) {
        this.stopThumped = true;
        this.thumpEnv = 0.5;
        this.thumpDecay = Math.exp(-1 / (sr * 0.09));
        this.thumpFreq = 48;
      }
      if (t.ignition > 0.5) this.stopThumped = false;
      if (this.thumpEnv > 1e-4) {
        this.thumpPhase += this.thumpFreq / sr;
        if (this.thumpPhase > 1) this.thumpPhase -= 1;
        thump = sinCycles(this.thumpPhase) * this.thumpEnv;
        this.thumpEnv *= this.thumpDecay;
      }

      // --- mix, tone, drive, loudness ---
      const center = inSig * 0.55 + sub + mech;
      let L = (exL + center) * this.gate;
      let R = (exR + center) * this.gate;
      L = this.bass[0].run(this.tone[0].run(L));
      R = this.bass[1].run(this.tone[1].run(R));
      // Crack of the pop on top, unfiltered.
      L += pop * (1 - this.popPan) * 0.5;
      R += pop * this.popPan * 0.5;
      // Drive adds grit at high load without changing the level much.
      L = soft(L * this.drive) / this.drive;
      R = soft(R * this.drive) / this.drive;
      // Starter and thumps are not part of the running-engine loudness curve.
      const extra = (starter * 0.45 + thump * 0.35) * this.gate;
      L = this.dc[0].run(L * this.loudness * 2.2 + extra);
      R = this.dc[1].run(R * this.loudness * 2.2 + extra);
      outL[i] = soft(L);
      outR[i] = soft(R);
    }

    // Engine fully stopped: clear the pipes so nothing rings on restart.
    if (!pumping && this.gate < 1e-4) this._resetState();
  }

  _resetState() {
    for (const p of this.header) p.reset();
    for (const p of this.tail) p.reset();
    for (const bank of this.formants) for (const f of bank) f.reset();
    for (const f of [...this.tone, ...this.bass, ...this.dc, this.plenum, this.runner, this.howl, this.airRush, this.starterBp, this.chugLp]) f.reset();
    this.popEnv = 0;
    this.thumpEnv = 0;
    this.bankEv[0].age = this.bankEv[1].age = 99;
  }
}

// ---------------------------------------------------------------------------
// AudioWorklet registration (only inside an AudioWorkletGlobalScope)
// ---------------------------------------------------------------------------

if (typeof registerProcessor === 'function') {
  class FlatSixProcessor extends AudioWorkletProcessor {
    constructor() {
      super();
      // `sampleRate` is a global in the worklet scope.
      this.synth = new FlatSixSynth(sampleRate);
      this.synth.onEvent = (ev) => this.port.postMessage(ev);
      this.port.onmessage = (e) => this.synth.setParams(e.data);
    }

    process(_inputs, outputs) {
      const out = outputs[0];
      const L = out[0];
      const R = out[1] || out[0];
      this.synth.render(L, R, 0, L.length);
      return true;
    }
  }
  registerProcessor('flat-six', FlatSixProcessor);
}

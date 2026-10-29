/**
 * synth-piston.js — procedural piston-engine sound (no samples). One synth,
 * three voicings: the GT3 flat-six, a 70s muscle-car V8 and a superbike
 * inline-four.
 *
 * How the sound is built, per sample:
 *
 *  1. Crankshaft. A 4-stroke cycle is 720°. The cylinders fire evenly in the
 *     engine's firing order, each into the exhaust of its bank.
 *  2. Exhaust pulses. Each firing releases a pressure pulse (a sharp
 *     blowdown peak followed by a scavenging dip). Its size follows the
 *     load; each cylinder is slightly different and every event jitters a
 *     little, which gives the engine its organic, lumpy character.
 *  3. Pipes. Each bank's pulses ring through its own header (a delay line
 *     with feedback, i.e. a resonant pipe). The two banks reach the
 *     tailpipes slightly out of step, which brings out the half orders:
 *     the flat-six's deep 1.5 order, the V8's burble.
 *     A short tailpipe comb adds the metallic edge.
 *  4. Body. A bank of fixed resonances (body boom, muffler, rasp) colours
 *     the sound. They don't move with RPM, so different harmonics light up
 *     as the revs climb, as in a real vehicle.
 *  5. Intake. Intake pulses through plenum and runner resonances, plus air
 *     rush that grows with throttle.
 *  6. Mechanics, sub-bass, starter motor, and pops/bangs on the overrun.
 *  7. Tone, drive and a soft limiter.
 */

import { TABLE, lookup, sinCycles, soft, Biquad, Pipe, Noise } from './dsp.js';

/**
 * Voicings: the knobs that give each engine its character.
 *
 * flat6 — deep and hollow, GT3-style: the two banks' pulses reach the
 * tailpipes slightly out of step and with different strength, which brings
 * out the boxer's 1.5 engine order an octave below the firing note. It
 * survives mono playback, so the car's subwoofer gets it too.
 *
 * v8 — cross-plane V8 with dual exhaust: each bank fires unevenly
 * (right-left-right-right-left-right-left-left), so each pipe burbles at half
 * the firing rate. A big cam makes the idle lope.
 *
 * moto — flat-plane inline-four, 4-2-1 exhaust: even, fast, sharp pulses and
 * a loud airbox howl that screams to 14,000 rpm.
 */
export const PISTON_VOICES = {
  flat6: {
    cylinders: 6,
    firing: [0, 5, 1, 3, 2, 4], // cylinders 1-6-2-4-3-5 (0-based)
    bankOf: [0, 0, 0, 1, 1, 1], // 1-3 left bank, 4-6 right bank
    cylGain: [1.0, 0.92, 1.06, 0.96, 1.04, 0.9], // static imbalance
    lope: 0,
    redRef: 9000, // rpm that counts as "high revs"
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
    sub: { firing: 0.22, half: 0.2, crank: 0.05 }, // sine layer levels
    bassShelf: { freq: 150, gainDb: 5 },
    toneMin: 600, // Hz: closed exhaust, idle
    toneRange: 5600, // Hz added at full throttle and revs
    loud: { base: -27.5, revs: 16.5, load: 7 }, // dB
    whineTeeth: 26,
    popCutRpm: 3500,
    popRate: 13,
    starterChug: 170,
  },
  v8: {
    cylinders: 8,
    firing: [0, 4, 3, 1, 5, 2, 6, 7], // Ford 302: 1-5-4-2-6-3-7-8
    bankOf: [0, 0, 0, 0, 1, 1, 1, 1], // 1-4 right bank, 5-8 left bank
    cylGain: [1.0, 0.84, 1.12, 0.94, 1.1, 0.86, 1.05, 0.9],
    lope: 2.4, // big cam: uneven combustion at idle
    redRef: 6000,
    blowdownMs: 12.5,
    scavenge: 0.12,
    bankLag: 0.32,
    bankLagHigh: 0.05,
    bankGain: 0.72,
    crack: 0.16,
    flowNoise: 0.5,
    headers: [0.0086, 0.0097],
    headerFeedback: -0.5,
    headerDamping: 1800,
    tails: [0.0034, 0.0039],
    tailFeedback: 0.22,
    tailDamping: 3200,
    body: [
      [62, 1.0, 1.0],
      [128, 1.3, 0.85],
      [290, 2.0, 0.5],
      [640, 2.4, 0.22],
      [1500, 2.0, 0.07],
    ],
    dry: 0.5,
    pan: 0.78, // dual exhaust: a pipe on each side
    intake: { plenum: 85, runner: 240, howl: 560, rush: 850, level: 0.55 },
    sub: { firing: 0.12, half: 0.3, crank: 0.1 },
    bassShelf: { freq: 120, gainDb: 6 },
    toneMin: 420,
    toneRange: 3600,
    loud: { base: -24, revs: 15, load: 7 },
    whineTeeth: 0,
    popCutRpm: 2500,
    popRate: 7,
    starterChug: 140,
  },
  moto: {
    cylinders: 4,
    firing: [0, 1, 3, 2], // 1-2-4-3
    bankOf: [0, 1, 1, 0], // 4-2-1 headers: 1+4 and 2+3 pair up
    cylGain: [1.0, 0.95, 1.04, 0.97],
    lope: 0,
    redRef: 14000,
    blowdownMs: 3.4,
    scavenge: 0.3,
    bankLag: 0.04,
    bankLagHigh: 0.02,
    bankGain: 0.94,
    crack: 0.5,
    flowNoise: 0.8,
    headers: [0.0031, 0.0036],
    headerFeedback: -0.4,
    headerDamping: 5200,
    tails: [0.0011, 0.0013],
    tailFeedback: 0.25,
    tailDamping: 7500,
    body: [
      [130, 1.0, 0.45],
      [420, 1.8, 0.7],
      [1100, 2.4, 0.6],
      [2400, 2.6, 0.42],
      [4300, 2.2, 0.2],
    ],
    dry: 0.55,
    pan: 0.54,
    intake: { plenum: 320, runner: 950, howl: 2100, rush: 2600, level: 1.25 },
    sub: { firing: 0.07, half: 0, crank: 0.03 },
    bassShelf: { freq: 200, gainDb: 1 },
    toneMin: 900,
    toneRange: 8200,
    loud: { base: -22, revs: 11, load: 6.5 },
    whineTeeth: 34,
    popCutRpm: 6000,
    popRate: 10,
    starterChug: 230,
  },
};

/** Exhaust pressure pulse (x in 0..1) and its sharp "crack" derivative, per scavenge depth. */
const pulseCache = new Map();
function pulseTables(scavenge) {
  if (pulseCache.has(scavenge)) return pulseCache.get(scavenge);
  const PULSE = new Float32Array(TABLE + 1);
  const CRACK = new Float32Array(TABLE + 1);
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
    const dip = scavenge * Math.exp(-Math.pow((x - 0.48) / 0.13, 2)) * taper;
    PULSE[i] = bump[i] - dip;
    maxP = Math.max(maxP, Math.abs(PULSE[i]));
  }
  for (let i = 0; i <= TABLE; i++) {
    PULSE[i] /= maxP;
    const d = i > 0 && i < TABLE ? bump[i + 1] - bump[i - 1] : 0;
    CRACK[i] = d;
    maxD = Math.max(maxD, Math.abs(d));
  }
  for (let i = 0; i <= TABLE; i++) CRACK[i] /= maxD;
  const tables = { PULSE, CRACK };
  pulseCache.set(scavenge, tables);
  return tables;
}

/** Intake suction pulse. */
const INTAKE = new Float32Array(TABLE + 1);
for (let i = 0; i <= TABLE; i++) {
  const s = Math.sin(Math.PI * Math.pow(i / TABLE, 0.75));
  INTAKE[i] = s * s - 0.5;
}

export class PistonSynth {
  constructor(sampleRate, seed = 1234567, voice = PISTON_VOICES.flat6) {
    const sr = (this.sr = sampleRate);
    const V = (this.V = voice);
    this.noise = new Noise(seed);
    this.N = V.cylinders;
    this.firingDiv = 120 / V.cylinders; // rpm / firingDiv = firing frequency (Hz)
    const { PULSE, CRACK } = pulseTables(V.scavenge);
    this.PULSE = PULSE;
    this.CRACK = CRACK;

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
    this.slot = 0; // which firing slot we are in
    this.bankEv = [this._event(), this._event()]; // current exhaust pulse per bank
    this.intakeAmp = 0;
    this.cylDrift = new Float32Array(this.N).fill(1);

    // Pipes: headers per bank (different lengths), then tailpipes per side.
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
    this.chugLp = new Biquad().lowpass(sr, V.starterChug, 0.8);
    this.starterBp = new Biquad().bandpass(sr, 2 * V.starterChug, 2.2);

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

    /** Called with {type:'pop', amp} so the UI can react to each pop. */
    this.onEvent = null;
  }

  _event() {
    return { age: 99, amp: 0, crack: 0, width: 1 };
  }

  /** Update targets: {rpm, load, overrun, cut, ignition, starter, crackle, exhaust, cold}. */
  setParams(p) {
    for (const k in p) if (k in this.target && Number.isFinite(p[k])) this.target[k] = p[k];
  }

  /** One-shot sounds: engines have none (pops come from the overrun). */
  trigger() {}

  /** Recompute slow-moving filter settings (every 32 samples). */
  _block() {
    const sr = this.sr;
    const V = this.V;
    const rpmN = Math.min(1, this.rpm / V.redRef);
    const load = this.load;
    const open = this.exhaust;

    const cutoff = V.toneMin + V.toneRange * (0.3 + 0.7 * open) * (0.3 + 0.7 * load) * (0.35 + 0.65 * rpmN);
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
    const db = Math.min(0, V.loud.base + V.loud.revs * Math.pow(rpmN, 0.7) + V.loud.load * load);
    this.loudness = Math.pow(10, db / 20);

    // Each cylinder's strength drifts slowly (no two cycles are the same).
    for (let c = 0; c < this.N; c++) {
      this.cylDrift[c] += (1 - this.cylDrift[c]) * 0.02 + this.noise.next() * 0.004;
    }
  }

  /** A new firing event in `slot`: set up that bank's pulse. */
  _fire(slot) {
    const t = this.target;
    const V = this.V;
    const cyl = V.firing[slot];
    const bank = V.bankOf[cyl];
    const ev = this.bankEv[bank];
    const n = this.noise;
    const rpmN = Math.min(1, this.rpm / V.redRef);
    const load = this.load;
    const combustion = t.ignition > 0.5 && !(t.cut > 0.5);

    let gain = V.cylGain[cyl];
    // A big cam makes the cylinders burn very differently at idle: the lope.
    if (V.lope) gain = 1 + (gain - 1) * (1 + V.lope * (1 - rpmN) * (1 - rpmN) * (1 - load));

    let amp;
    if (combustion) {
      amp = (0.3 + 0.7 * Math.pow(load, 0.8)) * gain * this.cylDrift[cyl];
      // Off throttle (or still cold) the mixture burns unevenly: burble and
      // the odd weak firing, which gives a cold start its lumpy idle.
      const burble = this.overrun * (1 - load);
      const cold = Math.min(1, t.cold) * (1 - rpmN);
      amp *= 1 + n.next() * (0.05 + 0.5 * burble + 0.16 * cold);
      if (cold > 0.2 && n.unit() < 0.05 * cold) amp *= 0.5;
      if (burble > 0.1 && n.unit() < 0.12 * burble) amp *= 0.15;
    } else {
      // Just air being pumped: a little louder while the starter cranks.
      amp = (t.starter > 0.5 ? 0.14 : 0.07) * gain;
    }
    // The second bank's pulses arrive a little later and weaker (unequal
    // paths to the tailpipes): that is what makes the deep half-order note.
    const lag = bank === 1 ? V.bankLag + V.bankLagHigh * rpmN : 0;
    ev.amp = amp * (bank === 1 ? V.bankGain : 1);
    ev.crack = combustion ? 0.2 + 1.0 * load : 0;
    // The blowdown takes about the same time whatever the revs, so at low RPM
    // the pulses are separate beats; at high RPM they merge into a wail.
    ev.width = Math.min(1.6, Math.max(0.42, ((V.blowdownMs / 1000) * Math.max(this.rpm, 100)) / this.firingDiv));
    // Timing jitter: more at idle, tiny at high revs.
    ev.age = -lag - n.unit() * (0.03 - 0.022 * rpmN);

    // Strength of this cylinder's intake stroke.
    this.intakeAmp = (0.25 + 0.75 * load) * (t.ignition > 0.5 ? 1 : 0.4);

    // Valve-train tick.
    this.tickEnv = 0.6 + 0.4 * n.unit();

    // Pops: unburnt fuel igniting in the hot exhaust.
    if (t.ignition > 0.5 && this.popCooldown <= 0) {
      const eventsPerSecond = Math.max(this.rpm, 300) / this.firingDiv;
      let chance = 0;
      if (this.overrun > 0.02) chance = (t.crackle * this.overrun * V.popRate) / eventsPerSecond;
      if (t.cut > 0.5 && this.rpm > V.popCutRpm) chance += 0.12 * t.crackle;
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
    const V = this.V;
    const N = this.N;
    const PULSE = this.PULSE;
    const CRACK = this.CRACK;

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
      const rpmN = Math.min(1, rpm / V.redRef);
      const load = this.load;

      // --- crankshaft ---
      const dCycle = rpm / 120 / sr; // 720° per cycle
      const dSlot = dCycle * N;
      this.cycle += dCycle;
      if (this.cycle >= 1) this.cycle -= 1;
      const slot = (this.cycle * N) | 0;
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
          const v = ev.amp * (lookup(PULSE, x) + ev.crack * V.crack * lookup(CRACK, x));
          if (b === 0) bankL = v;
          else bankR = v;
        }
      }
      // Turbulent flow noise rides on the pulses.
      const flow = n.next() * (0.05 + 0.18 * load) * rpmN * V.flowNoise;
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
      const pan = V.pan;
      let exL = tp[0].run(pan * hL + (1 - pan) * hR);
      let exR = tp[1].run((1 - pan) * hL + pan * hR);

      // --- body resonances ---
      let rL = exL * V.dry;
      let rR = exR * V.dry;
      for (let k = 0; k < 5; k++) {
        rL += fL[k].run(exL) * fg[k] * 4;
        rR += fR[k].run(exR) * fg[k] * 4;
      }
      exL = rL;
      exR = rR;

      // --- intake howl: one suction pulse per slot, half a slot after firing ---
      const ip = this.cycle * N + 0.5;
      const intake = lookup(INTAKE, ip - Math.floor(ip)) * this.intakeAmp;
      const inGain = (0.12 + 0.88 * load) * (0.08 + 0.92 * Math.pow(rpmN, 1.3));
      // Air rush pulses with each intake stroke rather than hissing steadily.
      const env = Math.max(0, intake) * 1.6 + 0.15;
      const rush = this.airRush.run(n.next() * env) * Math.pow(load, 1.5) * Math.pow(rpmN, 1.2) * 0.6;
      const inSig =
        ((this.plenum.run(intake) * 1.0 + this.runner.run(intake) * 0.7 + this.howl.run(intake) * 0.35) * inGain + rush * 0.6) *
        V.intake.level;

      // --- sub-bass: firing note, its half order and the crank ---
      const S = V.sub;
      const sub =
        (sinCycles(this.cycle * N) * S.firing +
          sinCycles(this.cycle * (N / 2) + 0.13) * S.half +
          sinCycles(this.cycle * 2 + 0.31) * S.crank) *
        (0.45 + 0.55 * load) *
        (1.4 - 0.8 * rpmN) *
        (t.ignition > 0.5 ? 1 : 0.3);

      // --- mechanical: valve-train ticks and a faint gear whine ---
      this.tickEnv *= this.tickDecay;
      const tickRaw = n.next() * this.tickEnv;
      const tick = tickRaw - this.tickHp;
      this.tickHp += (tickRaw - this.tickHp) * 0.3;
      this.whinePhase += (rpm / 60) * V.whineTeeth / sr;
      if (this.whinePhase > 1) this.whinePhase -= 1;
      const mech = tick * 0.012 * (0.4 + 0.6 * rpmN) + sinCycles(this.whinePhase) * 0.004 * rpmN * rpmN;

      // --- starter motor ---
      let starter = 0;
      if (this.starter > 1e-3) {
        // Each compression stroke is a low "chug"; the starter whirrs underneath.
        const stroke = Math.max(0, sinCycles(this.cycle * N));
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

/** The GT3 flat-six (the default sound). */
export class FlatSixSynth extends PistonSynth {
  constructor(sampleRate, seed = 1234567) {
    super(sampleRate, seed, PISTON_VOICES.flat6);
  }
}


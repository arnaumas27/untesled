/**
 * synth-jet.js — a CFM56-style high-bypass turbofan, from start-up whine to
 * takeoff roar.
 *
 *  - Fan: the blade-passing tone (24 wide-chord blades) and its harmonic,
 *    wobbling with the airflow. Above ~75 % N1 the blade tips go supersonic and
 *    the "buzz-saw" appears: a rasp of every harmonic of the fan's rotation.
 *  - The CFM56 moan: a pair of beating tones at a low multiple of the fan
 *    speed, strongest while taxiing.
 *  - Core: the high-pressure compressor's whine, following N2.
 *  - Jet: broadband roar (louder and brighter with thrust), low rumble, and
 *    a crackle at full power.
 *  - Start: the air-turbine starter's rising "wheee", light-off whump.
 *  - Reverse thrust: extra roar and rush.
 */

import { TWO_PI, TABLE, lookup, sinCycles, soft, smoothstep, coef, Biquad, Noise } from './dsp.js';

const FAN_RPM = 5175; // N1 = 100 %
const FAN_BLADES = 24;
const CORE_TONE = 7600; // Hz of the compressor whine at N2 = 100 %

/** Buzz-saw wave: every harmonic of the fan rotation, with irregular blade strengths. */
const BUZZ = new Float32Array(TABLE + 1);
(() => {
  const n = new Noise(0x5eed);
  const amps = [];
  const phases = [];
  for (let k = 1; k <= 48; k++) {
    const band = Math.exp(-Math.pow((k - 14) / 11, 2)); // strongest around the 8th–20th
    amps.push((0.25 + 0.75 * n.unit()) * band);
    phases.push(n.unit());
  }
  let max = 0;
  for (let i = 0; i <= TABLE; i++) {
    let v = 0;
    for (let k = 1; k <= 48; k++) v += amps[k - 1] * Math.sin(TWO_PI * (k * (i / TABLE) + phases[k - 1]));
    BUZZ[i] = v;
    max = Math.max(max, Math.abs(v));
  }
  for (let i = 0; i <= TABLE; i++) BUZZ[i] /= max;
})();

export class TurbofanSynth {
  constructor(sampleRate, seed = 7331) {
    const sr = (this.sr = sampleRate);
    this.noise = new Noise(seed);
    this.noiseR = new Noise(seed * 3 + 1);
    // n1 / n2: fan and core speed (0..1.05); fuel: burning; starter: air starter
    // engaged; reverse: thrust reversers deployed (0..1).
    this.target = { n1: 0, n2: 0, fuel: 0, starter: 0, reverse: 0 };
    this.n1 = 0;
    this.n2 = 0;
    this.fuel = 0;
    this.starter = 0;
    this.reverse = 0;

    this.fanPhase = 0;
    this.bpfPhase = 0;
    this.moanPhase = [0, 0];
    this.corePhase = [0, 0];
    this.starterPhase = [0, 0];
    this.wobble = 0;
    this.wobbleTarget = 0;

    this.roarLp = [new Biquad(), new Biquad()];
    this.roarLp2 = [new Biquad(), new Biquad()];
    this.rumble = [new Biquad().lowpass(sr, 70, 0.8), new Biquad().lowpass(sr, 70, 0.8)];
    this.buzzBp = new Biquad().bandpass(sr, 1200, 0.6);
    this.rush = [new Biquad().bandpass(sr, 650, 0.8), new Biquad().bandpass(sr, 720, 0.8)];
    this.crackHp = new Biquad().highpass(sr, 1800, 0.7);
    this.whumpLp = new Biquad().lowpass(sr, 140, 0.9);
    this.dc = [new Biquad().highpass(sr, 22, 0.6), new Biquad().highpass(sr, 22, 0.6)];
    this.whump = 0;
    this.whumpDecay = Math.exp(-1 / (sr * 0.45));
    this.crackEnv = 0;
    this.crackDecay = Math.exp(-1 / (sr * 0.003));
    this.lastFuel = 0;
    this.blockCounter = 0;
    this.gate = 0;
    this.onEvent = null;
  }

  setParams(p) {
    for (const k in p) if (k in this.target && Number.isFinite(p[k])) this.target[k] = p[k];
  }

  trigger() {}

  _block() {
    const sr = this.sr;
    // Exhaust roar gets brighter with thrust.
    const cut = 160 + 2600 * Math.pow(this.n1, 1.6) + 900 * this.reverse;
    for (let c = 0; c < 2; c++) {
      this.roarLp[c].lowpass(sr, cut, 0.6);
      this.roarLp2[c].lowpass(sr, cut * 1.6, 0.5);
    }
    // Slow airflow wobble on the tones.
    if (this.noise.unit() < 0.02) this.wobbleTarget = this.noise.next();
  }

  render(outL, outR, start = 0, end = outL.length) {
    const t = this.target;
    const sr = this.sr;
    const n = this.noise;
    const kSpool = coef(sr, 0.05);
    const kFuel = coef(sr, 0.25);
    const kFast = coef(sr, 0.08);
    const kGate = coef(sr, 0.05);
    const alive = t.n2 > 0.002 || t.fuel > 0.5 || t.starter > 0.5;

    if (!alive && this.gate < 1e-4 && this.n2 < 0.002) {
      for (let i = start; i < end; i++) outL[i] = outR[i] = 0;
      return;
    }

    for (let i = start; i < end; i++) {
      if (this.blockCounter-- <= 0) {
        this.blockCounter = 64;
        this._block();
      }
      this.n1 += (t.n1 - this.n1) * kSpool;
      this.n2 += (t.n2 - this.n2) * kSpool;
      this.fuel += (t.fuel - this.fuel) * kFuel;
      this.starter += (t.starter - this.starter) * kFast;
      this.reverse += (t.reverse - this.reverse) * kFast;
      this.gate += ((alive ? 1 : 0) - this.gate) * kGate;
      this.wobble += (this.wobbleTarget - this.wobble) * 0.00005;

      const n1 = this.n1;
      const n2 = this.n2;
      const fuel = this.fuel;

      // Light-off: the first flame in the combustor is a soft low whump.
      if (t.fuel > 0.5 && this.lastFuel < 0.5) this.whump = 1;
      this.lastFuel = t.fuel;

      // --- fan ---
      const shaftHz = (n1 * FAN_RPM) / 60;
      this.fanPhase += shaftHz / sr;
      if (this.fanPhase >= 1) this.fanPhase -= 1;
      const wob = 1 + 0.004 * this.wobble;
      this.bpfPhase += (shaftHz * FAN_BLADES * wob) / sr;
      if (this.bpfPhase >= 1) this.bpfPhase -= 1;
      const flutter = 0.8 + 0.2 * n.next();
      const fanTone =
        (sinCycles(this.bpfPhase) * 0.7 + sinCycles(this.bpfPhase * 2 + 0.2) * 0.25) *
        flutter *
        Math.pow(n1, 1.3) *
        (1 - 0.5 * smoothstep(0.7, 1, n1));
      // Buzz-saw: supersonic blade tips at high power.
      const buzz = this.buzzBp.run(lookup(BUZZ, this.fanPhase)) * smoothstep(0.72, 0.97, n1) * 1.6;
      // The moan: two close tones beating, strongest while taxiing.
      const moanHz = shaftHz * 5.1;
      this.moanPhase[0] += moanHz / sr;
      this.moanPhase[1] += (moanHz * 1.012) / sr;
      for (let k = 0; k < 2; k++) if (this.moanPhase[k] >= 1) this.moanPhase[k] -= 1;
      const moanAmt = Math.exp(-Math.pow((n1 - 0.42) / 0.2, 2)) * 0.35 * smoothstep(0.08, 0.2, n1);
      const moan = (sinCycles(this.moanPhase[0]) + sinCycles(this.moanPhase[1])) * moanAmt;

      // --- core compressor whine ---
      const coreHz = n2 * CORE_TONE;
      this.corePhase[0] += coreHz / sr;
      this.corePhase[1] += (coreHz * 0.66) / sr;
      for (let k = 0; k < 2; k++) if (this.corePhase[k] >= 1) this.corePhase[k] -= 1;
      const core = (sinCycles(this.corePhase[0]) * 0.6 + sinCycles(this.corePhase[1]) * 0.4) * 0.1 * smoothstep(0.05, 0.4, n2) * (1 - 0.6 * smoothstep(0.6, 1, n1));

      // --- air starter: a rising whine while cranking ---
      let starter = 0;
      if (this.starter > 1e-3) {
        const sHz = 120 + n2 * 9000;
        this.starterPhase[0] += sHz / sr;
        this.starterPhase[1] += (sHz * 0.25) / sr;
        for (let k = 0; k < 2; k++) if (this.starterPhase[k] >= 1) this.starterPhase[k] -= 1;
        starter = (sinCycles(this.starterPhase[0]) * 0.5 + sinCycles(this.starterPhase[1]) * 0.5) * this.starter * 0.22;
      }

      // --- jet: roar, rumble, crackle ---
      const thrust = fuel * (0.08 + Math.pow(n1, 2.6));
      const nL = n.next();
      const nR = this.noiseR.next();
      const roarAmt = thrust * (1 + 1.2 * this.reverse);
      const roarL = this.roarLp2[0].run(this.roarLp[0].run(nL)) * roarAmt;
      const roarR = this.roarLp2[1].run(this.roarLp[1].run(nR)) * roarAmt;
      const rumbleAmt = (0.6 * thrust + 0.5 * this.reverse * n1) * 3;
      const rumL = this.rumble[0].run(nL) * rumbleAmt;
      const rumR = this.rumble[1].run(nR) * rumbleAmt;
      const rushAmt = this.reverse * n1 * 0.9;
      const rushL = this.rush[0].run(nR) * rushAmt;
      const rushR = this.rush[1].run(nL) * rushAmt;
      if (n.unit() < (smoothstep(0.82, 1, n1) * fuel * 45) / sr) this.crackEnv = 0.4 + 0.6 * n.unit();
      this.crackEnv *= this.crackDecay;
      const crackle = this.crackHp.run(n.next() * this.crackEnv) * 0.5;

      // Light-off whump.
      let whump = 0;
      if (this.whump > 1e-4) {
        whump = this.whumpLp.run(n.next()) * this.whump * 3;
        this.whump *= this.whumpDecay;
      }

      // --- mix ---
      const tones = (fanTone * 0.22 + buzz * 0.12 + moan * 0.2 + core) * this.gate;
      let L = tones + roarL * 2.6 + rumL + rushL + crackle + whump + starter;
      let R = tones * 0.94 + roarR * 2.6 + rumR + rushR + crackle * 0.8 + whump + starter * 0.9;
      L = this.dc[0].run(L * 0.75);
      R = this.dc[1].run(R * 0.75);
      outL[i] = soft(L);
      outR[i] = soft(R);
    }

    if (!alive && this.gate < 1e-4) {
      for (const f of [...this.roarLp, ...this.roarLp2, ...this.rumble, ...this.rush, ...this.dc, this.buzzBp, this.crackHp, this.whumpLp]) f.reset();
      this.whump = 0;
    }
  }
}

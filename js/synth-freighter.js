/**
 * synth-freighter.js — sci-fi sublight engines for a battered space freighter.
 *
 *  - Throb: two detuned sawtooths an octave over a sub sine, through a
 *    resonant low-pass and pulsed, like a huge engine breathing. Pitch, pulse
 *    rate and brightness rise with power.
 *  - Roar: band-passed noise, ring-modulated for a gritty, metallic edge.
 *  - Whine: a turbine-like whine with a slow vibrato.
 *  - Sizzle: electric crackles that get busier at full power.
 *  - Power-up and power-down glides, a clunk when the reactor catches.
 *  - Triggers: 'sputter' (the hyperdrive won't catch: whirr-clunk ×3) and
 *    'jump' (charge, boom, whoosh into hyperspace).
 */

import { sinCycles, soft, coef, Biquad, Noise, Saw, Ring } from './dsp.js';

const SPUTTER_TIME = 1.5;
const JUMP_CHARGE = 1.1;
const JUMP_TIME = 3.2;

export class FreighterSynth {
  constructor(sampleRate, seed = 1977) {
    const sr = (this.sr = sampleRate);
    this.noise = new Noise(seed);
    // power 0..1; on: reactor running; boot 0..1 while powering up.
    this.target = { power: 0, on: 0, boot: 0 };
    this.power = 0;
    this.boot = 0;
    this.gate = 0;

    this.saws = [new Saw(), new Saw(), new Saw()];
    this.subPhase = 0;
    this.lfoPhase = 0;
    this.whinePhase = [0, 0];
    this.vibPhase = 0;
    this.ringPhase = 0;
    this.lp = [new Biquad(), new Biquad()];
    this.roarBp = [new Biquad(), new Biquad()];
    this.sizzleHp = new Biquad().highpass(sr, 3200, 0.7);
    this.sweepBp = new Biquad();
    this.boomLp = new Biquad().lowpass(sr, 380, 0.8);
    this.whooshBp = [new Biquad(), new Biquad()];
    this.dc = [new Biquad().highpass(sr, 20, 0.6), new Biquad().highpass(sr, 20, 0.6)];
    this.sizzleEnv = 0;
    this.sizzleDecay = Math.exp(-1 / (sr * 0.002));

    this.thump = new Ring(sr, 48, 0.35);
    this.ping = new Ring(sr, 910, 0.18);
    this.ping2 = new Ring(sr, 1370, 0.12);
    this.boom = new Ring(sr, 38, 0.9);

    this.lastOn = 0;
    this.lastBoot = 0;
    this.downTime = 99; // seconds since power-down started
    this.downFrom = 500;
    this.sputterT = 99;
    this.sputterClunk = -1;
    this.jumpT = 99;
    this.sweepPhase = 0;
    this.blockCounter = 0;
    this.onEvent = null;
  }

  setParams(p) {
    for (const k in p) if (k in this.target && Number.isFinite(p[k])) this.target[k] = p[k];
  }

  trigger(name) {
    if (name === 'sputter') {
      this.sputterT = 0;
      this.sputterClunk = -1;
    }
    else if (name === 'jump') this.jumpT = 0;
  }

  _whineHz() {
    return 480 + 900 * this.power;
  }

  _block() {
    const sr = this.sr;
    const p = this.power;
    const cut = 150 + 1200 * Math.pow(p, 1.2);
    this.lp[0].lowpass(sr, cut, 2.2);
    this.lp[1].lowpass(sr, cut * 1.04, 2.2);
    this.roarBp[0].bandpass(sr, 220 + 1200 * p, 0.9);
    this.roarBp[1].bandpass(sr, 240 + 1250 * p, 0.9);
  }

  render(outL, outR, start = 0, end = outL.length) {
    const t = this.target;
    const sr = this.sr;
    const n = this.noise;
    const dt = 1 / sr;
    const kPow = coef(sr, 0.06);
    const kBoot = coef(sr, 0.03);
    const busy = t.on > 0.5 || t.boot > 0.001 || this.downTime < 2.5 || this.sputterT < SPUTTER_TIME || this.jumpT < JUMP_TIME;
    const kGate = coef(sr, t.on > 0.5 ? 0.15 : 1.1);

    if (!busy && this.gate < 1e-4) {
      for (let i = start; i < end; i++) outL[i] = outR[i] = 0;
      return;
    }

    for (let i = start; i < end; i++) {
      if (this.blockCounter-- <= 0) {
        this.blockCounter = 32;
        this._block();
        // Edges: reactor catching, powering down.
        if (t.boot >= 0.999 && this.lastBoot < 0.999) {
          this.thump.hit(0.9);
          this.ping.hit(0.25);
          this.ping2.hit(0.18);
        }
        if (t.on < 0.5 && this.lastOn > 0.5) {
          this.downTime = 0;
          this.downFrom = this._whineHz();
        }
        this.lastBoot = t.boot;
        this.lastOn = t.on;
      }
      this.power += (t.power - this.power) * kPow;
      this.boot += (t.boot - this.boot) * kBoot;
      const live = t.on > 0.5 ? 1 : 0.55 * this.boot;
      this.gate += (live - this.gate) * kGate;
      const p = this.power;
      const g = this.gate;

      // --- throb ---
      const f0 = 36 + 24 * p;
      const s =
        this.saws[0].run(f0 / sr) * 0.5 + this.saws[1].run((f0 * 1.007) / sr) * 0.5 + this.saws[2].run((f0 * 2.003) / sr) * 0.25;
      this.subPhase += f0 / 2 / sr;
      if (this.subPhase >= 1) this.subPhase -= 1;
      this.lfoPhase += (6 + 10 * p) / sr;
      if (this.lfoPhase >= 1) this.lfoPhase -= 1;
      const pulse = 1 - 0.42 * (0.5 + 0.5 * sinCycles(this.lfoPhase));
      const throbL = soft(this.lp[0].run(s) * 2.4) * pulse;
      const throbR = soft(this.lp[1].run(s) * 2.4) * pulse;
      const sub = sinCycles(this.subPhase) * 0.45 * pulse;

      // --- roar, ring-modulated ---
      this.ringPhase += (f0 * 3) / sr;
      if (this.ringPhase >= 1) this.ringPhase -= 1;
      const ring = 0.6 + 0.4 * sinCycles(this.ringPhase);
      const roarAmt = (0.12 + Math.pow(p, 1.5)) * 1.4 * ring;
      const roarL = this.roarBp[0].run(n.next()) * roarAmt;
      const roarR = this.roarBp[1].run(n.next()) * roarAmt;

      // --- whine ---
      this.vibPhase += 5.5 / sr;
      if (this.vibPhase >= 1) this.vibPhase -= 1;
      let whineHz = this._whineHz() * (1 + 0.008 * sinCycles(this.vibPhase));
      let whineAmt = (0.05 + 0.06 * p) * g;
      // Powering up: a long rising glide; powering down: falling away.
      if (this.boot > 0.001 && this.boot < 0.999 && t.on < 0.5) {
        whineHz = 70 + 520 * Math.pow(this.boot, 1.4);
        whineAmt = 0.16 * Math.min(1, this.boot * 4);
      } else if (this.downTime < 2.5) {
        const k = this.downTime / 2.5;
        whineHz = 50 + (this.downFrom - 50) * Math.pow(1 - k, 2);
        whineAmt = 0.14 * (1 - k);
        this.downTime += dt;
      }
      // Hyperdrive failing to catch: whirr up, cut, clunk — three times.
      if (this.sputterT < SPUTTER_TIME) {
        const stage = Math.floor(this.sputterT / 0.5);
        const k = (this.sputterT - stage * 0.5) / 0.5;
        if (k < 0.7) {
          whineHz = 180 + 420 * (k / 0.7);
          whineAmt = 0.17;
        } else {
          whineAmt = 0;
          if (this.sputterClunk !== stage) {
            this.sputterClunk = stage;
            this.thump.hit(0.7);
            this.ping.hit(0.3);
          }
        }
        this.sputterT += dt;
      }
      this.whinePhase[0] += whineHz / sr;
      this.whinePhase[1] += (whineHz * 1.5) / sr;
      for (let k = 0; k < 2; k++) if (this.whinePhase[k] >= 1) this.whinePhase[k] -= 1;
      const whine = (sinCycles(this.whinePhase[0]) + 0.35 * sinCycles(this.whinePhase[1])) * whineAmt;

      // --- sizzle ---
      if (n.unit() < (2 + 25 * p * p) / sr) this.sizzleEnv = 0.3 + 0.7 * n.unit();
      this.sizzleEnv *= this.sizzleDecay;
      const sizzle = this.sizzleHp.run(n.next() * this.sizzleEnv) * 0.35 * g;

      // --- hyperspace jump ---
      let jump = 0;
      let jumpL = 0;
      let jumpR = 0;
      if (this.jumpT < JUMP_TIME) {
        const jt = this.jumpT;
        if (jt < JUMP_CHARGE) {
          const k = jt / JUMP_CHARGE;
          const f = 150 * Math.pow(16, k);
          this.sweepPhase += f / sr;
          if (this.sweepPhase >= 1) this.sweepPhase -= 1;
          if ((i & 31) === 0) this.sweepBp.bandpass(sr, f * 1.5, 3);
          jump = (sinCycles(this.sweepPhase) * 0.3 + this.sweepBp.run(n.next()) * 0.8) * k * k;
        } else if (jt - dt < JUMP_CHARGE) {
          this.boom.hit(1);
          this.thump.hit(1);
        }
        if (jt >= JUMP_CHARGE) {
          const k = (jt - JUMP_CHARGE) / (JUMP_TIME - JUMP_CHARGE);
          const w = Math.pow(1 - k, 2);
          if ((i & 31) === 0) {
            this.whooshBp[0].bandpass(sr, 3000 - 2400 * k, 0.8);
            this.whooshBp[1].bandpass(sr, 3200 - 2500 * k, 0.8);
          }
          jumpL = this.whooshBp[0].run(n.next()) * w * 0.9 + this.boomLp.run(n.next()) * w * w * 2;
          jumpR = this.whooshBp[1].run(n.next()) * w * 0.9 + jumpL * 0.3;
        }
        this.jumpT += dt;
      }

      // --- mix ---
      const clunk = this.thump.run() * 0.9 + this.ping.run() * 0.4 + this.ping2.run() * 0.3 + this.boom.run() * 1.1;
      const level = (0.3 + 0.7 * p) * g;
      let L = (throbL * 0.55 + sub + roarL * 0.6) * level + whine + sizzle + clunk + jump + jumpL;
      let R = (throbR * 0.55 + sub + roarR * 0.6) * level + whine * 0.92 + sizzle * 0.7 + clunk + jump + jumpR;
      L = this.dc[0].run(L * 0.55);
      R = this.dc[1].run(R * 0.55);
      outL[i] = soft(L);
      outR[i] = soft(R);
    }
  }
}

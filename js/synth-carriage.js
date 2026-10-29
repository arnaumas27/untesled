/**
 * synth-carriage.js — a horse and carriage, all synthesized.
 *
 *  - Hooves: each hoof strike excites a few hollow resonances (the classic
 *    clip-clop) plus a low thud and, now and then, the clink of a shoe. The
 *    timing follows the horse's gait: walk (four even beats), trot (two
 *    diagonal pairs), canter (three beats) and gallop (four quick beats).
 *  - Carriage: iron tyres rumbling and clattering over the road, a knock
 *    every wheel turn, wooden creaks, harness bells on every stride, and the
 *    wooden brake squealing when you stop hard.
 *  - The horse: whinny, snort, a stamp of the hoof, and the coachman's whip.
 *  - A short street echo on the hooves.
 */

import { sinCycles, soft, coef, Biquad, Pipe, Noise, Saw, Ring } from './dsp.js';

/**
 * Gaits. beats: [stride phase, leg, strength]; legs 0 left fore, 1 right fore,
 * 2 left hind, 3 right hind.
 */
export const GAITS = [
  { name: 'Halt', beats: [] },
  { name: 'Walk', beats: [[0, 2, 0.75], [0.25, 0, 0.85], [0.5, 3, 0.75], [0.75, 1, 0.85]] },
  { name: 'Trot', beats: [[0, 2, 0.95], [0.014, 1, 0.9], [0.5, 3, 0.95], [0.514, 0, 0.9]] },
  { name: 'Canter', beats: [[0, 2, 0.9], [0.21, 3, 1], [0.225, 0, 0.92], [0.41, 1, 1.1]] },
  { name: 'Gallop', beats: [[0, 2, 0.95], [0.1, 3, 1], [0.27, 0, 1.02], [0.37, 1, 1.15]] },
];

const WHINNY_TIME = 1.9;
const SNORT_TIME = 0.75;
const WHIP_TIME = 0.45;
const STAMP_SCRAPE = 0.14;

class Hoof {
  constructor(sr, front, noise) {
    this.sr = sr;
    this.front = front;
    this.noise = noise;
    this.res = [new Biquad(), new Biquad(), new Biquad()];
    this.thud = new Ring(sr, 95, 0.03);
    this.clink = new Ring(sr, 4100, 0.05);
    this.env = 0;
    this.decay = Math.exp(-1 / (sr * 0.0012));
    this.click = 0;
  }

  strike(amp) {
    const n = this.noise;
    const base = this.front ? [620, 1480, 2900] : [520, 1250, 2480];
    const qs = [9, 8, 6];
    const k = 1 + 0.06 * n.next();
    for (let i = 0; i < 3; i++) this.res[i].bandpass(this.sr, base[i] * k * (1 + 0.02 * n.next()), qs[i]);
    this.env = amp;
    this.click = amp;
    this.thud.hit(amp * 0.7);
    if (n.unit() < 0.12) {
      this.clink.set(3800 + 700 * n.unit(), 0.05);
      this.clink.hit(amp * 0.16);
    }
  }

  run() {
    let x = 0;
    if (this.env > 1e-4) {
      x = this.noise.next() * this.env + this.click;
      this.click = 0;
      this.env *= this.decay;
    }
    const r = this.res;
    return r[0].run(x) * 1.0 + r[1].run(x) * 0.8 + r[2].run(x) * 0.45 + this.thud.run() + this.clink.run();
  }
}

export class CarriageSynth {
  constructor(sampleRate, seed = 1885) {
    const sr = (this.sr = sampleRate);
    const n = (this.noise = new Noise(seed));
    // on: horse harnessed; gait 0..4; stride Hz; speed m/s; squeal 0..1.
    this.target = { on: 0, gait: 0, stride: 1, speed: 0, squeal: 0 };
    this.speed = 0;
    this.stride = 1;
    this.squeal = 0;
    this.gait = 0;
    this.phase = 0;
    this.hooves = [new Hoof(sr, true, n), new Hoof(sr, true, n), new Hoof(sr, false, n), new Hoof(sr, false, n)];

    // Wheels.
    this.rumble = [new Biquad(), new Biquad()];
    this.clatter = [new Biquad().bandpass(sr, 240, 5), new Biquad().bandpass(sr, 780, 4)];
    this.clatterEnv = 0;
    this.clatterDecay = Math.exp(-1 / (sr * 0.004));
    this.wheelPhase = 0;
    this.knock = new Ring(sr, 180, 0.04);

    // Creaks: stick-slip pulses through wood resonances.
    this.creakT = 99;
    this.creakLen = 0.4;
    this.creakF = 100;
    this.creakPhase = 0;
    this.creakBp = [new Biquad().bandpass(sr, 650, 3), new Biquad().bandpass(sr, 1400, 5)];

    // Harness bells: three small bells, four partials each.
    this.bells = [2600, 2950, 3350].map((f) => [1, 1.47, 2.09, 2.56].map((r, i) => new Ring(sr, f * r, [0.35, 0.22, 0.15, 0.1][i])));
    this.bellQueue = [];
    this.clock = 0;

    // Brake squeal.
    this.squealBp = [new Biquad(), new Biquad()];
    this.squealWobble = 0;

    // Voice: whinny (sawtooth through horse-ish formants) and snort.
    this.saw = new Saw();
    this.formants = [new Biquad().bandpass(sr, 900, 5), new Biquad().bandpass(sr, 1800, 6), new Biquad().bandpass(sr, 3100, 7)];
    this.breathBp = new Biquad().bandpass(sr, 2000, 1);
    this.whinnyT = 99;
    this.whinnyPitch = 1;
    this.whinnyLen = WHINNY_TIME;
    this.vibPhase = 0;
    this.nickerPhase = 0;
    this.snortT = 99;
    this.snortRate = 32;
    this.snortPhase = 0;
    this.snortLp = new Biquad().lowpass(sr, 700, 0.8);
    this.snortBp = new Biquad().bandpass(sr, 300, 2);

    // Whip.
    this.whipT = 99;
    this.whipBp = new Biquad();
    this.whipHp = new Biquad().highpass(sr, 2000, 0.7);
    this.crack = new Ring(sr, 2200, 0.002);
    this.crackTail = 0;
    this.crackTailDecay = Math.exp(-1 / (sr * 0.025));

    // Stamp scrape.
    this.scrapeT = 99;
    this.scrapeBp = new Biquad().bandpass(sr, 1600, 1.2);

    this.echo = [new Pipe(sr, 0.029, 0.32, 3500), new Pipe(sr, 0.034, 0.3, 3200)];
    this.dc = [new Biquad().highpass(sr, 30, 0.6), new Biquad().highpass(sr, 30, 0.6)];
    this.blockCounter = 0;
    this.gate = 0;
    this.onEvent = null;
  }

  setParams(p) {
    for (const k in p) if (k in this.target && Number.isFinite(p[k])) this.target[k] = p[k];
  }

  trigger(name) {
    const n = this.noise;
    switch (name) {
      case 'whinny':
        this.whinnyT = 0;
        this.whinnyPitch = 1 + 0.08 * n.next();
        this.whinnyLen = WHINNY_TIME * (1 + 0.1 * n.next());
        this._jingle(3);
        break;
      case 'snort':
        this.snortT = 0;
        this.snortRate = 28 + 10 * n.unit();
        this._jingle(2);
        break;
      case 'whip':
        this.whipT = 0;
        break;
      case 'stamp':
        this.hooves[n.unit() < 0.5 ? 0 : 1].strike(1.1);
        this.scrapeT = 0;
        this._jingle(1);
        break;
      case 'jingle':
        this._jingle(3);
        break;
    }
  }

  /** Shake the harness bells: `count` quick hits over ~150 ms. */
  _jingle(count) {
    for (let i = 0; i < count; i++) {
      const at = this.clock + Math.round(this.noise.unit() * 0.15 * this.sr);
      this.bellQueue.push({ at, bell: (this.noise.unit() * 3) | 0, amp: 0.06 + 0.08 * this.noise.unit() });
    }
  }

  _ringBell(b, amp) {
    const partials = this.bells[b];
    for (let i = 0; i < partials.length; i++) partials[i].hit(amp * [1, 0.6, 0.45, 0.3][i]);
  }

  _block() {
    const sr = this.sr;
    const v = this.speed;
    const cut = Math.min(420, 90 + 12 * v);
    this.rumble[0].lowpass(sr, cut, 0.7);
    this.rumble[1].lowpass(sr, cut * 1.1, 0.7);
    this.squealWobble += (this.noise.next() * 0.3 - this.squealWobble) * 0.05;
    this.squealBp[0].bandpass(sr, 1150 * (1 + 0.02 * this.squealWobble), 25);
    this.squealBp[1].bandpass(sr, 2380 * (1 - 0.015 * this.squealWobble), 30);
    if (this.whinnyT < this.whinnyLen) {
      // Formants open as the whinny rises, close for the nicker at the end.
      const k = this.whinnyT / this.whinnyLen;
      const open = k < 0.55 ? 1 : 0.7;
      this.formants[0].bandpass(sr, 900 * open, 5);
      this.formants[1].bandpass(sr, 1800 * open, 6);
    }
    // Start a creak now and then while rolling.
    if (this.creakT > this.creakLen && v > 0.3 && this.noise.unit() < ((0.1 + 0.08 * Math.min(v, 8)) * 32) / sr) {
      this.creakT = 0;
      this.creakLen = 0.25 + 0.3 * this.noise.unit();
      this.creakF = 70 + 70 * this.noise.unit();
    }
  }

  /** Whinny pitch (Hz) and loudness at time t (s). */
  _whinny(t) {
    const L = this.whinnyLen / WHINNY_TIME;
    const p = this.whinnyPitch;
    const a = 0.12 * L;
    const b = 1.05 * L;
    let f;
    let vib;
    let amp;
    let nicker = 1;
    if (t < a) {
      f = 600 + 650 * (t / a);
      vib = 0.02;
      amp = Math.min(1, t / 0.03);
    } else if (t < b) {
      const k = (t - a) / (b - a);
      f = 1250 * Math.pow(950 / 1250, k);
      vib = 0.03 + 0.07 * k;
      amp = 1 - 0.25 * k;
    } else {
      const k = (t - b) / (this.whinnyLen - b);
      f = 330 + 620 * Math.pow(1 - Math.min(1, k * 3), 2);
      vib = 0.06;
      amp = 0.65 * (1 - k);
      this.nickerPhase += 8.5 / this.sr;
      if (this.nickerPhase >= 1) this.nickerPhase -= 1;
      const s = 0.5 + 0.5 * sinCycles(this.nickerPhase);
      nicker = s * s;
    }
    this.vibPhase += (t < b ? 13 : 10) / this.sr;
    if (this.vibPhase >= 1) this.vibPhase -= 1;
    return { f: f * p * (1 + vib * sinCycles(this.vibPhase)), amp: amp * nicker };
  }

  render(outL, outR, start = 0, end = outL.length) {
    const t = this.target;
    const sr = this.sr;
    const n = this.noise;
    const dt = 1 / sr;
    const kSlow = coef(sr, 0.25);
    const kGate = coef(sr, 0.1);
    const kSqueal = coef(sr, 0.08);
    const busy =
      t.on > 0.5 ||
      this.whinnyT < this.whinnyLen ||
      this.snortT < SNORT_TIME ||
      this.whipT < WHIP_TIME ||
      this.scrapeT < STAMP_SCRAPE ||
      this.bellQueue.length > 0;

    if (!busy && this.gate < 1e-4) {
      for (let i = start; i < end; i++) outL[i] = outR[i] = 0;
      this.clock += end - start;
      return;
    }

    const H = this.hooves;
    for (let i = start; i < end; i++) {
      if (this.blockCounter-- <= 0) {
        this.blockCounter = 32;
        this._block();
      }
      this.clock++;
      const on = t.on > 0.5;
      this.gate += ((busy ? 1 : 0) - this.gate) * kGate;
      this.speed += ((on ? t.speed : 0) - this.speed) * kSlow;
      this.stride += (t.stride - this.stride) * kSlow;
      this.squeal += ((on ? t.squeal : 0) - this.squeal) * kSqueal;
      const v = this.speed;

      // --- hooves: fire each beat of the gait as the stride phase passes it ---
      const wanted = on ? Math.max(0, Math.min(4, Math.round(t.gait))) : 0;
      if (this.gait === 0 && wanted !== 0) {
        this.gait = wanted;
        this.phase = 0.999; // first beat right away
      }
      let hoofSum = 0;
      if (this.gait !== 0) {
        const prev = this.phase;
        this.phase += this.stride / sr;
        let wrapped = false;
        if (this.phase >= 1) {
          this.phase -= 1;
          wrapped = true;
          this.gait = wanted; // change gait at the end of a stride
        }
        const beats = GAITS[this.gait].beats;
        const force = 0.55 + 0.12 * this.gait + 0.25 * Math.min(1, v / 12);
        for (let b = 0; b < beats.length; b++) {
          const at = beats[b][0];
          const hit = wrapped ? at < this.phase || at >= prev : at >= prev && at < this.phase;
          if (hit) {
            H[beats[b][1]].strike(beats[b][2] * force * (0.8 + 0.25 * n.unit()));
            // Harness bells jingle with the horse's stride.
            if (b === 0 && n.unit() < 0.85) this.bellQueue.push({ at: this.clock + 40, bell: (n.unit() * 3) | 0, amp: 0.05 + 0.06 * n.unit() });
          }
        }
      }
      for (let h = 0; h < 4; h++) hoofSum += H[h].run();

      // --- bells ---
      if (this.bellQueue.length) {
        for (let q = this.bellQueue.length - 1; q >= 0; q--) {
          const e = this.bellQueue[q];
          if (e.at <= this.clock) {
            this._ringBell(e.bell, e.amp);
            this.bellQueue.splice(q, 1);
          }
        }
      }
      let bells = 0;
      for (let b = 0; b < 3; b++) for (let p = 0; p < 4; p++) bells += this.bells[b][p].run();

      // --- wheels: rumble, clatter, a knock every turn ---
      const roll = Math.pow(Math.min(1, v / 6), 0.8);
      const rumL = this.rumble[0].run(n.next()) * roll * 0.55;
      const rumR = this.rumble[1].run(n.next()) * roll * 0.55;
      if (v > 0.2 && n.unit() < (4 + 5 * v) / sr) this.clatterEnv = (0.3 + 0.7 * n.unit()) * Math.min(1, v / 4);
      let clat = 0;
      if (this.clatterEnv > 1e-4) {
        const x = n.next() * this.clatterEnv;
        this.clatterEnv *= this.clatterDecay;
        clat = this.clatter[0].run(x) * 1.5 + this.clatter[1].run(x) * 0.9;
      } else {
        clat = this.clatter[0].run(0) * 1.5 + this.clatter[1].run(0) * 0.9;
      }
      this.wheelPhase += v / 4.4 / sr;
      if (this.wheelPhase >= 1) {
        this.wheelPhase -= 1;
        this.knock.hit(0.3 * Math.min(1, v / 3));
      }
      const knock = this.knock.run();

      // --- creak ---
      let creak = 0;
      if (this.creakT < this.creakLen) {
        const k = this.creakT / this.creakLen;
        this.creakPhase += (this.creakF * (1 + 0.6 * k) * (1 + 0.15 * n.next())) / sr;
        let pulse = 0;
        if (this.creakPhase >= 1) {
          this.creakPhase -= 1;
          pulse = 1;
        }
        const env = Math.sin(Math.PI * k);
        creak = (this.creakBp[0].run(pulse) + this.creakBp[1].run(pulse) * 0.6) * env * 1.4;
        this.creakT += dt;
      }

      // --- brake squeal ---
      let squeal = 0;
      if (this.squeal > 1e-3) {
        const x = n.next();
        squeal = (this.squealBp[0].run(x) + this.squealBp[1].run(x) * 0.6) * this.squeal * 3;
      }

      // --- whinny ---
      let voice = 0;
      if (this.whinnyT < this.whinnyLen) {
        const w = this._whinny(this.whinnyT);
        const src = this.saw.run(w.f / sr) * 0.8 + n.next() * 0.25;
        const F = this.formants;
        voice = (F[0].run(src) * 1.2 + F[1].run(src) * 1.0 + F[2].run(src) * 0.5 + src * 0.05) * w.amp * 0.9;
        voice += this.breathBp.run(n.next()) * w.amp * 0.12;
        this.whinnyT += dt;
      }
      // --- snort: air blown through fluttering lips ---
      if (this.snortT < SNORT_TIME) {
        const k = this.snortT / SNORT_TIME;
        const env = Math.min(1, this.snortT / 0.04) * Math.pow(1 - k, 1.5);
        this.snortPhase += (this.snortRate * (1 - 0.25 * k)) / sr;
        if (this.snortPhase >= 1) this.snortPhase -= 1;
        const flutter = 0.5 + 0.5 * sinCycles(this.snortPhase);
        const air = n.next();
        voice += (this.snortLp.run(air) * flutter * flutter * 1.6 + this.snortBp.run(air) * flutter * 0.8) * env;
        this.snortT += dt;
      }

      // --- whip: a swish, then the crack ---
      let whip = 0;
      if (this.whipT < WHIP_TIME) {
        const wt = this.whipT;
        if (wt < 0.12) {
          if ((i & 31) === 0) this.whipBp.bandpass(sr, 500 + 2500 * (wt / 0.12), 1.5);
          whip = this.whipBp.run(n.next()) * (wt / 0.12) * 0.35;
        } else if (wt - dt < 0.12) {
          this.crack.hit(1);
          this.crackTail = 0.8;
          whip = 1;
        }
        if (this.crackTail > 1e-4) {
          whip += this.whipHp.run(n.next() * this.crackTail) * 0.9;
          this.crackTail *= this.crackTailDecay;
        }
        whip += this.crack.run();
        this.whipT += dt;
      }

      // --- stamp scrape ---
      let scrape = 0;
      if (this.scrapeT < STAMP_SCRAPE) {
        const k = this.scrapeT / STAMP_SCRAPE;
        scrape = this.scrapeBp.run(n.next()) * Math.sin(Math.PI * k) * 0.5;
        this.scrapeT += dt;
      }

      // --- mix with a little street echo ---
      const street = hoofSum * 1.5 + bells * 0.7 + whip * 0.6;
      const eL = this.echo[0].run(street) - street;
      const eR = this.echo[1].run(street) - street;
      let L = street * 0.85 + eL * 0.35 + rumL + clat + knock + creak + squeal + voice + scrape;
      let R = street * 0.85 + eR * 0.35 + rumR + clat * 0.8 + knock + creak * 0.7 + squeal * 0.9 + voice + scrape * 0.8;
      L = this.dc[0].run(L * 0.6 * this.gate);
      R = this.dc[1].run(R * 0.6 * this.gate);
      outL[i] = soft(L);
      outR[i] = soft(R);
    }
  }
}

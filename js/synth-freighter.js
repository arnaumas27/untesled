/**
 * synth-freighter.js — a starship's sublight drive, in the spirit of film
 * science fiction rather than any real engine.
 *
 *  - Drone: a deep chord of detuned sawtooths (root, fifth, octave) over a
 *    sub-octave, through a resonant low-pass. Slow beating between the
 *    detuned voices gives it the living, humming quality of a warp core.
 *  - Core pulse: a slow throb (about one beat per second at idle, three at
 *    full power) that swells the drone and opens the filter: "vwom… vwom…".
 *  - Roar: noise through a metallic comb, gritty and heavy, rising steeply
 *    with power.
 *  - Flanger: a slowly sweeping short delay on everything, the classic
 *    swirling sci-fi whoosh.
 *  - Shimmer: faint, glassy high tones wandering in pitch, mostly in the
 *    reverb, like an energy field.
 *  - Thrust: a rushing sweep when you accelerate; electric arcs at high power.
 *  - Space: a large stereo reverb on all of it.
 *
 * Power-up slides the drone up from a growl, with a charging tone and a deep
 * "thoom" when the reactor locks in; power-down slides it into the depths.
 * Triggers: 'sputter' (the hyperdrive fails to catch: charge, cut, clunk,
 * three times) and 'jump' (charge, boom and a pitch-falling zap, whoosh into
 * hyperspace).
 */

import { sinCycles, soft, coef, Biquad, Pipe, Noise, Saw, Ring, Flanger, Reverb } from './dsp.js';

const SPUTTER_TIME = 1.5;
const JUMP_CHARGE = 1.1;
const JUMP_TIME = 3.2;
const DOWN_TIME = 2.8;
const SHIMMER = [1318.5, 1975.5, 2637, 3951]; // Hz, wandering slowly

export class FreighterSynth {
  constructor(sampleRate, seed = 1977) {
    const sr = (this.sr = sampleRate);
    this.noise = new Noise(seed);
    // power 0..1; on: reactor running; boot 0..1 while powering up.
    this.target = { power: 0, on: 0, boot: 0 };
    this.power = 0;
    this.boot = 0;
    this.gate = 0;
    this.f0 = 30; // drone root (Hz), glides

    // Drone.
    this.saws = [new Saw(), new Saw(), new Saw(), new Saw()];
    this.subPhase = 0;
    this.droneLp = [new Biquad(), new Biquad()];
    this.pulsePhase = 0;
    this.lfo = 0;

    // Roar: band-passed noise into a metallic comb.
    this.roarBp = new Biquad();
    this.comb = [new Pipe(sr, 0.0068, 0.72, 3200), new Pipe(sr, 0.0079, 0.7, 3000)];

    // Swirl and space.
    this.flanger = [new Flanger(sr), new Flanger(sr)];
    this.flangePhase = 0;
    this.reverb = new Reverb(sr, { size: 1.6, feedback: 0.84, damping: 0.35 });

    // Shimmer.
    this.shimPhase = new Float64Array(SHIMMER.length);
    this.shimVib = SHIMMER.map((_, i) => i * 0.37);
    this.shimBoost = 0;

    // Thrust whoosh and arcs.
    this.thrust = 0;
    this.thrustBp = new Biquad();
    this.arcEnv = 0;
    this.arcHp = new Biquad().highpass(sr, 2500, 0.7);

    // Events.
    this.charge = new Saw();
    this.chargeBp = new Biquad();
    this.boomPhase = 0;
    this.boomEnv = 0;
    this.boomFreq = 60;
    this.boomTo = 30;
    this.boomDecay = Math.exp(-1 / (sr * 0.9));
    this.zap = new Saw();
    this.zapEnv = 0;
    this.zapFreq = 1600;
    this.zapLp = new Biquad();
    this.burstEnv = 0;
    this.burstLp = new Biquad().lowpass(sr, 700, 0.7);
    this.whooshBp = new Biquad();
    this.jumpSaws = [new Saw(), new Saw(), new Saw()];
    this.jumpLp = new Biquad();
    this.jumpNoiseBp = new Biquad();
    this.clunk = [new Ring(sr, 380, 0.25), new Ring(sr, 920, 0.16), new Ring(sr, 1530, 0.1), new Ring(sr, 62, 0.18)];
    this.pfft = 0;
    this.pfftHp = new Biquad().highpass(sr, 1800, 0.7);
    this.buzzPhase = 0;

    this.lastOn = 0;
    this.lastBoot = 0;
    this.tail = 99;
    this.downTime = 99;
    this.sputterT = 99;
    this.sputterClunk = -1;
    this.jumpT = 99;
    this.dc = [new Biquad().highpass(sr, 18, 0.6), new Biquad().highpass(sr, 18, 0.6)];
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
    } else if (name === 'jump') {
      this.jumpT = 0;
    }
  }

  _boom(from, to, amp, seconds) {
    this.boomFreq = from;
    this.boomTo = to;
    this.boomEnv = Math.max(this.boomEnv, amp);
    this.boomDecay = Math.exp(-1 / (this.sr * seconds));
  }

  _clunk(amp) {
    for (const r of this.clunk) r.hit(amp);
    this.pfft = Math.max(this.pfft, amp * 0.6);
  }

  /** Slow-moving settings, every 32 samples. */
  _block() {
    const sr = this.sr;
    const p = this.power;
    const t = this.target;
    // Edges: the reactor locking in, powering down.
    if (t.boot >= 0.999 && this.lastBoot < 0.999) {
      this._boom(78, 30, 1, 1.1);
      this._clunk(0.35);
      this.shimBoost = 1;
    }
    if (t.on < 0.5 && this.lastOn > 0.5) this.downTime = 0;
    this.lastBoot = t.boot;
    this.lastOn = t.on;

    // The drone's filter opens with power and breathes with the core pulse.
    const cut = (110 + 1100 * Math.pow(p, 1.3)) * (0.7 + 0.6 * this.lfo) * (0.4 + 0.6 * this.gate);
    this.droneLp[0].lowpass(sr, cut, 3.2);
    this.droneLp[1].lowpass(sr, cut * 1.06, 3.2);
    this.roarBp.bandpass(sr, 160 + 900 * p, 0.7);
    this.thrustBp.bandpass(sr, 600 + 3500 * p, 1.2);
  }

  render(outL, outR, start = 0, end = outL.length) {
    const t = this.target;
    const sr = this.sr;
    const n = this.noise;
    const dt = 1 / sr;
    const kPow = coef(sr, 0.25);
    const kBoot = coef(sr, 0.03);
    const kF0 = coef(sr, 0.35);
    const kThrust = coef(sr, 0.15);
    const kBoom = coef(sr, 0.25);
    const zapFall = Math.exp(-dt / 0.12);
    const zapFade = Math.exp(-dt / 0.45);
    const burstFade = Math.exp(-dt / 0.35);
    const pfftFade = Math.exp(-dt / 0.08);
    const events = this.downTime < DOWN_TIME || this.sputterT < SPUTTER_TIME || this.jumpT < JUMP_TIME || this.boomEnv > 1e-3;
    // Keep running a while after everything stops so the reverb rings out.
    const active = t.on > 0.5 || t.boot > 0.001 || events;
    this.tail = active ? 0 : this.tail + (end - start) / sr;
    const busy = active || this.tail < 3;
    const kGate = coef(sr, t.on > 0.5 ? 0.25 : this.downTime < DOWN_TIME ? 0.9 : 0.15);

    if (!busy && this.gate < 1e-4) {
      for (let i = start; i < end; i++) outL[i] = outR[i] = 0;
      return;
    }

    for (let i = start; i < end; i++) {
      if (this.blockCounter-- <= 0) {
        this.blockCounter = 32;
        this._block();
      }
      const prevPower = this.power;
      this.power += (t.power - this.power) * kPow;
      this.boot += (t.boot - this.boot) * kBoot;
      const p = this.power;
      const running = t.on > 0.5;
      let live = running ? 1 : Math.pow(this.boot, 0.6) * 0.9;
      // Powering down: the drone sinks into the depths as it fades.
      let sink = 1;
      if (this.downTime < DOWN_TIME) {
        const k = this.downTime / DOWN_TIME;
        sink = Math.pow(1 - k, 1.6);
        live = Math.max(live, Math.pow(1 - k, 1.2));
        this.downTime += dt;
      }
      this.gate += (live - this.gate) * kGate;
      const g = this.gate;

      // --- drone pitch: up from a growl while booting, sinking at shutdown ---
      let f0 = 34 + 24 * p;
      if (!running && this.boot > 0.001 && this.boot < 0.999) f0 = 10 + (f0 - 10) * Math.pow(this.boot, 0.7);
      f0 = 11 + (f0 - 11) * sink;
      this.f0 += (f0 - this.f0) * kF0;
      const r = this.f0;

      // --- core pulse ---
      this.pulsePhase += (0.8 + 2.6 * p) / sr;
      if (this.pulsePhase >= 1) this.pulsePhase -= 1;
      const lfo = Math.pow(0.5 - 0.5 * sinCycles(this.pulsePhase + 0.25), 1.5);
      this.lfo = lfo;

      // --- drone chord ---
      const S = this.saws;
      const chord = S[0].run(r / sr) * 0.5 + S[1].run((r * 1.0047) / sr) * 0.5 + S[2].run((r * 1.4983) / sr) * 0.35 + S[3].run((r * 2.006) / sr) * 0.25;
      this.subPhase += r / 2 / sr;
      if (this.subPhase >= 1) this.subPhase -= 1;
      const sub = sinCycles(this.subPhase) * 0.6;
      const drive = 1.4 + 2 * p;
      const swell = 0.6 + 0.4 * lfo;
      const droneL = soft(this.droneLp[0].run(chord) * drive) * swell;
      const droneR = soft(this.droneLp[1].run(chord) * drive) * swell;

      // --- roar ---
      const roarIn = this.roarBp.run(n.next()) * (0.08 + 0.9 * Math.pow(p, 1.6)) * (0.75 + 0.25 * lfo);
      const roarL = this.comb[0].run(roarIn);
      const roarR = this.comb[1].run(roarIn);

      // --- thrust whoosh when power rises; arcs at high power ---
      const rising = Math.max(0, t.power - prevPower) * sr * 0.4;
      this.thrust += (Math.min(1, rising) - this.thrust) * kThrust;
      const whoosh = this.thrustBp.run(n.next()) * this.thrust * 0.6;
      if (n.unit() < (1 + 12 * p * p) / sr) this.arcEnv = 0.4 + 0.6 * n.unit();
      this.arcEnv *= 0.9985;
      const arc = this.arcHp.run(n.next() * this.arcEnv) * 0.18;

      // --- engine mix, then the flanger swirl ---
      const level = (0.32 + 0.68 * p) * g;
      const engL = ((droneL * 0.55 + sub * swell) * 0.8 + roarL * 1.1) * level + (whoosh + arc) * g;
      const engR = ((droneR * 0.55 + sub * swell) * 0.8 + roarR * 1.1) * level + (whoosh * 0.9 + arc * 0.7) * g;
      this.flangePhase += (0.09 + 0.25 * p) / sr;
      if (this.flangePhase >= 1) this.flangePhase -= 1;
      const msL = 1.2 + 4.5 * (0.5 + 0.5 * sinCycles(this.flangePhase));
      const msR = 1.2 + 4.5 * (0.5 + 0.5 * sinCycles(this.flangePhase + 0.25));
      let L = engL + this.flanger[0].run(engL, (msL * sr) / 1000, 0.55) * 0.8;
      let R = engR + this.flanger[1].run(engR, (msR * sr) / 1000, 0.55) * 0.8;

      // --- shimmer, mostly sent to the reverb ---
      this.shimBoost *= 0.99997;
      let shim = 0;
      const shimLevel = (0.012 + 0.03 * p + 0.05 * this.shimBoost) * g;
      for (let k = 0; k < SHIMMER.length; k++) {
        this.shimVib[k] += (0.13 + 0.07 * k) / sr;
        const f = SHIMMER[k] * (1 + 0.005 * sinCycles(this.shimVib[k]));
        this.shimPhase[k] += f / sr;
        if (this.shimPhase[k] >= 1) this.shimPhase[k] -= 1;
        shim += sinCycles(this.shimPhase[k]) * (0.6 + 0.4 * sinCycles(this.shimVib[k] * 0.7 + k * 0.3));
      }
      shim *= shimLevel;

      // --- events ---
      let ev = 0;
      // Charging tone while the reactor boots.
      if (!running && this.boot > 0.001 && this.boot < 0.999) {
        const fc = 40 + 600 * this.boot * this.boot;
        if ((i & 31) === 0) this.chargeBp.bandpass(sr, fc * 3, 6);
        ev += this.chargeBp.run(this.charge.run(fc / sr)) * 1.4 * Math.sqrt(this.boot);
      }
      // Hyperdrive failing: charge, cut, clunk, three times.
      if (this.sputterT < SPUTTER_TIME) {
        const stage = Math.floor(this.sputterT / 0.5);
        const k = (this.sputterT - stage * 0.5) / 0.5;
        if (k < 0.7) {
          const f = 90 * Math.pow(2, (k / 0.7) * 2.5) * (1 + 0.06 * sinCycles(this.sputterT * 18));
          if ((i & 31) === 0) this.chargeBp.bandpass(sr, f * 4, 6);
          this.buzzPhase += 55 / sr;
          if (this.buzzPhase >= 1) this.buzzPhase -= 1;
          ev += this.chargeBp.run(this.charge.run(f / sr)) * 0.6 + (this.buzzPhase < 0.5 ? 0.04 : -0.04);
        } else if (this.sputterClunk !== stage) {
          this.sputterClunk = stage;
          this._clunk(0.7);
        }
        this.sputterT += dt;
      }
      // Hyperspace: charge, boom with a falling zap, then the whoosh.
      if (this.jumpT < JUMP_TIME) {
        const jt = this.jumpT;
        if (jt < JUMP_CHARGE) {
          const k = jt / JUMP_CHARGE;
          const f = 70 * Math.pow(2, k * 4.5);
          if ((i & 31) === 0) {
            this.jumpLp.lowpass(sr, Math.min(sr * 0.45, f * 2.5), 5);
            this.jumpNoiseBp.bandpass(sr, f * 2, 1.5);
          }
          const J = this.jumpSaws;
          const saws = J[0].run(f / sr) + J[1].run((f * 1.006) / sr) + J[2].run((f * 0.994) / sr);
          ev += this.jumpLp.run(saws) * 0.3 * Math.pow(k, 1.5) + this.jumpNoiseBp.run(n.next()) * 0.4 * k * k;
        } else if (jt - dt < JUMP_CHARGE) {
          this._boom(75, 28, 1.6, 1.0);
          this.zapEnv = 0.75;
          this.zapFreq = 1600;
          this.burstEnv = 0.9;
        }
        if (jt >= JUMP_CHARGE) {
          const k = (jt - JUMP_CHARGE) / (JUMP_TIME - JUMP_CHARGE);
          if ((i & 31) === 0) this.whooshBp.bandpass(sr, 3200 * Math.pow(250 / 3200, k), 0.9);
          ev += this.whooshBp.run(n.next()) * Math.pow(1 - k, 2) * 0.9;
        }
        this.jumpT += dt;
      }
      // Zap: a sawtooth falling fast in pitch.
      if (this.zapEnv > 1e-4) {
        this.zapFreq = Math.max(50, this.zapFreq * zapFall);
        if ((i & 31) === 0) this.zapLp.lowpass(sr, Math.min(sr * 0.45, this.zapFreq * 3), 2);
        ev += this.zapLp.run(this.zap.run(this.zapFreq / sr)) * this.zapEnv;
        this.zapEnv *= zapFade;
      }
      if (this.burstEnv > 1e-4) {
        ev += this.burstLp.run(n.next()) * this.burstEnv * 1.5;
        this.burstEnv *= burstFade;
      }
      // Boom: a sine falling in pitch.
      if (this.boomEnv > 1e-4) {
        this.boomFreq += (this.boomTo - this.boomFreq) * kBoom;
        this.boomPhase += this.boomFreq / sr;
        if (this.boomPhase >= 1) this.boomPhase -= 1;
        ev += sinCycles(this.boomPhase) * this.boomEnv;
        this.boomEnv *= this.boomDecay;
      }
      for (let k = 0; k < this.clunk.length; k++) ev += this.clunk[k].run() * 0.8;
      if (this.pfft > 1e-4) {
        ev += this.pfftHp.run(n.next() * this.pfft) * 0.5;
        this.pfft *= pfftFade;
      }

      // --- space ---
      this.reverb.run((L * 0.3 + shim + ev * 0.5) * 0.6, (R * 0.3 + shim + ev * 0.5) * 0.6);
      L += this.reverb.L * 1.4 + shim * 0.25 + ev;
      R += this.reverb.R * 1.4 + shim * 0.25 + ev;

      outL[i] = soft(this.dc[0].run(L * 0.3));
      outR[i] = soft(this.dc[1].run(R * 0.3));
    }
  }
}


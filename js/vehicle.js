/**
 * vehicle.js — virtual piston engines and their gearboxes.
 *
 * The real car only tells us how fast it is going and how hard it is
 * accelerating. From that, this model works out what the chosen drivetrain
 * would be doing: which gear it is in, engine RPM, how much throttle the
 * driver is giving, shift cuts and blips, overrun crackle, cranking and
 * shutdown. Everything here is plain math (no DOM, no audio) so it can be
 * unit-tested in Node.
 *
 * Three engines share the model, each described by a spec:
 *   FLAT6 — 4.0 L GT3 flat-six, 7-speed PDK (the default)
 *   V8    — 70s muscle-car V8, 3-speed automatic with a slipping torque converter
 *   MOTO  — 1000 cc superbike inline-four, 6-speed with quickshifter and autoblipper
 */

const TWO_PI = Math.PI * 2;
const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
/** Move `cur` toward `target` with time constant `tau` seconds. */
const approach = (cur, target, dt, tau) => (tau <= 0 ? target : cur + (target - cur) * (1 - Math.exp(-dt / tau)));

/**
 * What "flat out" means for the real car. The driver's pedal is estimated as
 * acceleration relative to what an average Tesla can do at that speed, so
 * flooring any Tesla sounds like full throttle.
 */
const PEDAL_REF = { maxAccel: 5.0, powerPerMass: 130 };

/** The GT3 flat-six. */
export const FLAT6 = {
  cylinders: 6,
  idleRpm: 950,
  limiterRpm: 9000,
  maxRpm: 9250,
  /** 992 GT3 PDK-style ratios and final drive. */
  gears: [3.75, 2.38, 1.72, 1.34, 1.11, 0.96, 0.84],
  finalDrive: 4.47,
  /** 315/30 ZR21 rear tyre. */
  wheelRadius: 0.361,
  pedalRef: PEDAL_REF,
  crank: { time: 0.85, catchTime: 0.62, flareRpm: 1350, coldRpm: 420, rpm: 220, wobble: 55 },
  revTau: 0.45, // revving in neutral climbs smoothly (~4 s to the limiter)
  upCut: true, // ignition cut on upshifts
  blip: true, // throttle blip on downshifts
  converter: 0, // torque-converter slip (rpm at full demand)
  softLimit: false, // false: the limiter stutters; true: the revs just stop climbing
  limiterDip: 260,
  ceiling: 8400, // never downshift into more than this
  crackleRpm: [2300, 4800],
  lights: [6000, 8700],
  modes: {
    comfort: {
      upMin: 2300, upMax: 7400, downMin: 1150, downMax: 3500, brakeDown: 2300,
      shiftUp: 0.24, shiftDown: 0.32, minGap: 0.6, liftHold: 1, launch: 1300, crackle: 0.3, exhaust: 0.3,
    },
    sport: {
      upMin: 3300, upMax: 8600, downMin: 1600, downMax: 5200, brakeDown: 3800,
      shiftUp: 0.15, shiftDown: 0.24, minGap: 0.38, liftHold: 4, launch: 2700, crackle: 0.8, exhaust: 1,
    },
    track: {
      upMin: 4600, upMax: 8850, downMin: 2500, downMax: 6300, brakeDown: 5000,
      shiftUp: 0.1, shiftDown: 0.2, minGap: 0.3, liftHold: 8, launch: 4000, crackle: 1, exhaust: 1,
    },
  },
};

/** A 1970 fastback's 351 V8 with a 3-speed automatic. */
export const V8 = {
  cylinders: 8,
  idleRpm: 650,
  limiterRpm: 5800,
  maxRpm: 6000,
  gears: [2.46, 1.46, 1.0],
  finalDrive: 3.5,
  wheelRadius: 0.33,
  pedalRef: PEDAL_REF,
  crank: { time: 1.25, catchTime: 0.95, flareRpm: 900, coldRpm: 450, rpm: 180, wobble: 50 },
  revTau: 0.55,
  upCut: false,
  blip: false,
  converter: 450,
  softLimit: true,
  limiterDip: 150,
  ceiling: 5200,
  crackleRpm: [1800, 3600],
  lights: [4300, 5600],
  modes: {
    comfort: {
      upMin: 1500, upMax: 3800, downMin: 800, downMax: 2200, brakeDown: 1300,
      shiftUp: 0.5, shiftDown: 0.45, minGap: 1.0, liftHold: 0.5, launch: 900, crackle: 0.25, exhaust: 0.55,
    },
    sport: {
      upMin: 1900, upMax: 5000, downMin: 950, downMax: 3000, brakeDown: 1800,
      shiftUp: 0.42, shiftDown: 0.38, minGap: 0.8, liftHold: 2, launch: 1500, crackle: 0.5, exhaust: 1,
    },
    track: {
      upMin: 2500, upMax: 5500, downMin: 1200, downMax: 3600, brakeDown: 2400,
      shiftUp: 0.35, shiftDown: 0.32, minGap: 0.6, liftHold: 4, launch: 2000, crackle: 0.7, exhaust: 1,
    },
  },
};

/** A 1000 cc superbike: inline-four to 14,000 rpm, 6-speed. Ratios include primary and final drive. */
export const MOTO = {
  cylinders: 4,
  idleRpm: 1300,
  limiterRpm: 14000,
  maxRpm: 14300,
  gears: [2.533, 2.063, 1.762, 1.522, 1.364, 1.269],
  finalDrive: 4.29,
  wheelRadius: 0.3,
  pedalRef: PEDAL_REF,
  crank: { time: 0.55, catchTime: 0.38, flareRpm: 2600, coldRpm: 700, rpm: 400, wobble: 80 },
  revTau: 0.28,
  upCut: true,
  blip: true,
  converter: 0,
  softLimit: false,
  limiterDip: 400,
  ceiling: 12500,
  crackleRpm: [4000, 8000],
  lights: [10500, 13500],
  modes: {
    comfort: {
      upMin: 4500, upMax: 9500, downMin: 2600, downMax: 6000, brakeDown: 4000,
      shiftUp: 0.12, shiftDown: 0.2, minGap: 0.5, liftHold: 1, launch: 2500, crackle: 0.4, exhaust: 0.5,
    },
    sport: {
      upMin: 6500, upMax: 12800, downMin: 3500, downMax: 8500, brakeDown: 6500,
      shiftUp: 0.07, shiftDown: 0.16, minGap: 0.3, liftHold: 4, launch: 4500, crackle: 0.8, exhaust: 1,
    },
    track: {
      upMin: 8500, upMax: 13600, downMin: 5000, downMax: 10000, brakeDown: 8000,
      shiftUp: 0.05, shiftDown: 0.14, minGap: 0.25, liftHold: 8, launch: 6500, crackle: 1, exhaust: 1,
    },
  },
};

/** The flat-six, under its historical name. */
export const ENGINE = FLAT6;
export const MODES = FLAT6.modes;

/** Engine RPM for road speed `v` (m/s) in `gear` (1-based) with the clutch locked. */
export function rpmAtSpeed(v, gear, spec = FLAT6) {
  const wheelRps = v / (TWO_PI * spec.wheelRadius);
  return wheelRps * 60 * spec.gears[gear - 1] * spec.finalDrive;
}

/** Driving resistance (rolling + aero) of a typical car, as deceleration in m/s². */
export function resistanceAccel(v) {
  return 0.12 + 0.00027 * v * v;
}

/**
 * Estimated pedal position (can be negative when braking or regenerating):
 * the acceleration we see, plus what it takes to overcome drag, divided by
 * what the car could do at this speed.
 */
export function pedalEstimate(v, a) {
  const { maxAccel, powerPerMass } = PEDAL_REF;
  const available = Math.min(maxAccel, powerPerMass / Math.max(v, 1));
  return (a + resistanceAccel(v)) / available;
}

export class Vehicle {
  constructor(spec = FLAT6) {
    this.spec = spec;
    this.kind = 'piston';
    this.setMode('sport');
    this.state = 'off'; // off | cranking | running | stopping
    this.stateTime = 0;
    this.rpm = 0;
    this.gear = 1;
    this.neutral = true;
    this.load = 0; // combustion load sent to the synth, 0..1
    this.pedal = 0; // smoothed driver demand, roughly -1..1
    this.shiftPedal = 0; // slower version used to pick gears
    this.overrun = 0; // closed-throttle crackle intensity, 0..1
    this.cut = false; // ignition cut (upshift or limiter)
    this.shift = null;
    this.sinceShift = 10;
    this.lastShiftUp = false;
    this.upHold = 0;
    this.downHold = 0;
    this.liftEnergy = 0;
    this.liftTime = 0;
    this.limiterTimer = 0;
    this.coldBoost = 0;
    this.flare = 0;
    this.crankPhase = 0;
    this.prevLoadRaw = 0;
    this.idlePhase = 0;
    /** Discrete events since the last read: 'start', 'stop', 'up', 'down'. */
    this.events = [];
  }

  setMode(name) {
    const modes = this.spec.modes;
    this.modeName = modes[name] ? name : 'sport';
    this.mode = modes[this.modeName];
  }

  get running() {
    return this.state === 'running';
  }

  get on() {
    return this.state === 'running' || this.state === 'cranking';
  }

  start() {
    if (this.state === 'off' || this.state === 'stopping') {
      this.state = 'cranking';
      this.stateTime = 0;
      this.events.push('start');
    }
  }

  stop() {
    if (this.state === 'running' || this.state === 'cranking') {
      this.state = 'stopping';
      this.stateTime = 0;
      this.shift = null;
      this.events.push('stop');
    }
  }

  toggle() {
    if (this.on) this.stop();
    else this.start();
  }

  /** Read and clear pending events. */
  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  rpmAt(v, gear) {
    return rpmAtSpeed(v, gear, this.spec);
  }

  /**
   * Advance the model.
   * @param {number} dt seconds
   * @param {{speed:number, accel:number, rev?:number}} input
   *   speed m/s, longitudinal accel m/s², rev 0..1 (free-rev button, only when stopped)
   */
  update(dt, input) {
    dt = clamp(dt, 0, 0.1);
    this.stateTime += dt;
    this.cut = false;

    switch (this.state) {
      case 'off':
        this.rpm = approach(this.rpm, 0, dt, 0.1);
        this.load = 0;
        this.overrun = 0;
        break;
      case 'cranking':
        this._crank(dt);
        break;
      case 'running':
        this._run(dt, input);
        break;
      case 'stopping':
        this.load = 0;
        this.overrun = 0;
        this.rpm = Math.max(0, this.rpm - (this.rpm * 2.6 + 260) * dt);
        if (this.rpm <= 1) {
          this.rpm = 0;
          this.state = 'off';
          this.stateTime = 0;
        }
        break;
    }
    return this.output();
  }

  output() {
    const cranking = this.state === 'cranking';
    return {
      state: this.state,
      rpm: this.rpm,
      gear: this.gear,
      neutral: this.neutral,
      load: this.load,
      overrun: this.overrun,
      cut: this.cut,
      ignition: this.state === 'running' || (cranking && this.stateTime > this.spec.crank.catchTime),
      starter: cranking,
      exhaust: this.mode.exhaust + (1 - this.mode.exhaust) * smoothstep(0.35, 0.75, this.load),
      crackle: this.mode.crackle,
      cold: this.coldBoost / this.spec.crank.coldRpm, // 1 just after starting, fades to 0
      shifting: !!this.shift,
      pedal: this.pedal,
    };
  }

  /** What the synth needs (see PistonSynth.setParams). `pops` scales the crackle. */
  synthParams({ pops = 1 } = {}) {
    const o = this.output();
    return {
      rpm: o.rpm,
      load: o.load,
      overrun: o.overrun,
      cut: o.cut ? 1 : 0,
      ignition: o.ignition ? 1 : 0,
      starter: o.starter ? 1 : 0,
      crackle: o.crackle * pops,
      exhaust: o.exhaust,
      cold: o.cold,
    };
  }

  /** What the dashboard shows. */
  display() {
    const s = this.spec;
    const off = this.state === 'off' || this.state === 'cranking';
    const running = this.state === 'running' || this.state === 'cranking';
    const rpmN = Math.min(1, this.rpm / s.limiterRpm);
    const shake = running ? 1.4 * (1 - rpmN) + 0.7 * this.load + (this.state === 'cranking' ? 1.2 : 0) : 0;
    return {
      state: this.state,
      value: this.rpm,
      gear: off ? '–' : this.neutral ? 'N' : String(this.gear),
      word: false,
      readout: `${(Math.round(this.rpm / 50) * 50).toLocaleString('en-US')} rpm`,
      load: this.load,
      regen: Math.min(1, Math.max(0, this.overrun, this.pedal < 0 ? -this.pedal : 0)),
      shake,
      shakeHz: Math.max(this.rpm, 200) / 120,
      glow: 0,
      shifting: !!this.shift,
    };
  }

  // ---- states ----

  _crank(dt) {
    const c = this.spec.crank;
    // The starter turns the engine slowly; it slows on every compression
    // stroke and speeds up between them (the "rrr-rrr-rrr").
    this.crankPhase += (dt * Math.max(this.rpm, 120) * this.spec.cylinders) / 120;
    const wobble = c.wobble * Math.sin(this.crankPhase * TWO_PI);
    const spin = Math.min(1, this.stateTime / 0.12); // starter spinning up
    this.rpm = approach(this.rpm, (c.rpm + wobble) * spin, dt, 0.04);
    this.load = this.stateTime > c.catchTime ? 0.7 : 0;
    this.gear = 1;
    this.neutral = true;
    if (this.stateTime >= c.time) {
      this.state = 'running';
      this.stateTime = 0;
      this.flare = 1; // revs flare up after the engine catches
      this.coldBoost = c.coldRpm; // then settle to a high cold idle that drops off
    }
  }

  _run(dt, input) {
    const m = this.mode;
    const s = this.spec;
    const v = Math.max(0, Number.isFinite(input.speed) ? input.speed : 0);
    const a = Number.isFinite(input.accel) ? input.accel : 0;
    const rev = clamp(input.rev || 0, 0, 1);

    this.flare = approach(this.flare, 0, dt, 0.45);
    this.coldBoost = approach(this.coldBoost, 0, dt, 12);
    this.idlePhase += dt * 0.7;
    // A cold engine hunts a little more around its idle speed.
    const hunt = (12 + 25 * (this.coldBoost / s.crank.coldRpm)) * Math.sin(this.idlePhase * TWO_PI);
    const idleRpm = s.idleRpm + this.coldBoost + this.flare * s.crank.flareRpm + hunt;

    // Driver demand from the real car's motion.
    const pedalRaw = clamp(pedalEstimate(v, a), -1.5, 1.5);
    this.pedal = approach(this.pedal, pedalRaw, dt, pedalRaw > this.pedal ? 0.06 : 0.1);
    this.shiftPedal = approach(this.shiftPedal, pedalRaw, dt, 0.35);
    const dem = clamp(this.pedal, 0, 1);
    const decel = clamp((-a - 0.4) / 3, 0, 1);
    this.liftTime = this.pedal < 0.05 ? this.liftTime + dt : 0;

    let target;
    let rpmTau;
    let loadRaw = clamp(this.pedal, 0, 1);

    const stopped = v < 0.6;
    this.neutral = stopped && rev > 0.01;

    if (stopped && (rev > 0.01 || a < 0.4)) {
      // Standing still: idle, or free-rev in neutral with the REV button.
      this.gear = 1;
      this.shift = null;
      target = idleRpm + rev * (s.limiterRpm + 300 - idleRpm);
      // Just after catching the revs shoot up fast, driven hard: the start-up bark.
      // Revving in neutral climbs smoothly; the start-up flare is quick.
      rpmTau = target > this.rpm ? (this.flare > 0.5 ? 0.09 : rev > 0.01 ? s.revTau : 0.2) : 0.45;
      loadRaw = rev > 0.01 ? 0.25 + 0.75 * rev : this.rpm > idleRpm + 500 ? 0 : 0.1;
      loadRaw = Math.max(loadRaw, 0.9 * Math.pow(this.flare, 1.5));
    } else {
      this._schedule(dt, v, decel);
      // A torque converter slips more the harder you push.
      const geared = this.rpmAt(v, this.gear) + s.converter * dem;
      const launchRpm = idleRpm + dem * m.launch;
      target = Math.max(geared, idleRpm);
      if (this.gear === 1 && geared < launchRpm) {
        target = launchRpm; // clutch slipping (or converter stall) during a launch
        loadRaw = Math.max(loadRaw, dem);
      }
      rpmTau = 0.07;
      // Cruising still needs a little throttle; only real deceleration is overrun.
      if (a > -0.6 && v > 1) loadRaw = Math.max(loadRaw, 0.1 + 0.08 * Math.min(1, v / 30));
    }

    // Shift in progress: ignition cut on upshifts, throttle blip on downshifts.
    if (this.shift) {
      const sh = this.shift;
      sh.t += dt;
      const p = sh.t / sh.dur;
      if (sh.up) {
        this.cut = s.upCut && p < 0.45;
        if (this.cut) loadRaw = 0;
        rpmTau = sh.dur * 0.3;
      } else {
        if (s.blip) {
          if (p < 0.65) loadRaw = Math.max(loadRaw, sh.blip);
          if (p < 0.5) target *= 1.03; // a blip overshoots slightly
        }
        rpmTau = sh.dur * 0.25;
      }
      if (sh.t >= sh.dur) {
        if (!sh.up && loadRaw < 0.05) this.liftEnergy = Math.max(this.liftEnergy, 0.7);
        this.shift = null;
      }
    }

    if (s.softLimit) {
      // No rev limiter, the engine just runs out of breath.
      if (target > s.limiterRpm) target = s.limiterRpm;
      if (this.rpm > s.limiterRpm - s.limiterDip) loadRaw *= 0.6;
    } else if (this.limiterTimer > 0) {
      // Rev limiter: short ignition cuts make the classic stutter.
      this.limiterTimer -= dt;
      this.cut = true;
      loadRaw = 0;
      target = Math.min(target, s.limiterRpm - s.limiterDip);
      rpmTau = 0.035;
    } else if (this.rpm >= s.limiterRpm) {
      this.limiterTimer = 0.05;
    }

    this.rpm = clamp(approach(this.rpm, target, dt, rpmTau), 0, s.maxRpm);
    this.load = approach(this.load, loadRaw, dt, loadRaw > this.load ? 0.035 : 0.08);

    // Overrun crackle: strongest right after lifting off at high revs.
    // (Ignition cuts have their own pops in the synth, so they don't count.)
    const closed = loadRaw < 0.03 && !this.cut;
    if (closed && this.prevLoadRaw > 0.3) this.liftEnergy = 1;
    this.liftEnergy *= Math.exp(-dt / 1.6);
    const revFactor = smoothstep(s.crackleRpm[0], s.crackleRpm[1], this.rpm);
    const crackleTarget = closed ? revFactor * (0.25 + 0.45 * decel + 0.55 * this.liftEnergy) : 0;
    this.overrun = approach(this.overrun, clamp(crackleTarget, 0, 1), dt, 0.05);
    if (!this.cut) this.prevLoadRaw = loadRaw;
  }

  /** Decide whether to change gear (shift map with hysteresis). */
  _schedule(dt, v, decel) {
    const m = this.mode;
    const gears = this.spec.gears.length;
    this.sinceShift += dt;
    if (this.shift) return;

    const g = this.gear;
    const cur = this.rpmAt(v, g);
    const d = clamp(this.shiftPedal, 0, 1);
    const upRpm = lerp(m.upMin, m.upMax, smoothstep(0.08, 0.85, d));
    let downRpm = lerp(m.downMin, m.downMax, smoothstep(0.15, 0.9, d));
    // Braking: drop gears earlier for engine braking and blips.
    if (decel > 0.1) downRpm = lerp(downRpm, Math.max(downRpm, m.brakeDown), smoothstep(0.1, 0.5, decel));

    // Just lifted off or slowing down: hold the gear for engine braking
    // (and crackle) instead of short-shifting, unless we're near the limiter.
    const holdGear = decel > 0.1 || (this.liftTime > 0 && this.liftTime < m.liftHold);

    let want = 0;
    if (g < gears && cur > upRpm && this.rpmAt(v, g + 1) > m.downMin + 150 && (!holdGear || cur > m.upMax)) {
      want = 1;
    } else if (g > 1 && cur < downRpm) {
      // Don't drop into a gear we'd immediately shift out of again. While
      // holding gears under braking, upshifts are off, so allow higher revs.
      const ceiling = holdGear ? m.upMax - 1200 * (this.spec.limiterRpm / 9000) : Math.min(upRpm - 200, this.spec.ceiling);
      if (this.rpmAt(v, g - 1) < ceiling) want = -1;
    }
    // Kickdown: big demand at low revs drops one or more gears at once.
    if (want === 0 && g > 1 && d > 0.7 && cur < 0.62 * upRpm) {
      let target = g;
      while (target > 1 && this.rpmAt(v, target - 1) < 0.88 * upRpm) target--;
      if (target < g) want = target - g;
    }

    this.upHold = want > 0 ? this.upHold + dt : 0;
    this.downHold = want < 0 ? this.downHold + dt : 0;

    if (want > 0 && this.upHold > 0.12 && this.sinceShift > m.minGap) {
      this._startShift(g + 1);
    } else if (want < 0) {
      const hold = want < -1 ? 0.05 : 0.15;
      // Right after an upshift, wait a little longer unless braking (no hunting).
      const gap = this.lastShiftUp && decel < 0.1 && want === -1 ? Math.max(m.minGap, 0.9) : m.minGap;
      if (this.downHold > hold && this.sinceShift > gap) this._startShift(g + want);
    }
  }

  _startShift(to) {
    const up = to > this.gear;
    const m = this.mode;
    this.shift = { up, t: 0, dur: up ? m.shiftUp : m.shiftDown, blip: 0.45 + 0.35 * m.crackle };
    this.gear = to;
    this.sinceShift = 0;
    this.lastShiftUp = up;
    this.upHold = 0;
    this.downHold = 0;
    this.events.push(up ? 'up' : 'down');
  }
}

/**
 * Shift-light state for the tach: how many of `count` LEDs are lit, and
 * whether they should flash (at the shift point).
 */
export function shiftLights(rpm, count = 10, start = 6000, end = 8700) {
  const lit = Math.round(clamp((rpm - start) / (end - start), 0, 1) * count);
  return { lit, flash: rpm >= end };
}

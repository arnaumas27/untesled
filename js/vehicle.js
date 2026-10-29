/**
 * vehicle.js — a virtual 4.0 L flat-six with a 7-speed dual-clutch gearbox.
 *
 * The real car only tells us how fast it is going and how hard it is
 * accelerating. From that, this model works out what a GT3-style drivetrain
 * would be doing: which gear it is in, engine RPM, how much throttle the
 * driver is giving, shift cuts and blips, overrun crackle, cranking and
 * shutdown. Everything here is plain math (no DOM, no audio) so it can be
 * unit-tested in Node.
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

export const ENGINE = {
  idleRpm: 950,
  limiterRpm: 9000,
  maxRpm: 9250,
  /** 992 GT3 PDK-style ratios and final drive. */
  gears: [3.75, 2.38, 1.72, 1.34, 1.11, 0.96, 0.84],
  finalDrive: 4.47,
  /** 315/30 ZR21 rear tyre. */
  wheelRadius: 0.361,
  /**
   * What "flat out" means for the real car. The driver's pedal is estimated as
   * acceleration relative to what an average Tesla can do at that speed, so
   * flooring any Tesla sounds like full throttle.
   */
  pedalRef: { maxAccel: 5.0, powerPerMass: 130 },
};

/** Gearbox and character presets. */
export const MODES = {
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
};

const GEARS = ENGINE.gears.length;
const CRANK_TIME = 0.85; // s of starter motor
const CATCH_TIME = 0.62; // s into cranking when the first cylinders fire
const FLARE_RPM = 1350; // how far the revs jump when a cold engine catches
const COLD_RPM = 420; // extra idle speed while cold

/** Engine RPM for road speed `v` (m/s) in `gear` (1-based) with the clutch locked. */
export function rpmAtSpeed(v, gear) {
  const wheelRps = v / (TWO_PI * ENGINE.wheelRadius);
  return wheelRps * 60 * ENGINE.gears[gear - 1] * ENGINE.finalDrive;
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
  const { maxAccel, powerPerMass } = ENGINE.pedalRef;
  const available = Math.min(maxAccel, powerPerMass / Math.max(v, 1));
  return (a + resistanceAccel(v)) / available;
}

export class Vehicle {
  constructor() {
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
    this.modeName = MODES[name] ? name : 'sport';
    this.mode = MODES[this.modeName];
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
      ignition: this.state === 'running' || (cranking && this.stateTime > CATCH_TIME),
      starter: cranking,
      exhaust: this.mode.exhaust + (1 - this.mode.exhaust) * smoothstep(0.35, 0.75, this.load),
      crackle: this.mode.crackle,
      cold: this.coldBoost / COLD_RPM, // 1 just after starting, fades to 0
      shifting: !!this.shift,
      pedal: this.pedal,
    };
  }

  // ---- states ----

  _crank(dt) {
    // The starter turns the engine at ~220 rpm; it slows on every compression
    // stroke and speeds up between them (the "rrr-rrr-rrr").
    this.crankPhase += (dt * Math.max(this.rpm, 120)) / 20;
    const wobble = 55 * Math.sin(this.crankPhase * TWO_PI);
    const spin = Math.min(1, this.stateTime / 0.12); // starter spinning up
    this.rpm = approach(this.rpm, (220 + wobble) * spin, dt, 0.04);
    this.load = this.stateTime > CATCH_TIME ? 0.7 : 0;
    this.gear = 1;
    this.neutral = true;
    if (this.stateTime >= CRANK_TIME) {
      this.state = 'running';
      this.stateTime = 0;
      this.flare = 1; // revs flare up after the engine catches
      this.coldBoost = COLD_RPM; // then settle to a high cold idle that drops off
    }
  }

  _run(dt, input) {
    const m = this.mode;
    const v = Math.max(0, Number.isFinite(input.speed) ? input.speed : 0);
    const a = Number.isFinite(input.accel) ? input.accel : 0;
    const rev = clamp(input.rev || 0, 0, 1);

    this.flare = approach(this.flare, 0, dt, 0.45);
    this.coldBoost = approach(this.coldBoost, 0, dt, 12);
    this.idlePhase += dt * 0.7;
    // A cold engine hunts a little more around its idle speed.
    const hunt = (12 + 25 * (this.coldBoost / COLD_RPM)) * Math.sin(this.idlePhase * TWO_PI);
    const idleRpm = ENGINE.idleRpm + this.coldBoost + this.flare * FLARE_RPM + hunt;

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
      target = idleRpm + rev * (ENGINE.limiterRpm + 300 - idleRpm);
      // Just after catching the revs shoot up fast, driven hard: the start-up bark.
      // Revving in neutral climbs smoothly (~3 s to the limiter); the start-up flare is quick.
      rpmTau = target > this.rpm ? (this.flare > 0.5 ? 0.09 : rev > 0.01 ? 0.45 : 0.2) : 0.45;
      loadRaw = rev > 0.01 ? 0.25 + 0.75 * rev : this.rpm > idleRpm + 500 ? 0 : 0.1;
      loadRaw = Math.max(loadRaw, 0.9 * Math.pow(this.flare, 1.5));
    } else {
      this._schedule(dt, v, decel);
      const geared = rpmAtSpeed(v, this.gear);
      const launchRpm = idleRpm + dem * m.launch;
      target = Math.max(geared, idleRpm);
      if (this.gear === 1 && geared < launchRpm) {
        target = launchRpm; // clutch slipping during a launch
        loadRaw = Math.max(loadRaw, dem);
      }
      rpmTau = 0.07;
      // Cruising still needs a little throttle; only real deceleration is overrun.
      if (a > -0.6 && v > 1) loadRaw = Math.max(loadRaw, 0.1 + 0.08 * Math.min(1, v / 30));
    }

    // Shift in progress: ignition cut on upshifts, throttle blip on downshifts.
    if (this.shift) {
      const s = this.shift;
      s.t += dt;
      const p = s.t / s.dur;
      if (s.up) {
        this.cut = p < 0.45;
        if (this.cut) loadRaw = 0;
        rpmTau = s.dur * 0.3;
      } else {
        if (p < 0.65) loadRaw = Math.max(loadRaw, s.blip);
        if (p < 0.5) target *= 1.03; // a blip overshoots slightly
        rpmTau = s.dur * 0.25;
      }
      if (s.t >= s.dur) {
        if (!s.up && loadRaw < 0.05) this.liftEnergy = Math.max(this.liftEnergy, 0.7);
        this.shift = null;
      }
    }

    // Rev limiter: short ignition cuts make the classic stutter.
    if (this.limiterTimer > 0) {
      this.limiterTimer -= dt;
      this.cut = true;
      loadRaw = 0;
      target = Math.min(target, ENGINE.limiterRpm - 260);
      rpmTau = 0.035;
    } else if (this.rpm >= ENGINE.limiterRpm) {
      this.limiterTimer = 0.05;
    }

    this.rpm = clamp(approach(this.rpm, target, dt, rpmTau), 0, ENGINE.maxRpm);
    this.load = approach(this.load, loadRaw, dt, loadRaw > this.load ? 0.035 : 0.08);

    // Overrun crackle: strongest right after lifting off at high revs.
    // (Ignition cuts have their own pops in the synth, so they don't count.)
    const closed = loadRaw < 0.03 && !this.cut;
    if (closed && this.prevLoadRaw > 0.3) this.liftEnergy = 1;
    this.liftEnergy *= Math.exp(-dt / 1.6);
    const revFactor = smoothstep(2300, 4800, this.rpm);
    const crackleTarget = closed ? revFactor * (0.25 + 0.45 * decel + 0.55 * this.liftEnergy) : 0;
    this.overrun = approach(this.overrun, clamp(crackleTarget, 0, 1), dt, 0.05);
    if (!this.cut) this.prevLoadRaw = loadRaw;
  }

  /** Decide whether to change gear (PDK-style shift map with hysteresis). */
  _schedule(dt, v, decel) {
    const m = this.mode;
    this.sinceShift += dt;
    if (this.shift) return;

    const g = this.gear;
    const cur = rpmAtSpeed(v, g);
    const d = clamp(this.shiftPedal, 0, 1);
    const upRpm = lerp(m.upMin, m.upMax, smoothstep(0.08, 0.85, d));
    let downRpm = lerp(m.downMin, m.downMax, smoothstep(0.15, 0.9, d));
    // Braking: drop gears earlier for engine braking and blips.
    if (decel > 0.1) downRpm = lerp(downRpm, Math.max(downRpm, m.brakeDown), smoothstep(0.1, 0.5, decel));

    // Just lifted off or slowing down: hold the gear for engine braking
    // (and crackle) instead of short-shifting, unless we're near the limiter.
    const holdGear = decel > 0.1 || (this.liftTime > 0 && this.liftTime < m.liftHold);

    let want = 0;
    if (g < GEARS && cur > upRpm && rpmAtSpeed(v, g + 1) > m.downMin + 150 && (!holdGear || cur > m.upMax)) {
      want = 1;
    } else if (g > 1 && cur < downRpm) {
      // Don't drop into a gear we'd immediately shift out of again. While
      // holding gears under braking, upshifts are off, so allow higher revs.
      const ceiling = holdGear ? m.upMax - 1200 : Math.min(upRpm - 200, 8400);
      if (rpmAtSpeed(v, g - 1) < ceiling) want = -1;
    }
    // Kickdown: big demand at low revs drops one or more gears at once.
    if (want === 0 && g > 1 && d > 0.7 && cur < 0.62 * upRpm) {
      let target = g;
      while (target > 1 && rpmAtSpeed(v, target - 1) < 0.88 * upRpm) target--;
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

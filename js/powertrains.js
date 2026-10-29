/**
 * powertrains.js — the non-piston "engines": a turbofan, a space freighter's
 * sublight drive and a horse. Like vehicle.js they turn the real car's speed
 * and acceleration into what the machine would be doing, with no DOM or audio
 * here. They share the Vehicle interface: start / stop / toggle / setMode /
 * update / synthParams / display / takeEvents.
 *
 * Events: besides 'start' and 'stop', some events are one-shot sounds the app
 * forwards to the synth as triggers (see TRIGGERS).
 */

import { pedalEstimate } from './vehicle.js';
import { GAITS } from './synth-carriage.js';

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const smoothstep = (e0, e1, x) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};
const approach = (cur, target, dt, tau) => (tau <= 0 ? target : cur + (target - cur) * (1 - Math.exp(-dt / tau)));

/** Event names that are one-shot sounds for the synth. */
export const TRIGGERS = new Set(['sputter', 'jump', 'whinny', 'snort', 'whip', 'stamp', 'jingle']);

/** Small seeded random generator (mulberry32), so behaviour is testable. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Shared state machine: off → cranking → running → stopping → off. */
class Machine {
  constructor(modes, seed) {
    this.modes = modes;
    this.setMode('sport');
    this.state = 'off';
    this.stateTime = 0;
    this.pedal = 0;
    this.events = [];
    this.random = rng(seed);
  }

  setMode(name) {
    this.modeName = this.modes[name] ? name : 'sport';
    this.mode = this.modes[this.modeName];
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
      this._started();
    }
  }

  stop() {
    if (this.state === 'running' || this.state === 'cranking') {
      this.state = 'stopping';
      this.stateTime = 0;
      this.events.push('stop');
      this._stopped();
    }
  }

  toggle() {
    if (this.on) this.stop();
    else this.start();
  }

  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  _started() {}

  _stopped() {}

  _go(state) {
    this.state = state;
    this.stateTime = 0;
  }

  /** Smoothed pedal from the car's motion (same estimate as the engines). */
  _pedal(dt, v, a) {
    const raw = clamp(pedalEstimate(v, a), -1.5, 1.5);
    this.pedal = approach(this.pedal, raw, dt, raw > this.pedal ? 0.06 : 0.1);
    return raw;
  }
}

// ---------------------------------------------------------------------------
// Turbofan
// ---------------------------------------------------------------------------

const IDLE_N1 = 0.22;
const IDLE_N2 = 0.6;
const LIGHT_OFF = 2.2; // s into the start when fuel is introduced
const STARTER_OFF = 4.0;
const START_TIME = 5.2;

/** A CFM56-style turbofan. N1 (fan) and N2 (core) are fractions of 100 %. */
export class Turbofan extends Machine {
  constructor() {
    super(
      {
        comfort: { up: 2.4, down: 1.8 },
        sport: { up: 1.6, down: 1.4 },
        track: { up: 0.9, down: 1.0 },
      },
      51,
    );
    this.kind = 'jet';
    this.n1 = 0;
    this.n2 = 0;
    this.fuel = false;
    this.starter = false;
    this.reverse = 0;
    this.reversing = false;
  }

  update(dt, input) {
    dt = clamp(dt, 0, 0.1);
    this.stateTime += dt;
    const v = Math.max(0, Number.isFinite(input.speed) ? input.speed : 0);
    const a = Number.isFinite(input.accel) ? input.accel : 0;
    const t = this.stateTime;

    switch (this.state) {
      case 'off':
        this.n1 = approach(this.n1, 0, dt, 3);
        this.n2 = approach(this.n2, 0, dt, 3);
        if (this.n2 < 0.002) this.n1 = this.n2 = 0;
        break;
      case 'cranking':
        // The air starter spins the core up; fuel and ignition at ~25 % N2,
        // then the engine accelerates itself to idle.
        this.starter = t < STARTER_OFF;
        this.fuel = t >= LIGHT_OFF;
        if (!this.fuel) this.n2 = Math.max(this.n2, 0.25 * smoothstep(0, LIGHT_OFF, t));
        else this.n2 = approach(this.n2, IDLE_N2, dt, 1.1);
        this.n1 = approach(this.n1, this.fuel ? IDLE_N1 : 0.06 * (this.n2 / 0.25), dt, 0.7);
        if (t >= START_TIME) this._go('running');
        break;
      case 'running': {
        this.starter = false;
        this.fuel = true;
        this._pedal(dt, v, a);
        let dem = clamp(this.pedal, 0, 1);
        const stopped = v < 0.6;
        if (stopped) dem = Math.max(dem, clamp(input.rev || 0, 0, 1));
        // Hard braking from speed: thrust reversers out.
        if (!this.reversing && v > 6 && a < -2.5) this.reversing = true;
        else if (this.reversing && (a > -1 || v < 3)) this.reversing = false;
        this.reverse = approach(this.reverse, this.reversing ? 1 : 0, dt, 0.35);
        const target = this.reversing ? 0.72 : IDLE_N1 + (1 - IDLE_N1) * Math.pow(dem, 0.85);
        // Spooling up from idle is famously slow; it quickens once the fan is turning.
        const tau = target > this.n1 ? this.mode.up * (this.n1 < 0.35 ? 1.3 : 1) : this.mode.down;
        this.n1 = approach(this.n1, target, dt, tau);
        const core = IDLE_N2 + (1 - IDLE_N2) * Math.pow(clamp((this.n1 - IDLE_N1) / (1 - IDLE_N1), 0, 1), 0.6);
        this.n2 = approach(this.n2, core, dt, 0.25);
        break;
      }
      case 'stopping':
        // Fuel cut: the flame goes out and the spools wind down for a while.
        this.fuel = false;
        this.starter = false;
        this.reverse = approach(this.reverse, 0, dt, 0.3);
        this.n1 = approach(this.n1, 0, dt, 3.2);
        this.n2 = approach(this.n2, 0, dt, 4);
        if (this.n2 < 0.01) {
          this.n1 = this.n2 = 0;
          this._go('off');
        }
        break;
    }
    return this.display();
  }

  _stopped() {
    this.reversing = false;
  }

  synthParams() {
    return { n1: this.n1, n2: this.n2, fuel: this.fuel ? 1 : 0, starter: this.starter ? 1 : 0, reverse: this.reverse };
  }

  display() {
    const n1 = this.n1;
    let gear = '–';
    if (this.state === 'cranking') gear = 'Start';
    else if (this.state === 'running') {
      if (this.reverse > 0.5) gear = 'Reverse';
      else if (n1 < 0.3) gear = 'Idle';
      else if (n1 < 0.6) gear = 'Taxi';
      else if (n1 < 0.86) gear = 'Climb';
      else gear = 'Takeoff';
    }
    return {
      state: this.state,
      value: n1 * 100,
      gear,
      word: true,
      readout: `N1 ${Math.round(n1 * 100)} %  ·  N2 ${Math.round(this.n2 * 100)} %`,
      load: clamp((n1 - IDLE_N1) / (1 - IDLE_N1), 0, 1) * (this.fuel ? 1 : 0),
      regen: this.reverse,
      shake: this.on || this.n2 > 0.05 ? 0.3 + 1.2 * n1 * n1 : 0,
      shakeHz: 23,
      glow: this.fuel ? clamp((n1 - 0.12) / 0.88, 0, 1) : 0,
      spin: n1,
      shifting: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Space freighter
// ---------------------------------------------------------------------------

const IDLE_POWER = 0.15;
const BOOT_TIME = 2.6;
const SPUTTER_DELAY = 1.6;
const JUMP_HOLD = 0.6; // s at (nearly) full power before the jump
const JUMP_TIME = 3.2;

/** Sublight engines: a power level, a temperamental start, and a hyperspace jump. */
export class Freighter extends Machine {
  constructor(seed = 1138) {
    super(
      {
        comfort: { up: 0.9, down: 1.2 },
        sport: { up: 0.5, down: 0.9 },
        track: { up: 0.3, down: 0.6 },
      },
      seed,
    );
    this.kind = 'freighter';
    this.power = 0;
    this.boot = 0;
    this.sputtered = false;
    this.bootDelay = 0;
    this.hold = 0;
    this.jumpT = 99;
    this.cooldown = 0;
  }

  _started() {
    // Now and then the hyperdrive doesn't catch at the first attempt.
    this.sputtered = this.random() < 0.35;
    this.bootDelay = this.sputtered ? SPUTTER_DELAY : 0;
    if (this.sputtered) this.events.push('sputter');
    this.boot = 0;
  }

  get jumping() {
    return this.jumpT < JUMP_TIME;
  }

  update(dt, input) {
    dt = clamp(dt, 0, 0.1);
    this.stateTime += dt;
    const v = Math.max(0, Number.isFinite(input.speed) ? input.speed : 0);
    const a = Number.isFinite(input.accel) ? input.accel : 0;
    const rev = clamp(input.rev || 0, 0, 1);
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.jumpT < JUMP_TIME) this.jumpT += dt;

    switch (this.state) {
      case 'off':
        this.power = approach(this.power, 0, dt, 0.6);
        break;
      case 'cranking': {
        const t = this.stateTime - this.bootDelay;
        this.boot = clamp(t / BOOT_TIME, 0, 1);
        this.power = approach(this.power, IDLE_POWER * this.boot, dt, 0.4);
        if (t >= BOOT_TIME) {
          this.boot = 1;
          this._go('running');
        }
        break;
      }
      case 'running': {
        this._pedal(dt, v, a);
        let dem = clamp(this.pedal, 0, 1);
        const stopped = v < 0.6;
        if (stopped) dem = Math.max(dem, rev);
        // Holding full power at a standstill: punch it.
        if (stopped && rev > 0.9 && this.power > 0.93 && !this.jumping && this.cooldown <= 0) {
          this.hold += dt;
          if (this.hold >= JUMP_HOLD) {
            this.events.push('jump');
            this.jumpT = 0;
            this.cooldown = 6;
            this.hold = 0;
          }
        } else {
          this.hold = 0;
        }
        let target = IDLE_POWER + (1 - IDLE_POWER) * dem;
        if (this.jumping) target = this.jumpT < 1.1 ? 1 : IDLE_POWER;
        const tau = target > this.power ? this.mode.up : this.jumping ? 0.5 : this.mode.down;
        this.power = approach(this.power, target, dt, tau);
        break;
      }
      case 'stopping':
        this.boot = 0;
        this.power = approach(this.power, 0, dt, 0.6);
        if (this.stateTime > 2.5) this._go('off');
        break;
    }
    return this.display();
  }

  synthParams() {
    return { power: this.power, on: this.state === 'running' ? 1 : 0, boot: this.state === 'running' ? 1 : this.state === 'cranking' ? this.boot : 0 };
  }

  display() {
    const p = this.power;
    let gear = '–';
    if (this.state === 'cranking') gear = this.boot > 0 ? 'Boot' : 'Fail';
    else if (this.state === 'running') gear = this.jumping ? 'Hyperspace' : p < 0.3 ? 'Idle' : 'Sublight';
    return {
      state: this.state,
      value: p * 100,
      gear,
      word: true,
      readout: `Power ${Math.round(p * 100)} %`,
      load: p,
      regen: 0,
      shake: this.state === 'running' ? 0.4 + 1.4 * p : this.state === 'cranking' ? 0.6 : 0,
      shakeHz: 7 + 9 * p,
      glow: this.state === 'stopping' || this.state === 'off' ? p : Math.max(p, 0.3 * this.boot),
      jump: this.jumping ? this.jumpT : null,
      shifting: false,
    };
  }
}

// ---------------------------------------------------------------------------
// Horse and carriage
// ---------------------------------------------------------------------------

// Speeds (m/s) for changing gait: up from gait i at UP[i], down from gait i+1 at DOWN[i].
const GAIT_UP = [0.5, 2.6, 5.3, 8.8];
const GAIT_DOWN = [0.3, 2.2, 4.6, 7.9];

/** Strides per second for a gait at speed v. */
export function strideRate(gait, v) {
  switch (gait) {
    case 1:
      return clamp(0.85 + 0.12 * v, 0.85, 1.2);
    case 2:
      return clamp(1.25 + 0.06 * (v - 2.2), 1.2, 1.5);
    case 3:
      return clamp(1.55 + 0.05 * (v - 4.6), 1.5, 1.8);
    case 4:
      return clamp(1.9 + 0.03 * (v - 8), 1.9, 2.7);
    default:
      return 1;
  }
}

/** A horse pulling a carriage: gait from speed, a whip when you floor it. */
export class Carriage extends Machine {
  constructor(seed = 1885) {
    super(
      {
        comfort: { whip: false, chatty: 0.5 },
        sport: { whip: true, chatty: 1 },
        track: { whip: true, chatty: 1.6 },
      },
      seed,
    );
    this.kind = 'carriage';
    this.gait = 0;
    this.stride = 1;
    this.speed = 0;
    this.squeal = 0;
    this.whipCooldown = 0;
    this.prevPedal = 0;
    this.idleTimer = 4;
    this.pawTimer = 0;
    this.reared = false;
    this.pending = []; // [seconds left, event]
    this.gallopTimer = 30;
    this.peakGait = 0;
  }

  _started() {
    this.events.push('whinny');
  }

  _stopped() {
    this.events.push('snort');
    this.pending = [];
  }

  _later(seconds, name) {
    this.pending.push([seconds, name]);
  }

  update(dt, input) {
    dt = clamp(dt, 0, 0.1);
    this.stateTime += dt;
    const v = Math.max(0, Number.isFinite(input.speed) ? input.speed : 0);
    const a = Number.isFinite(input.accel) ? input.accel : 0;
    const rev = clamp(input.rev || 0, 0, 1);
    this.whipCooldown = Math.max(0, this.whipCooldown - dt);

    for (let i = this.pending.length - 1; i >= 0; i--) {
      this.pending[i][0] -= dt;
      if (this.pending[i][0] <= 0) {
        this.events.push(this.pending[i][1]);
        this.pending.splice(i, 1);
      }
    }

    switch (this.state) {
      case 'off':
        this.gait = 0;
        this.speed = 0;
        this.squeal = 0;
        break;
      case 'cranking':
        // The horse is put to: a whinny, then off we go.
        this.gait = 0;
        if (this.stateTime > 1.4) this._go('running');
        break;
      case 'running':
        this._run(dt, v, a, rev);
        break;
      case 'stopping':
        this.gait = 0;
        this.squeal = 0;
        if (this.stateTime > 0.8) this._go('off');
        break;
    }
    return this.display();
  }

  _run(dt, v, a, rev) {
    const m = this.mode;
    const pedalRaw = this._pedal(dt, v, a);
    this.speed = v;

    // Gait from speed, with hysteresis so it doesn't flicker.
    let g = this.gait;
    while (g < 4 && v > GAIT_UP[g]) g++;
    while (g > 0 && v < GAIT_DOWN[g - 1]) g--;
    if (g > 0) this.peakGait = Math.max(this.peakGait, g);
    else if (this.gait > 0) {
      if (this.peakGait >= 2) this._later(0.7, 'snort'); // pulled up after a good run
      this.peakGait = 0;
    }
    this.gait = g;
    this.stride = approach(this.stride, strideRate(g || 1, v), dt, 0.4);

    // The coachman cracks the whip when you floor it.
    if (m.whip && pedalRaw > 0.6 && this.prevPedal <= 0.6 && v < 22 && this.whipCooldown <= 0) {
      this.events.push('whip');
      this.whipCooldown = 8;
      if (this.random() < 0.3 * m.chatty) this._later(0.5, 'whinny');
    }
    this.prevPedal = pedalRaw;

    // Hard braking: the wooden brake squeals against the iron tyre.
    this.squeal = v > 1.5 ? clamp((-a - 1.8) / 3, 0, 1) : 0;

    if (g === 0) {
      if (rev > 0.02) {
        // Holding the button: the horse paws the ground, then rears and whinnies.
        this.pawTimer -= dt;
        if (this.pawTimer <= 0) {
          this.events.push('stamp');
          this.pawTimer = 0.6 - 0.25 * rev;
        }
        if (rev > 0.85 && !this.reared) {
          this.events.push('whinny');
          this.reared = true;
        }
      } else {
        this.pawTimer = 0;
        // Waiting: a snort, a stamp or a shake of the head now and then.
        this.idleTimer -= dt * m.chatty;
        if (this.idleTimer <= 0) {
          const r = this.random();
          this.events.push(r < 0.35 ? 'snort' : r < 0.7 ? 'stamp' : 'jingle');
          this.idleTimer = 4 + 6 * this.random();
        }
      }
    } else if (g === 4) {
      this.gallopTimer -= dt * m.chatty;
      if (this.gallopTimer <= 0) {
        this.events.push('whinny');
        this.gallopTimer = 25 + 25 * this.random();
      }
    }
    if (rev < 0.1) this.reared = false;
  }

  synthParams() {
    const on = this.state === 'running' || this.state === 'cranking';
    return { on: on ? 1 : 0, gait: this.state === 'running' ? this.gait : 0, stride: this.stride, speed: on ? this.speed : 0, squeal: this.squeal };
  }

  display() {
    const moving = this.state === 'running' && this.gait > 0;
    let gear = '–';
    if (this.state === 'cranking') gear = 'Ready';
    else if (this.state === 'running') gear = GAITS[this.gait].name;
    return {
      state: this.state,
      value: moving ? this.stride * 60 : 0,
      gear,
      word: true,
      readout: moving ? `${Math.round(this.stride * 60)} strides/min` : this.state === 'running' ? 'Standing' : 'Resting',
      load: clamp(this.pedal, 0, 1),
      regen: this.squeal,
      shake: 0,
      shakeHz: 1,
      glow: this.on ? 1 : 0,
      gait: this.state === 'running' ? this.gait : 0,
      stride: this.stride,
      shifting: false,
    };
  }
}

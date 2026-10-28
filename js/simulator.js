/**
 * simulator.js — virtual pedals and a simple electric-car model, so the
 * engine can be tried without a car or a phone.
 *
 * The simulated car behaves like a typical Tesla (strong instant torque,
 * one-pedal regen when you lift), and its speed and acceleration go through
 * the same vehicle model as real driving.
 */

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);

export class Simulator {
  constructor() {
    this.v = 0; // m/s
    this.a = 0; // m/s²
    this.pointer = { throttle: 0, brake: 0 };
    this.keys = { throttle: 0, brake: 0 };
  }

  get throttle() {
    return Math.max(this.pointer.throttle, this.keys.throttle);
  }

  get brake() {
    return Math.max(this.pointer.brake, this.keys.brake);
  }

  reset() {
    this.v = 0;
    this.a = 0;
  }

  update(dt) {
    dt = clamp(dt, 0, 0.1);
    const m = 1850; // kg
    const v = this.v;
    const thr = this.throttle;
    const drive = thr * Math.min(m * 6.5, 250000 / Math.max(v, 0.1)); // traction / power limited
    const lift = clamp((0.12 - thr) / 0.12, 0, 1);
    const regen = v > 0.5 ? lift * Math.min(m * 1.4, 60000 / v) : 0;
    const brake = this.brake * m * 9;
    const drag = 0.5 * 1.2 * 0.51 * v * v + (v > 0.05 ? m * 9.81 * 0.011 : 0);
    let a = (drive - regen - brake - drag) / m;
    if (v <= 0 && a < 0) a = 0;
    // Motor torque doesn't change instantly.
    this.a += (a - this.a) * (1 - Math.exp(-dt / 0.08));
    this.v = Math.max(0, v + this.a * dt);
    if (this.v === 0 && this.a < 0) this.a = 0;
  }
}

/**
 * Make a pedal element drive `sim.pointer[kind]`. The deeper you press
 * (further down the pedal), the more throttle or brake.
 */
export function bindPedal(el, sim, kind) {
  let active = null;
  const depth = (e) => {
    const r = el.getBoundingClientRect();
    return clamp(0.35 + ((e.clientY - r.top) / r.height) * 0.75, 0.35, 1);
  };
  const set = (value) => {
    sim.pointer[kind] = value;
    el.style.setProperty('--depth', value.toFixed(3));
    el.classList.toggle('is-pressed', value > 0);
  };
  el.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    active = e.pointerId;
    el.setPointerCapture(e.pointerId);
    set(depth(e));
  });
  el.addEventListener('pointermove', (e) => {
    if (e.pointerId === active) set(depth(e));
  });
  const release = (e) => {
    if (e.pointerId !== active) return;
    active = null;
    set(0);
  };
  el.addEventListener('pointerup', release);
  el.addEventListener('pointercancel', release);
  el.addEventListener('lostpointercapture', release);
  // Keyboard access: hold Space/Enter on a focused pedal.
  el.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      set(1);
    }
  });
  el.addEventListener('keyup', (e) => {
    if (e.key === ' ' || e.key === 'Enter') set(0);
  });
}

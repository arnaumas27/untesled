/**
 * fusion.js — one smooth speed + acceleration estimate from the car's GPS and
 * the phone's accelerometer.
 *
 *  - GPS (≈1 Hz, ~1 s late) is trusted for absolute speed.
 *  - The phone (25 Hz, ~0.1 s late) is trusted for acceleration, which drives
 *    the throttle. Between GPS fixes, speed is integrated from it.
 *  - The phone can sit in any orientation. Gravity tells us which plane is
 *    horizontal; which way is *forward* in that plane is learned automatically
 *    by matching the phone's horizontal acceleration against the GPS speed
 *    changes (a small least-squares fit). Until then, a typical mount is
 *    assumed: upright with the screen facing the driver.
 *  - If the phone drops out, everything falls back to GPS only.
 *
 * Phone samples use the W3C DeviceMotion convention: `a` is the device's own
 * acceleration (gravity removed) and `g` the reaction to gravity, i.e. a
 * vector of ~9.81 m/s² pointing *up*, both in phone coordinates.
 */

const clamp = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const approach = (cur, target, dt, tau) => (tau <= 0 ? target : cur + (target - cur) * (1 - Math.exp(-dt / tau)));

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a) => {
  const n = len(a);
  return n > 1e-9 ? scale(a, 1 / n) : [0, 0, 1];
};
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const angleDeg = (a, b) => (Math.acos(clamp(dot(a, b), -1, 1)) * 180) / Math.PI;

const GPS_STALE_MS = 3500; // no fix for this long → GPS lost
const PHONE_STALE_MS = 600; // no motion for this long → phone lost
const GPS_LAG_MS = 300; // how much later GPS reports a change than the phone
const HISTORY_MS = 12000;

/**
 * Tracks the phone's mounting: gravity, a horizontal basis, and the forward
 * direction inside it.
 */
export class PhoneAxes {
  constructor() {
    this.epoch = 0;
    this.reset();
  }

  reset() {
    this.handledSince = null;
    this.remount = false;
    this.up = null; // fast-filtered up vector
    this.upSlow = null; // slow-filtered up vector
    this.basisUp = null; // up vector when the current basis was built
    this.refAxis = null; // phone axis projected to build the basis
    this.fwd = [1, 0]; // forward direction in the (e1, e2) basis
    this.calibrated = false;
    this.guessConfident = false;
    this.quality = 0;
    this.handling = false;
    this.history = [];
    this._resetFit();
  }

  _resetFit() {
    this.fit = { hh0: 0, hh1: 0, hh2: 0, hg0: 0, hg1: 0, gg: 0, strong: 0 };
  }

  /**
   * Add one motion sample. `rot` is the phone's mean rotation rate (deg/s)
   * over the sample window, if known. Returns horizontal accelerations, or
   * null while the phone is being handled.
   */
  add(t, a, g, rot) {
    const gn = len(g);
    if (gn < 4 || gn > 16) return null; // not a plausible gravity reading
    const upNow = scale(g, 1 / gn);

    this.up = this.up ? unit(mix(this.up, upNow, 0.25)) : upNow;
    this.upSlow = this.upSlow ? unit(mix(this.upSlow, upNow, 0.02)) : upNow;

    // Someone is moving the phone. With a gyro we can tell directly (it
    // spins); without one, fast and slow gravity estimates disagree.
    const handling = Number.isFinite(rot) ? rot > 80 : angleDeg(this.up, this.upSlow) > 12;
    if (handling) {
      if (this.handledSince == null) this.handledSince = t;
    } else if (this.handledSince != null) {
      if (t - this.handledSince > 300) this.remount = true; // put down somewhere new
      this.handledSince = null;
      this.upSlow = this.up.slice();
    }
    this.handling = handling;
    if (handling) return null;
    if (!this.basisUp || this.remount || angleDeg(this.up, this.basisUp) > 25) this._newBasis();

    const { e1, e2 } = this._basis();
    const h1 = dot(a, e1);
    const h2 = dot(a, e2);
    this.history.push({ t, h1, h2 });
    while (this.history.length && t - this.history[0].t > HISTORY_MS) this.history.shift();

    const [f1, f2] = this.fwd;
    return { long: f1 * h1 + f2 * h2, lat: -f2 * h1 + f1 * h2 };
  }

  _basis() {
    const up = this.up;
    const e1 = unit(sub(this.refAxis, scale(up, dot(this.refAxis, up))));
    const e2 = cross(up, e1);
    return { e1, e2 };
  }

  /** New mounting position: rebuild the basis and guess forward from orientation. */
  _newBasis() {
    const up = this.up;
    this.remount = false;
    const axes = [
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ];
    let ref = axes[0];
    for (const ax of axes) if (Math.abs(dot(ax, up)) < Math.abs(dot(ref, up))) ref = ax;
    this.refAxis = ref;
    this.basisUp = up.slice();

    // Typical mounts: upright in a holder with the screen facing the driver
    // (forward = behind the screen, -z), or lying flat with its top pointing
    // forward (+y). Upright is a safe bet; flat could just as well face back.
    const flat = Math.abs(up[2]) > 0.75;
    const d = flat ? [0, 1, 0] : [0, 0, -1];
    const { e1, e2 } = this._basis();
    const f = [dot(d, e1), dot(d, e2)];
    const n = Math.hypot(f[0], f[1]) || 1;
    this.fwd = [f[0] / n, f[1] / n];
    this.guessConfident = !flat;
    this.calibrated = false;
    this.quality = 0;
    this.history = [];
    this._resetFit();
    this.epoch++;
  }

  /** Mean horizontal phone acceleration over [from, to) (ms). */
  meanBetween(from, to) {
    let s1 = 0;
    let s2 = 0;
    let n = 0;
    for (const p of this.history) {
      if (p.t >= from && p.t < to) {
        s1 += p.h1;
        s2 += p.h2;
        n++;
      }
    }
    return n >= 4 ? [s1 / n, s2 / n] : null;
  }

  /**
   * Learn the forward direction from one GPS interval: the GPS saw the speed
   * change by `aGps` (m/s²) between t0 and t1; the phone's horizontal
   * acceleration over the same window must line up with it.
   */
  learn(t0, t1, aGps) {
    const H = this.meanBetween(t0 - GPS_LAG_MS, t1 - GPS_LAG_MS);
    if (!H) return;
    const f = this.fit;
    const lam = 0.97; // forget old intervals slowly (≈30 s memory)
    f.hh0 = lam * f.hh0 + H[0] * H[0];
    f.hh1 = lam * f.hh1 + H[0] * H[1];
    f.hh2 = lam * f.hh2 + H[1] * H[1];
    f.hg0 = lam * f.hg0 + H[0] * aGps;
    f.hg1 = lam * f.hg1 + H[1] * aGps;
    f.gg = lam * f.gg + aGps * aGps;
    if (Math.abs(aGps) > 0.6) f.strong++;

    // Solve the 2×2 least-squares system  [hh] · fwd = [hg].
    const det = f.hh0 * f.hh2 - f.hh1 * f.hh1;
    if (f.strong < 3 || f.gg < 1.5 || det < 1e-4) return;
    const x = (f.hh2 * f.hg0 - f.hh1 * f.hg1) / det;
    const y = (f.hh0 * f.hg1 - f.hh1 * f.hg0) / det;
    const mag = Math.hypot(x, y);
    if (mag < 0.3 || mag > 3) return;
    const explained = x * f.hg0 + y * f.hg1;
    this.quality = explained > 0 ? Math.sqrt(clamp(explained / f.gg, 0, 1)) : 0;
    if (this.quality > 0.6) {
      this.fwd = [x / mag, y / mag];
      this.calibrated = true;
    } else if (this.calibrated && this.quality < 0.3 && f.strong > 12) {
      this.calibrated = false; // the phone was probably turned: learn again
    }
  }
}

export class Fusion {
  constructor() {
    this.axes = new PhoneAxes();
    this.gps = { v: null, t: -Infinity, a: 0, fixes: 0 };
    this.phone = { t: -Infinity, long: 0, lat: 0, stable: false };
    this.bias = 0;
    this.v = 0; // fused speed, m/s
    this.a = 0; // fused longitudinal acceleration, m/s²
    this.lat = 0; // lateral acceleration (left positive), m/s²
    this.source = 'none';
    this.lastT = null;
    this.vHist = [];
    this.sim = null; // {v, a} when the simulator drives
  }

  /** Simulator mode: speed and acceleration come straight from the sim. */
  setSim(on) {
    this.sim = on ? { v: 0, a: 0 } : null;
    if (!on) this.v = this.gps.v ?? 0;
  }

  addSim(v, a) {
    if (this.sim) {
      this.sim.v = v;
      this.sim.a = a;
    }
  }

  /** @param {{t:number, speed:number|null}} fix  t = performance.now() ms */
  addGps({ t, speed }) {
    if (speed == null || !Number.isFinite(speed)) return;
    speed = clamp(speed, 0, 120);
    const g = this.gps;

    if (g.v != null) {
      const dt = (t - g.t) / 1000;
      if (dt > 0.25 && dt < 3) {
        const aRaw = (speed - g.v) / dt;
        g.a = g.fixes > 1 ? g.a * 0.4 + aRaw * 0.6 : aRaw;
        this.axes.learn(g.t, t, aRaw);
        this._learnBias(g.t, t, aRaw);
      }
    }

    // Correct the running estimate, comparing with what we believed back
    // when the GPS measurement was actually taken.
    if (g.v == null) {
      this.v = speed;
    } else {
      const err = speed - this._speedAt(t - GPS_LAG_MS);
      const k = this._phoneUsable(t) ? 0.35 : 0.65;
      this.v = Math.max(0, this.v + k * err);
    }
    g.v = speed;
    g.t = t;
    g.fixes++;
  }

  /** @param {{t:number, a:number[], g:number[], rot?:number}} s  t = performance.now() ms */
  addPhone({ t, a, g, rot }) {
    const res = this.axes.add(t, a, g, rot);
    this.phone.t = t;
    this.phone.stable = !!res;
    if (res) {
      this.phone.long = res.long;
      this.phone.lat = res.lat;
    }
  }

  _phoneLive(t) {
    return t - this.phone.t < PHONE_STALE_MS && this.phone.stable;
  }

  _phoneUsable(t) {
    return this._phoneLive(t) && (this.axes.calibrated || this.axes.guessConfident);
  }

  _learnBias(t0, t1, aGps) {
    if (!this.axes.calibrated) return;
    const H = this.axes.meanBetween(t0 - GPS_LAG_MS, t1 - GPS_LAG_MS);
    if (!H) return;
    const [f1, f2] = this.axes.fwd;
    const err = f1 * H[0] + f2 * H[1] - aGps;
    this.bias = clamp(this.bias + 0.04 * (err - this.bias), -1, 1);
  }

  _speedAt(t) {
    for (let i = this.vHist.length - 1; i >= 0; i--) if (this.vHist[i].t <= t) return this.vHist[i].v;
    return this.vHist.length ? this.vHist[0].v : this.v;
  }

  /** Advance the estimate to time t (performance.now() ms). */
  update(t) {
    const dt = this.lastT == null ? 0 : clamp((t - this.lastT) / 1000, 0, 0.1);
    this.lastT = t;

    if (this.sim) {
      this.v = this.sim.v;
      this.a = this.sim.a;
      this.lat = 0;
      this.source = 'sim';
      return this.state(t);
    }

    const gpsFresh = t - this.gps.t < GPS_STALE_MS;
    const phoneLive = this._phoneLive(t);
    const phoneUsable = this._phoneUsable(t);

    let aTarget = 0;
    if (phoneUsable) {
      aTarget = this.phone.long - this.bias;
      this.source = gpsFresh ? 'phone+gps' : 'phone';
    } else if (gpsFresh) {
      // Extrapolate the last GPS acceleration, fading it out between fixes.
      aTarget = this.gps.a * Math.exp(-(t - this.gps.t) / 1200);
      this.source = 'gps';
    } else {
      this.source = 'none';
    }
    this.a = approach(this.a, aTarget, dt, phoneUsable ? 0.05 : 0.25);

    if (gpsFresh || phoneUsable) this.v = Math.max(0, this.v + this.a * dt);
    // Without GPS we cannot observe speed, so let the estimate relax.
    if (!gpsFresh) this.v *= Math.exp(-dt / (phoneUsable ? 25 : 6));
    // Standing still: GPS reads ~0 and the phone feels no push.
    if (gpsFresh && this.gps.v < 0.4 && (!phoneUsable || Math.abs(aTarget) < 0.3)) {
      this.v = approach(this.v, 0, dt, 0.3);
    }

    this.lat = phoneLive ? approach(this.lat, this.phone.lat, dt, 0.08) : approach(this.lat, 0, dt, 0.3);

    this.vHist.push({ t, v: this.v });
    while (this.vHist.length && t - this.vHist[0].t > 3000) this.vHist.shift();
    return this.state(t);
  }

  state(t) {
    const phoneLive = this._phoneLive(t);
    let calibration = 'none';
    if (this.sim) calibration = 'sim';
    else if (phoneLive) calibration = this.axes.calibrated ? 'ok' : this.axes.guessConfident ? 'guess' : 'learning';
    return {
      speed: this.v,
      accel: this.a,
      lateral: this.lat,
      source: this.source,
      calibration,
      quality: this.axes.quality,
      gpsFresh: t - this.gps.t < GPS_STALE_MS,
      phoneLive,
    };
  }
}

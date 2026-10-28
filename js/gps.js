/**
 * gps.js — speed from the browser's geolocation (the car's own GPS on a Tesla).
 *
 * Uses the Doppler speed the GPS reports when available, otherwise derives it
 * from the distance between recent fixes.
 */

const EARTH_RADIUS = 6371000;
const STALE_MS = 4000;

function distance(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.min(1, Math.sqrt(h)));
}

export class GpsTracker {
  /**
   * @param {(fix: {t:number, speed:number, lagMs:number, accuracy:number, source:string}) => void} onFix
   *   lagMs: how far in the past the reported speed applies.
   */
  constructor(onFix) {
    this.onFix = onFix;
    this.status = 'off'; // off | waiting | ok | denied | unavailable | insecure
    this.watchId = null;
    this.recent = []; // last few raw fixes for derived speed
    this.lastFixAt = -Infinity;
    this.hz = 0;
    this.accuracy = null;
    this.speedSource = null;
    this.lastSpeed = null;
    this._intervals = [];
  }

  start() {
    if (this.watchId != null) return;
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      this.status = 'insecure';
      return;
    }
    if (!('geolocation' in navigator)) {
      this.status = 'unavailable';
      return;
    }
    this.status = 'waiting';
    this.watchId = navigator.geolocation.watchPosition(
      (pos) => this._position(pos),
      (err) => this._error(err),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 },
    );
  }

  stop() {
    if (this.watchId != null) navigator.geolocation.clearWatch(this.watchId);
    this.watchId = null;
    this.status = 'off';
  }

  getState(now = performance.now()) {
    let status = this.status;
    const stale = now - this.lastFixAt > STALE_MS;
    // Browsers often only report when the position changes, so silence while
    // standing still is normal. Silence while moving means the signal is gone.
    if (status === 'ok' && stale && !(this.lastSpeed < 1)) status = 'lost';
    return { status, hz: stale ? 0 : this.hz, accuracy: this.accuracy, source: this.speedSource, still: stale };
  }

  _position(pos) {
    const now = performance.now();
    const c = pos.coords;
    const fix = { t: pos.timestamp || Date.now(), lat: c.latitude, lon: c.longitude, accuracy: c.accuracy || 50 };

    if (this.lastFixAt > -Infinity) {
      this._intervals.push(now - this.lastFixAt);
      if (this._intervals.length > 5) this._intervals.shift();
      const mean = this._intervals.reduce((s, x) => s + x, 0) / this._intervals.length;
      this.hz = mean > 0 ? 1000 / mean : 0;
    }
    this.lastFixAt = now;
    this.status = 'ok';
    this.accuracy = c.accuracy;

    let speed = null;
    let lagMs = 300; // receivers report Doppler speed slightly late
    if (typeof c.speed === 'number' && Number.isFinite(c.speed) && c.speed >= 0) {
      speed = c.speed;
      this.speedSource = 'gps';
    } else {
      const derived = this._derivedSpeed(fix);
      speed = derived.speed;
      lagMs = derived.lagMs;
      this.speedSource = 'position';
    }
    if (speed != null) {
      this.lastSpeed = speed;
      this.onFix({ t: now, speed, lagMs, accuracy: c.accuracy, source: this.speedSource });
    }
  }

  /**
   * Average speed over the last few fixes; noise inside the accuracy circle
   * reads as 0. It describes the middle of that window, hence the lag.
   */
  _derivedSpeed(fix) {
    this.recent.push(fix);
    while (this.recent.length > 3) this.recent.shift();
    // A single fix can't show movement; browsers only report again once the
    // position changes, so until then assume we're standing still.
    if (this.recent.length < 2) return { speed: 0, lagMs: 300 };
    const first = this.recent[0];
    const dt = (fix.t - first.t) / 1000;
    if (dt < 0.4 || dt > 15) return { speed: null, lagMs: 0 };
    let path = 0;
    for (let i = 1; i < this.recent.length; i++) path += distance(this.recent[i - 1], this.recent[i]);
    const lagMs = 300 + (dt * 1000) / 2;
    const straight = distance(first, fix);
    const jitter = Math.max(first.accuracy, fix.accuracy) * 0.5;
    if (straight < jitter && path / dt < 2) return { speed: 0, lagMs };
    return { speed: path / dt, lagMs };
  }

  _error(err) {
    if (err.code === 1) {
      this.status = 'denied';
    } else if (err.code === 2) {
      if (this.status !== 'ok') this.status = 'unavailable';
    } else if (err.code === 3 && this.status === 'waiting') {
      // Timed out waiting for a first fix: keep trying.
      this.stop();
      this.start();
    }
  }
}

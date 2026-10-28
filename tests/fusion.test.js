import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Fusion } from '../js/fusion.js';

/** Rotation matrix from yaw/pitch/roll in degrees (car frame → phone frame). */
function rotation(yaw, pitch, roll) {
  const r = (d) => (d * Math.PI) / 180;
  const [cy, sy, cp, sp, cr, sr] = [Math.cos(r(yaw)), Math.sin(r(yaw)), Math.cos(r(pitch)), Math.sin(r(pitch)), Math.cos(r(roll)), Math.sin(r(roll))];
  const Rz = [[cy, -sy, 0], [sy, cy, 0], [0, 0, 1]];
  const Ry = [[cp, 0, sp], [0, 1, 0], [-sp, 0, cp]];
  const Rx = [[1, 0, 0], [0, cr, -sr], [0, sr, cr]];
  const mul = (A, B) => A.map((row, i) => B[0].map((_, j) => row.reduce((s, _, k) => s + A[i][k] * B[k][j], 0)));
  return mul(mul(Rz, Ry), Rx);
}
const apply = (M, v) => M.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2]);
const transpose = (M) => M[0].map((_, j) => M.map((row) => row[j]));

/**
 * Build a phone mount: `toPhone` maps car-frame vectors (x forward, y left,
 * z up) into phone axes (x right, y top, z out of the screen).
 */
function mount(kind, yawDeg = 0) {
  // Upright portrait, screen facing the driver: phone x = car right, y = up, z = back.
  const upright = [[0, -1, 0], [0, 0, 1], [-1, 0, 0]];
  // Flat, screen up, top of phone pointing backwards: x = car left, y = back, z = up.
  const flatBack = [[0, 1, 0], [-1, 0, 0], [0, 0, 1]];
  const base = kind === 'upright' ? upright : flatBack;
  const yaw = rotation(yawDeg, 4, -3); // a slightly crooked mount
  const M = base.map((row) => apply(transpose(yaw), row));
  return (v) => apply(M, v);
}

let seed = 7;
const noise = (s) => {
  seed = (seed * 16807) % 2147483647;
  return ((seed / 2147483647) * 2 - 1) * s;
};

/** Drive a stop-and-go loop and feed the fusion like the real app does. */
function simulate(fusion, toPhone, seconds, { gps = true, phone = true, t0 = 0 } = {}) {
  let v = 0;
  const errs = { a: [], v: [] };
  const fixes = [];
  let nextPhone = t0;
  let nextGps = t0 + 1000;
  for (let ms = t0; ms < t0 + seconds * 1000; ms += 10) {
    const cyc = ((ms - t0) / 1000) % 24;
    let a = cyc < 6 ? 2.5 : cyc < 12 ? 0 : cyc < 17 ? -2.6 : 0;
    if (a < 0 && v <= 0) a = 0;
    v = Math.max(0, v + (a * 10) / 1000);
    const lat = Math.sin(ms / 2300) * 1.5; // gentle turns
    if (phone && ms >= nextPhone) {
      nextPhone += 40;
      const aPhone = toPhone([a + noise(0.25), lat + noise(0.25), noise(0.4)]);
      const gPhone = toPhone([0, 0, 9.81]).map((x) => x + noise(0.05));
      fusion.addPhone({ t: ms + 80, a: aPhone, g: gPhone });
    }
    if (gps && ms >= nextGps) {
      nextGps += 1000;
      fixes.push({ due: ms + 300, speed: Math.max(0, v + noise(0.15)) }); // reported 0.3 s late
    }
    while (fixes.length && fixes[0].due <= ms) fusion.addGps({ t: ms, speed: fixes.shift().speed });
    const s = fusion.update(ms);
    if (ms - t0 > seconds * 500) {
      errs.a.push(s.accel - a);
      errs.v.push(s.speed - v);
    }
  }
  const rms = (xs) => Math.sqrt(xs.reduce((s, x) => s + x * x, 0) / xs.length);
  return { accelRms: rms(errs.a), speedRms: rms(errs.v), state: fusion.update(t0 + seconds * 1000) };
}

test('upright mount: usable at once, then calibrated against GPS', () => {
  const f = new Fusion();
  const res = simulate(f, mount('upright', 20), 90);
  assert.equal(res.state.calibration, 'ok');
  assert.equal(res.state.source, 'phone+gps');
  assert.ok(res.accelRms < 0.35, `accel error ${res.accelRms.toFixed(2)} m/s²`);
  assert.ok(res.speedRms < 0.8, `speed error ${res.speedRms.toFixed(2)} m/s`);
});

test('flat phone pointing backwards: learns the right direction', () => {
  const f = new Fusion();
  const res = simulate(f, mount('flat', 35), 90);
  assert.equal(res.state.calibration, 'ok');
  assert.ok(res.accelRms < 0.35, `accel error ${res.accelRms.toFixed(2)} m/s²`);
});

test('flat phone before calibration is not trusted (GPS drives the throttle)', () => {
  const f = new Fusion();
  const toPhone = mount('flat', 0);
  for (let ms = 0; ms < 3000; ms += 40) {
    f.addPhone({ t: ms, a: toPhone([2, 0, 0]), g: toPhone([0, 0, 9.81]) });
    f.update(ms);
  }
  const s = f.update(3000);
  assert.equal(s.calibration, 'learning');
  assert.notEqual(s.source, 'phone+gps');
  assert.ok(Math.abs(s.accel) < 0.01, 'no backwards throttle from an unverified guess');
});

test('GPS only: speed tracks with a lag-tolerant estimate', () => {
  const f = new Fusion();
  const res = simulate(f, mount('upright'), 60, { phone: false });
  assert.equal(res.state.source, 'gps');
  assert.ok(res.speedRms < 1.6, `speed error ${res.speedRms.toFixed(2)} m/s`);
});

test('phone drops out: falls back to GPS', () => {
  const f = new Fusion();
  simulate(f, mount('upright'), 40);
  const s = simulate(f, mount('upright'), 10, { phone: false, t0: 40000 }).state;
  assert.equal(s.source, 'gps');
  assert.equal(s.phoneLive, false);
});

test('re-mounting the phone restarts calibration', () => {
  const f = new Fusion();
  simulate(f, mount('upright', 10), 80);
  assert.equal(f.axes.calibrated, true);
  const epoch = f.axes.epoch;
  const toPhone = mount('flat', 90);
  for (let ms = 0; ms < 1200; ms += 40) {
    f.addPhone({ t: 200000 + ms, a: [0, 0, 0], g: toPhone([0, 0, 9.81]), rot: ms < 600 ? 150 : 2 });
  }
  assert.ok(f.axes.epoch > epoch, 'new basis within ~0.6 s of the phone settling');
  assert.equal(f.axes.calibrated, false);
  assert.equal(f.axes.handling, false);
});

test('simulator mode passes values straight through', () => {
  const f = new Fusion();
  f.setSim(true);
  f.addSim(12, 3);
  const s = f.update(1000);
  assert.equal(s.speed, 12);
  assert.equal(s.accel, 3);
  assert.equal(s.source, 'sim');
});

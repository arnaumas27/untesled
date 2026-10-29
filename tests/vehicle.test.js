import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Vehicle, rpmAtSpeed, pedalEstimate, FLAT6, shiftLights } from '../js/vehicle.js';

const DT = 1 / 60;

/** Run the model through a speed/acceleration profile; returns sampled outputs. */
function drive(vehicle, seconds, profile) {
  const out = [];
  for (let t = 0; t < seconds; t += DT) {
    const { speed, accel, rev = 0 } = profile(t);
    out.push({ t, ...vehicle.update(DT, { speed, accel, rev }) });
  }
  return out;
}

function started(mode = 'sport') {
  const v = new Vehicle();
  v.setMode(mode);
  v.start();
  drive(v, 6, () => ({ speed: 0, accel: 0 }));
  return v;
}

test('gearing: 100 km/h in 7th is a believable cruise rpm', () => {
  const rpm = rpmAtSpeed(100 / 3.6, 7);
  assert.ok(rpm > 2400 && rpm < 3100, `got ${rpm}`);
  const top1 = (FLAT6.limiterRpm / rpmAtSpeed(1, 1)) * 3.6;
  assert.ok(top1 > 60 && top1 < 80, `1st gear tops out at ${top1} km/h`);
});

test('pedal estimate: cruising is light, flooring it is full', () => {
  assert.ok(pedalEstimate(27.8, 0) < 0.15);
  assert.ok(pedalEstimate(5, 6) >= 1);
  assert.ok(pedalEstimate(30, -2) < 0);
});

test('start sequence: cranks, flares, settles to a fast idle', () => {
  const v = new Vehicle();
  v.start();
  const out = drive(v, 4, () => ({ speed: 0, accel: 0 }));
  const cranking = out.filter((o) => o.starter);
  assert.ok(cranking.length > 40, 'starter runs for a while');
  assert.ok(cranking.every((o) => o.rpm < 320), 'cranking speed stays low');
  const peak = Math.max(...out.map((o) => o.rpm));
  assert.ok(peak > 1600 && peak < 2400, `start-up flare peaks at ${peak}`);
  const last = out[out.length - 1];
  assert.equal(last.state, 'running');
  assert.ok(last.rpm > 1000 && last.rpm < 1500, `fast idle ${last.rpm}`);
});

test('stop: revs fall to zero and the engine is off', () => {
  const v = started();
  v.stop();
  const out = drive(v, 2, () => ({ speed: 0, accel: 0 }));
  assert.equal(out[out.length - 1].state, 'off');
  assert.equal(out[out.length - 1].rpm, 0);
  assert.ok(out.every((o) => !o.ignition));
});

test('full-power launch: holds gears to near the redline, never over the limiter', () => {
  const v = started('sport');
  let speed = 0;
  const shifts = [];
  const out = drive(v, 14, () => {
    const accel = speed < 45 ? Math.min(6, 9000 / Math.max(speed, 1) / 25) : 0;
    speed += accel * DT;
    return { speed, accel };
  });
  out.forEach((o, i) => {
    // Only upshifts made while still flat out (the run ends at 162 km/h).
    if (i && o.gear > out[i - 1].gear && o.pedal > 0.9) shifts.push({ from: out[i - 1].gear, rpm: out[i - 1].rpm });
  });
  assert.ok(shifts.length >= 3, `upshifts: ${shifts.length}`);
  for (const s of shifts) assert.ok(s.rpm > 8000, `upshift from ${s.from} at ${Math.round(s.rpm)} rpm`);
  assert.ok(Math.max(...out.map((o) => o.rpm)) <= FLAT6.maxRpm);
  const accelerating = out.filter((o) => o.t > 0.5 && o.t < 8 && !o.shifting);
  const meanLoad = accelerating.reduce((s, o) => s + o.load, 0) / accelerating.length;
  assert.ok(meanLoad > 0.8, `mean load while flat out: ${meanLoad.toFixed(2)}`);
  assert.ok(out.some((o) => o.cut), 'upshifts cut the ignition');
});

test('gentle driving shifts early', () => {
  const v = started('sport');
  let speed = 0;
  const shiftRpms = [];
  let prev = null;
  drive(v, 25, () => {
    const accel = speed < 22 ? 0.9 : 0;
    speed += accel * DT;
    return { speed, accel };
  }).forEach((o) => {
    if (prev && o.gear > prev.gear) shiftRpms.push(prev.rpm);
    prev = o;
  });
  assert.ok(shiftRpms.length >= 3);
  for (const r of shiftRpms) assert.ok(r < 5000, `gentle upshift at ${Math.round(r)} rpm`);
});

test('braking from speed: blipped downshifts, crackle, ends in 1st at idle', () => {
  const v = started('track');
  let speed = 0;
  drive(v, 12, () => {
    const accel = speed < 42 ? 5 : 0;
    speed += accel * DT;
    return { speed, accel };
  });
  const gearBefore = v.gear;
  const out = drive(v, 12, () => {
    const accel = speed > 0 ? -5 : 0;
    speed = Math.max(0, speed + accel * DT);
    return { speed, accel };
  });
  const downs = out.filter((o, i) => i && o.gear < out[i - 1].gear).length;
  assert.ok(downs >= gearBefore - 2, `downshifts while braking: ${downs}`);
  assert.ok(out.some((o) => o.overrun > 0.3), 'overrun crackle while braking from high revs');
  assert.ok(out.some((o) => o.shifting && o.load > 0.4 && o.pedal < 0), 'downshift blips open the throttle');
  const last = out[out.length - 1];
  assert.equal(last.gear, 1);
  assert.ok(last.rpm < 1400, `idle at standstill: ${last.rpm}`);
});

test('free rev in neutral bounces off the limiter', () => {
  const v = started();
  const out = drive(v, 3, (t) => ({ speed: 0, accel: 0, rev: t < 2.5 ? 1 : 0 }));
  assert.ok(out.some((o) => o.neutral), 'neutral while revving at a standstill');
  const peak = Math.max(...out.map((o) => o.rpm));
  assert.ok(peak > 8800 && peak <= FLAT6.maxRpm, `peak ${peak}`);
  const cuts = out.filter((o, i) => i && o.cut && !out[i - 1].cut).length;
  assert.ok(cuts >= 3, `limiter cuts: ${cuts}`);
  assert.ok(out[out.length - 1].overrun > 0, 'lifting off at high revs crackles');
});

test('shift lights', () => {
  assert.deepEqual(shiftLights(3000), { lit: 0, flash: false });
  assert.equal(shiftLights(7350).lit, 5);
  assert.deepEqual(shiftLights(8800), { lit: 10, flash: true });
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SOUNDS, soundById } from '../js/sounds.js';
import { Vehicle, V8, MOTO } from '../js/vehicle.js';
import { Turbofan, Freighter, Carriage, strideRate, TRIGGERS } from '../js/powertrains.js';
import { createSynth, SynthHost } from '../js/engine-worklet.js';
import { GAITS } from '../js/synth-carriage.js';
import { artSvg, ART } from '../js/art.js';

const DT = 1 / 60;
const SR = 48000;

/** Run a model; `profile(t)` gives {accel, rev}; speed integrates. Returns frames and events. */
function run(model, seconds, profile, state = { speed: 0 }) {
  const frames = [];
  const events = [];
  for (let t = 0; t < seconds; t += DT) {
    const { accel = 0, rev = 0 } = profile(t, state.speed);
    state.speed = Math.max(0, state.speed + accel * DT);
    model.update(DT, { speed: state.speed, accel, rev });
    for (const e of model.takeEvents()) events.push({ e, t });
    frames.push({ t, speed: state.speed, ...model.display(), synth: model.synthParams() });
  }
  return { frames, events, state };
}

const idle = () => ({ accel: 0 });

test('every sound has a model, a dial, artwork and sane output from start to stop', () => {
  assert.equal(SOUNDS.length, 6);
  assert.equal(soundById('nope').id, 'flat6');
  for (const s of SOUNDS) {
    assert.ok(ART[s.id], `${s.id} has artwork`);
    assert.match(artSvg(s.id), /<svg[\s\S]*data-body/);
    const m = s.make();
    m.start();
    const { frames } = run(m, 8, (t) => ({ accel: t < 4 ? 0 : 3 }));
    const last = frames[frames.length - 1];
    assert.equal(last.state, 'running', `${s.id} runs`);
    for (const f of frames) {
      assert.ok(Number.isFinite(f.value) && f.value >= 0 && f.value <= s.dial.max * 1.05, `${s.id} dial value ${f.value}`);
      assert.equal(typeof f.gear, 'string');
      assert.equal(typeof f.readout, 'string');
      for (const [k, v] of Object.entries(f.synth)) assert.ok(Number.isFinite(v), `${s.id} synth.${k} = ${v}`);
    }
    m.stop();
    const after = run(m, 30, idle).frames;
    assert.equal(after[after.length - 1].state, 'off', `${s.id} stops`);
  }
});

test('classic V8: 3-speed automatic, no ignition cut on upshifts, lumpy low idle', () => {
  const v = new Vehicle(V8);
  v.start();
  run(v, 60, idle);
  assert.ok(v.rpm > 550 && v.rpm < 800, `warm idle ${Math.round(v.rpm)}`);
  const gears = new Set();
  let cut = false;
  let peak = 0;
  for (let t = 0; t < 14; t += DT) {
    v.update(DT, { speed: 4 * t, accel: 4 });
    gears.add(v.gear);
    if (v.shift && v.shift.up && v.cut) cut = true;
    peak = Math.max(peak, v.rpm);
  }
  assert.deepEqual([...gears].sort(), [1, 2, 3]);
  assert.ok(!cut, 'automatic upshifts keep the ignition on');
  assert.ok(peak <= V8.maxRpm, `peak ${Math.round(peak)}`);
});

test('superbike: screams past 12,000 rpm on a hard launch, quickshifter cuts', () => {
  const v = new Vehicle(MOTO);
  v.setMode('sport');
  v.start();
  run(v, 4, idle);
  let peak = 0;
  let cuts = 0;
  let speed = 0;
  for (let t = 0; t < 10; t += DT) {
    speed += 5 * DT;
    v.update(DT, { speed, accel: 5 });
    peak = Math.max(peak, v.rpm);
    if (v.cut && v.shift && v.shift.up) cuts++;
  }
  assert.ok(peak > 12000 && peak <= MOTO.maxRpm, `peak ${Math.round(peak)}`);
  assert.ok(cuts > 0, 'upshifts cut the ignition');
});

test('turbofan: starter, light-off, slow spool-up, reverse thrust, long spool-down', () => {
  const j = new Turbofan();
  j.start();
  const start = run(j, 6, idle).frames;
  const at = (t) => start.find((f) => f.t >= t);
  assert.ok(at(1).synth.starter === 1 && at(1).synth.fuel === 0, 'starter first, no fuel');
  assert.ok(at(3).synth.fuel === 1, 'fuel after light-off');
  assert.equal(start[start.length - 1].state, 'running');
  assert.ok(Math.abs(j.n1 - 0.22) < 0.03, `idle N1 ${j.n1.toFixed(2)}`);

  const spool = run(j, 6, () => ({ accel: 5 }), { speed: 0 }).frames;
  const n1At = (t) => spool.find((f) => f.t >= t).synth.n1;
  assert.ok(n1At(1) < 0.75, `still spooling after 1 s: ${n1At(1).toFixed(2)}`);
  assert.ok(n1At(5.9) > 0.9, `takeoff thrust after 6 s: ${n1At(5.9).toFixed(2)}`);

  const brake = run(j, 3, () => ({ accel: -4 }), { speed: 30 }).frames;
  assert.ok(brake.some((f) => f.gear === 'Reverse' && f.synth.reverse > 0.5), 'reversers deploy when braking hard');

  j.stop();
  const down = run(j, 3, idle).frames;
  assert.ok(down[down.length - 1].synth.n2 > 0.2 && down[down.length - 1].synth.fuel === 0, 'spools down slowly after fuel cut');
});

test('space freighter: holding the button at full power jumps to hyperspace', () => {
  let sputters = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const f = new Freighter(seed);
    f.start();
    if (f.takeEvents().includes('sputter')) sputters++;
  }
  assert.ok(sputters > 2 && sputters < 15, `the hyperdrive sometimes fails to catch (${sputters}/20)`);

  const f = new Freighter(3);
  f.start();
  run(f, 6, idle);
  assert.equal(f.state, 'running');
  const { events, frames } = run(f, 6, () => ({ accel: 0, rev: 1 }));
  const jump = events.find((e) => e.e === 'jump');
  assert.ok(jump && jump.t < 3, `jump at ${jump && jump.t.toFixed(2)} s`);
  assert.ok(frames.some((fr) => fr.gear === 'Hyperspace'));
  assert.equal(events.filter((e) => e.e === 'jump').length, 1, 'one jump, then a cooldown');

  const moving = new Freighter(3);
  moving.start();
  run(moving, 6, idle);
  const drive = run(moving, 4, () => ({ accel: 5, rev: 1 }), { speed: 10 });
  assert.ok(!drive.events.some((e) => e.e === 'jump'), 'no jump while driving');
});

test('horse carriage: gaits follow speed, whip on a hard launch, stamps and whinnies', () => {
  const h = new Carriage(7);
  h.start();
  const start = run(h, 3, idle);
  assert.ok(start.events.some((e) => e.e === 'whinny'), 'whinnies when hitched');
  assert.equal(h.state, 'running');

  const gaits = [];
  run(h, 12, (t) => ({ accel: t < 0.3 ? 4 : 1.2 })).frames.forEach((f) => {
    if (gaits[gaits.length - 1] !== f.gear) gaits.push(f.gear);
  });
  assert.deepEqual(gaits.slice(0, 5), ['Halt', 'Walk', 'Trot', 'Canter', 'Gallop']);

  for (const [gait, v] of [[1, 1.5], [2, 3.5], [3, 6], [4, 15]]) {
    assert.ok(strideRate(gait, v) > strideRate(gait - 1 || 1, v) - 1e-9 || gait === 1);
  }

  const launch = new Carriage(7);
  launch.start();
  run(launch, 3, idle);
  assert.ok(run(launch, 2, () => ({ accel: 5 })).events.some((e) => e.e === 'whip'), 'whip in Sport');
  const calm = new Carriage(7);
  calm.setMode('comfort');
  calm.start();
  run(calm, 3, idle);
  assert.ok(!run(calm, 2, () => ({ accel: 5 })).events.some((e) => e.e === 'whip'), 'no whip in Comfort');

  const rear = new Carriage(7);
  rear.start();
  run(rear, 3, idle);
  const held = run(rear, 3, () => ({ accel: 0, rev: 1 })).events.map((e) => e.e);
  assert.ok(held.filter((e) => e === 'stamp').length >= 3, 'paws the ground');
  assert.ok(held.includes('whinny'), 'rears up and whinnies');

  rear.stop();
  assert.ok(rear.takeEvents().includes('snort'), 'snorts when unhitched');
  for (const e of ['whinny', 'snort', 'whip', 'stamp', 'jingle', 'jump', 'sputter']) assert.ok(TRIGGERS.has(e));
});

/** Render a synth; returns RMS dB and peak. */
function level(voice, params, seconds = 1.5, trigger) {
  const s = createSynth(voice, SR, 11);
  s.setParams(params);
  if (trigger) s.trigger(trigger);
  const L = new Float32Array(Math.round(SR * seconds));
  const R = new Float32Array(L.length);
  for (let o = 0; o < L.length; o += 128) s.render(L, R, o, Math.min(o + 128, L.length));
  let sum = 0;
  let peak = 0;
  const from = Math.round(L.length / 3);
  for (let i = 0; i < L.length; i++) {
    assert.ok(Number.isFinite(L[i]) && Number.isFinite(R[i]), `${voice}: finite samples`);
    if (i >= from) sum += L[i] * L[i];
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  return { db: 10 * Math.log10(sum / (L.length - from) + 1e-20), peak };
}

test('synths: silent when off, louder with power, never clipping', () => {
  const cases = {
    v8: [{ ignition: 1, rpm: 650, load: 0.12 }, { ignition: 1, rpm: 5500, load: 1 }],
    moto: [{ ignition: 1, rpm: 1300, load: 0.12 }, { ignition: 1, rpm: 13000, load: 1 }],
    jet: [{ fuel: 1, n1: 0.22, n2: 0.6 }, { fuel: 1, n1: 0.98, n2: 0.99 }],
    freighter: [{ on: 1, boot: 1, power: 0.15 }, { on: 1, boot: 1, power: 1 }],
    carriage: [{ on: 1, gait: 1, stride: 1, speed: 1.5 }, { on: 1, gait: 4, stride: 2.3, speed: 15 }],
  };
  for (const [voice, [low, high]] of Object.entries(cases)) {
    assert.equal(level(voice, {}).peak, 0, `${voice} silent when off`);
    const a = level(voice, low);
    const b = level(voice, high);
    assert.ok(b.db > a.db + 4, `${voice}: ${a.db.toFixed(1)} → ${b.db.toFixed(1)} dB`);
    assert.ok(b.peak < 0.99, `${voice} peak ${b.peak.toFixed(2)}`);
  }
  // One-shots sound even with the horse unhitched or the reactor off.
  assert.ok(level('carriage', {}, 2, 'whinny').db > -40, 'whinny');
  assert.ok(level('carriage', {}, 0.8, 'snort').db > -45, 'snort');
  assert.ok(level('freighter', { on: 1, boot: 1, power: 1 }, 3.2, 'jump').peak > 0.3, 'hyperspace jump');
});

test('carriage synth: hoof beats follow each gait\'s rhythm', () => {
  for (const [gait, stride] of [[1, 1], [2, 1.4], [3, 1.7], [4, 2.3]]) {
    const s = createSynth('carriage', SR, 5);
    const times = [];
    let clock = 0;
    for (const h of s.hooves) {
      const strike = h.strike.bind(h);
      h.strike = (amp) => {
        times.push(clock);
        strike(amp);
      };
    }
    s.setParams({ on: 1, gait, stride, speed: 3 });
    const L = new Float32Array(128);
    const R = new Float32Array(128);
    for (let o = 0; o < SR * 4; o += 128) {
      s.render(L, R);
      clock = (o + 128) / SR;
    }
    const beats = GAITS[gait].beats;
    const expected = beats.length * stride * 4;
    assert.ok(Math.abs(times.length - expected) <= beats.length + 1, `${GAITS[gait].name}: ${times.length} hits, expected ~${expected}`);
    // Gaps between hoof beats, as a share of the stride, must match the gait.
    const want = beats.map((bt, i) => ((beats[(i + 1) % beats.length][0] - bt[0] + 1) % 1)).sort((x, y) => x - y);
    const got = [];
    for (let i = beats.length; i < beats.length * 2; i++) got.push((times[i + 1] - times[i]) * stride);
    got.sort((x, y) => x - y);
    for (let i = 0; i < want.length; i++) {
      assert.ok(Math.abs(got[i] - want[i]) < 0.03, `${GAITS[gait].name} rhythm: gaps ${got.map((g) => g.toFixed(2))} vs ${want.map((g) => g.toFixed(2))}`);
    }
  }
});

test('synth host switches voices with a crossfade', () => {
  const host = new SynthHost(SR, 'flat6');
  host.message({ ignition: 1, rpm: 3000, load: 0.5 });
  const L = new Float32Array(128);
  const R = new Float32Array(128);
  for (let i = 0; i < 100; i++) host.render(L, R);
  host.message({ voice: 'carriage' });
  assert.ok(host.old, 'old voice fading out');
  host.message({ on: 1, gait: 2, stride: 1.4, speed: 4 });
  host.message({ trigger: 'whip' });
  for (let i = 0; i < 100; i++) {
    host.render(L, R);
    for (let k = 0; k < 128; k++) assert.ok(Number.isFinite(L[k]));
  }
  assert.equal(host.old, null, 'crossfade finished');
  assert.equal(host.voice, 'carriage');
});

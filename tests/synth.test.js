import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FlatSixSynth } from '../js/engine-worklet.js';

const SR = 48000;

function render(params, seconds = 2) {
  const synth = new FlatSixSynth(SR, 42);
  let pops = 0;
  synth.setParams(params);
  synth.render(new Float32Array(SR), new Float32Array(SR)); // settle
  synth.onEvent = (e) => e.type === 'pop' && pops++;
  const L = new Float32Array(SR * seconds);
  const R = new Float32Array(SR * seconds);
  for (let o = 0; o < L.length; o += 128) synth.render(L, R, o, Math.min(o + 128, L.length));
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < L.length; i++) {
    assert.ok(Number.isFinite(L[i]) && Number.isFinite(R[i]), 'finite samples');
    sum += L[i] * L[i];
    peak = Math.max(peak, Math.abs(L[i]), Math.abs(R[i]));
  }
  return { rmsDb: 10 * Math.log10(sum / L.length + 1e-20), peak, pops: pops / seconds, L };
}

const run = { ignition: 1, starter: 0, cut: 0, crackle: 1, exhaust: 1, overrun: 0 };

test('silent when off', () => {
  const r = render({ ...run, ignition: 0, rpm: 0, load: 0 }, 1);
  assert.equal(r.peak, 0);
});

test('loudness rises with revs and throttle, without clipping', () => {
  const idle = render({ ...run, rpm: 950, load: 0.12 });
  const cruise = render({ ...run, rpm: 2500, load: 0.2 });
  const wot = render({ ...run, rpm: 8500, load: 1 });
  assert.ok(idle.rmsDb < cruise.rmsDb - 4, `idle ${idle.rmsDb.toFixed(1)} < cruise ${cruise.rmsDb.toFixed(1)}`);
  assert.ok(cruise.rmsDb < wot.rmsDb - 6, `cruise ${cruise.rmsDb.toFixed(1)} < wot ${wot.rmsDb.toFixed(1)}`);
  assert.ok(wot.peak < 0.95, `peak ${wot.peak}`);
});

test('overrun crackles, full throttle does not', () => {
  assert.ok(render({ ...run, rpm: 7000, load: 0, overrun: 0.8 }).pops > 3);
  assert.equal(render({ ...run, rpm: 7000, load: 1, overrun: 0 }).pops, 0);
  assert.equal(render({ ...run, rpm: 7000, load: 0, overrun: 0.8, crackle: 0 }).pops, 0);
});

test('pitch follows the firing frequency (rpm / 20 Hz)', () => {
  // Autocorrelation peak of the sub-bass band should sit at one firing period.
  const rpm = 3000;
  const { L } = render({ ...run, rpm, load: 0.6 });
  const period = (SR * 20) / rpm;
  const corr = (lag) => {
    let s = 0;
    for (let i = 0; i < 40000; i++) s += L[i] * L[i + lag];
    return s;
  };
  const atPeriod = corr(Math.round(period));
  const atHalf = corr(Math.round(period / 2));
  assert.ok(atPeriod > atHalf, 'periodic at the firing interval');
});

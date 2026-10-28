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

test('the note follows the revs: it repeats every two firings (rpm / 40 Hz)', () => {
  // With the deep voicing the two banks differ, so the waveform repeats once
  // per pair of firings: the boxer's 1.5 engine order.
  const rpm = 3000;
  const { L } = render({ ...run, rpm, load: 0.6 });
  const T = (SR * 20) / rpm; // samples per firing
  const corr = (lag) => {
    let s = 0;
    let e = 0;
    for (let i = 0; i < 40000; i++) {
      s += L[i] * L[i + lag];
      e += L[i] * L[i];
    }
    return s / e;
  };
  const pair = corr(Math.round(2 * T));
  assert.ok(pair > 0.5, `normalised autocorrelation at two firings: ${pair.toFixed(2)}`);
  assert.ok(pair > corr(Math.round(1.5 * T)) && pair > corr(Math.round(2.5 * T)), 'periodic at two firings, not in between');
});

/** Power in [f0, f1] Hz of a mono signal (Hann-windowed FFT). */
function bandPower(x, f0, f1) {
  const N = 16384;
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  for (let i = 0; i < N; i++) re[i] = x[i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1)));
  for (let i = 1, j = 0; i < N; i++) {
    let bit = N >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) [re[i], re[j], im[i], im[j]] = [re[j], re[i], im[j], im[i]];
  }
  for (let len = 2; len <= N; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < N; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const c = Math.cos(ang * k);
        const s = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const vr = re[b] * c - im[b] * s;
        const vi = re[b] * s + im[b] * c;
        re[b] = re[a] - vr;
        im[b] = im[a] - vi;
        re[a] += vr;
        im[a] += vi;
      }
    }
  }
  let e = 0;
  for (let k = Math.ceil((f0 * N) / SR); k <= Math.floor((f1 * N) / SR); k++) e += re[k] ** 2 + im[k] ** 2;
  return e;
}

function mono(params) {
  const synth = new FlatSixSynth(SR, 7);
  synth.setParams(params);
  synth.render(new Float32Array(SR), new Float32Array(SR));
  const L = new Float32Array(16384);
  const R = new Float32Array(16384);
  for (let o = 0; o < L.length; o += 128) synth.render(L, R, o, o + 128);
  return L.map((v, i) => (v + R[i]) / 2); // what a mono subwoofer hears
}

test('deep voicing: the boxer 1.5 order carries the note, even in mono', () => {
  for (const [rpm, load] of [
    [4000, 0.5],
    [8500, 1],
  ]) {
    const x = mono({ ...run, rpm, load });
    const f = rpm / 20; // firing frequency
    const firing = bandPower(x, f * 0.97, f * 1.03);
    const half = bandPower(x, f * 0.485, f * 0.515);
    assert.ok(half >= firing, `${rpm} rpm: 1.5 order ${(10 * Math.log10(half / firing)).toFixed(1)} dB vs firing note`);
    const low = bandPower(x, 20, 400);
    const high = bandPower(x, 1500, 8000);
    assert.ok(low > 30 * high, `${rpm} rpm: lows ${(10 * Math.log10(low / high)).toFixed(1)} dB above 1.5–8 kHz`);
  }
});

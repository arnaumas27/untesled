/**
 * app.js — the car page. Wires sensors → fusion → vehicle model → synth,
 * runs the pairing link, and feeds the UI.
 *
 *   GPS (car) ─┐
 *              ├─► Fusion ─► Vehicle ─► EngineAudio (AudioWorklet)
 *   Phone ─────┘     ▲            └────► CarUI
 *   (via relay)      └── Simulator (optional)
 */

import { CONFIG, resolveBrokers } from './config.js';
import { CarLink, newSessionCode, isValidCode, formatCode } from './link.js';
import { qrSvg } from './qr.js';
import { GpsTracker } from './gps.js';
import { Fusion } from './fusion.js';
import { Vehicle } from './vehicle.js';
import { EngineAudio } from './audio.js';
import { Simulator, bindPedal } from './simulator.js';
import { CarUI } from './ui.js';

// ---------------------------------------------------------------------------
// Settings (remembered in this browser)
// ---------------------------------------------------------------------------

const STORE_KEY = 'untesled.settings';
const CODE_KEY = 'untesled.code';
const DEFAULTS = { mode: 'sport', pops: 'wild', units: 'kmh', volume: 70, sim: false, gpsOnly: false };
const POPS = { off: 0, mild: 0.5, wild: 1 };

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode: settings just won't persist */
  }
}

const settings = { ...DEFAULTS, ...load(STORE_KEY, {}) };
let code = load(CODE_KEY, null);
if (!isValidCode(code)) {
  code = newSessionCode();
  save(CODE_KEY, code);
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

const ui = new CarUI();
const fusion = new Fusion();
const vehicle = new Vehicle();
const sim = new Simulator();
const audio = new EngineAudio();
const gps = new GpsTracker((fix) => fusion.addGps(fix));
const brokers = resolveBrokers();
const link = new CarLink({ code, brokers, onMotion: (sample) => fusion.addPhone(sample) });

let revHeld = false;
let audioError = null;
let showQrAgain = false; // "Pair a different phone" pressed
let lastPhoneDevice = null;
let latest = { engine: vehicle.output(), fused: fusion.state(performance.now()) };

audio.onPop = (amp) => ui.pop(amp);
audio.onStateChange = () => refreshStatus();

// ---------------------------------------------------------------------------
// Pairing QR
// ---------------------------------------------------------------------------

function phoneUrl() {
  const url = new URL('phone.html', location.href);
  url.search = '';
  const override = new URLSearchParams(location.search).get('broker');
  if (override) url.searchParams.set('broker', override);
  url.hash = code;
  return url.toString();
}

function renderPairing() {
  const url = phoneUrl();
  const base = new URL('phone.html', location.href);
  let warning = null;
  const host = location.hostname;
  if (location.protocol === 'file:') {
    warning = 'Opened as a local file: publish the site so your phone can reach it.';
  } else if (/^(localhost|127\.|\[?::1)/.test(host)) {
    warning = `This page runs on ${host}, which your phone can't reach. Open it from your published site.`;
  } else if (location.protocol !== 'https:') {
    warning = 'Phones only share motion data with https:// pages. Publish the site with SSL.';
  }
  ui.setPairing({
    svg: qrSvg(url, { ecl: 'M', border: 3, dark: '#0a1222', light: '#ffffff', label: 'Pairing QR code' }),
    code: formatCode(code),
    manualUrl: `${base.host}${base.pathname}`,
    warning,
  });
}

// ---------------------------------------------------------------------------
// Settings handling
// ---------------------------------------------------------------------------

function applySettings() {
  vehicle.setMode(settings.mode);
  audio.setVolume(settings.volume / 100);
  fusion.setSim(settings.sim);
  if (!settings.sim) sim.reset();
  ui.applySettings(settings);
  save(STORE_KEY, settings);
  refreshStatus();
}

ui.on('setting', (name, value) => {
  settings[name] = value;
  applySettings();
});

ui.on('sim', (on) => {
  settings.sim = on;
  applySettings();
});

ui.on('volume', (v) => {
  settings.volume = v;
  audio.setVolume(v / 100);
  save(STORE_KEY, settings);
});

ui.on('newCode', () => {
  code = newSessionCode();
  save(CODE_KEY, code);
  link.setCode(code);
  renderPairing();
  showQrAgain = false;
  settings.gpsOnly = false;
  applySettings();
});

ui.on('gpsOnly', () => {
  settings.gpsOnly = true;
  applySettings();
});

ui.on('pairAgain', () => {
  settings.gpsOnly = false;
  applySettings();
});

ui.on('showQr', () => {
  showQrAgain = true;
  refreshStatus();
});

// ---------------------------------------------------------------------------
// Engine start / stop, rev button, keyboard
// ---------------------------------------------------------------------------

ui.on('start', async () => {
  // The browser suspended audio (e.g. after switching apps): resume, don't stop.
  if (vehicle.on && audio.ctx && audio.ctx.state !== 'running') {
    await audio.resume();
    refreshStatus();
    return;
  }
  if (vehicle.on) {
    vehicle.stop();
    return;
  }
  try {
    await audio.init(); // must run inside the tap: browsers block sound otherwise
    audioError = null;
  } catch (err) {
    audioError = err.message || String(err);
    refreshStatus();
    return;
  }
  vehicle.start();
  refreshStatus();
});

ui.on('revDown', () => {
  revHeld = true;
});
ui.on('revUp', () => {
  revHeld = false;
});

const KEYS = { ArrowUp: 'throttle', w: 'throttle', W: 'throttle', ArrowDown: 'brake', s: 'brake', S: 'brake' };
window.addEventListener('keydown', (e) => {
  const pedal = KEYS[e.key];
  if (!pedal || !settings.sim || e.target.closest('input, button, [role="button"]')) return;
  e.preventDefault();
  sim.keys[pedal] = e.shiftKey ? 0.5 : 1;
});
window.addEventListener('keyup', (e) => {
  const pedal = KEYS[e.key];
  if (pedal) sim.keys[pedal] = 0;
});

bindPedal(document.getElementById('pedalThrottle'), sim, 'throttle');
bindPedal(document.getElementById('pedalBrake'), sim, 'brake');

// ---------------------------------------------------------------------------
// Control loop (60 Hz, keeps running in the background while audio plays)
// ---------------------------------------------------------------------------

let lastTick = performance.now();
function tick() {
  const now = performance.now();
  const dt = Math.min(0.1, (now - lastTick) / 1000);
  lastTick = now;

  if (settings.sim) {
    sim.update(dt);
    fusion.addSim(sim.v, sim.a);
  }
  const fused = fusion.update(now);
  const stopped = fused.speed < 0.6;
  const engine = vehicle.update(dt, { speed: fused.speed, accel: fused.accel, rev: revHeld && stopped ? 1 : 0 });

  audio.setParams({
    rpm: engine.rpm,
    load: engine.load,
    overrun: engine.overrun,
    cut: engine.cut ? 1 : 0,
    ignition: engine.ignition ? 1 : 0,
    starter: engine.starter ? 1 : 0,
    crackle: engine.crackle * POPS[settings.pops],
    exhaust: engine.exhaust,
  });

  latest = { engine, fused, stopped };
}
setInterval(tick, 16);

// ---------------------------------------------------------------------------
// Render loop
// ---------------------------------------------------------------------------

let lastFrame = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  const { engine, fused, stopped } = latest;
  ui.render({
    dt,
    engine,
    speed: fused.speed,
    accel: fused.accel,
    lateral: fused.lateral,
    canRev: vehicle.running && !!stopped,
  });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// ---------------------------------------------------------------------------
// Status: chips, panel and the one-line message (4×/s)
// ---------------------------------------------------------------------------

function gpsChip(g) {
  switch (g.status) {
    case 'ok':
      return ['ok', g.still ? 'Standing still' : g.hz > 0 ? `${g.hz.toFixed(g.hz < 2 ? 1 : 0)} Hz` : 'Live'];
    case 'waiting':
      return ['busy', 'Searching'];
    case 'lost':
      return ['warn', 'Lost'];
    case 'denied':
      return ['bad', 'Blocked'];
    case 'insecure':
      return ['bad', 'Needs https'];
    case 'unavailable':
      return ['bad', 'Unavailable'];
    default:
      return ['idle', 'Off'];
  }
}

function refreshStatus() {
  const now = performance.now();
  const g = gps.getState(now);
  const ls = link.getState();
  const p = ls.phone;
  const fused = fusion.state(now);
  const engineOn = vehicle.on;

  if (p.device && p.device !== lastPhoneDevice) {
    lastPhoneDevice = p.device;
    showQrAgain = false;
  }

  // Panel on the right.
  let panel = 'pair';
  if (settings.sim) panel = 'sim';
  else if (p.connected && !showQrAgain) panel = 'phone';
  else if (settings.gpsOnly && !showQrAgain) panel = 'gps';
  ui.showPanel(panel);
  ui.setRelay(ls.relay);

  // Chips.
  let phoneChip = ['idle', 'Not paired'];
  if (p.streaming) phoneChip = ['ok', fused.calibration === 'learning' ? 'Calibrating' : 'Live'];
  else if (p.connected) phoneChip = ['warn', 'Waiting'];
  else if (p.everConnected) phoneChip = ['warn', 'Signal lost'];
  const inputs = {
    sim: ['ok', 'Simulator'],
    'phone+gps': ['ok', 'Phone'],
    phone: ['warn', 'Phone only'],
    gps: ['ok', 'GPS'],
    none: ['idle', 'None'],
  };
  ui.setChips({ gps: gpsChip(g), phone: phoneChip, input: inputs[fused.source] || inputs.none });

  if (p.connected) {
    const cal = {
      ok: 'Calibrated',
      guess: 'Assuming an upright mount',
      learning: 'Learning; drive off normally',
      none: '–',
      sim: '–',
    };
    ui.setPhoneFacts({
      device: p.device,
      calibration: p.streaming ? cal[fused.calibration] : 'Waiting for motion data',
      rate: p.streaming ? `${Math.round(p.hz)} per second` : '–',
      rtt: p.rtt != null ? `${Math.round(p.rtt)} ms` : '–',
      relay: p.relay || '–',
    });
  }

  // One message, most important first.
  let msg;
  let tone = 'idle';
  if (audioError) {
    msg = `Sound couldn't start: ${audioError}`;
    tone = 'bad';
  } else if (settings.sim) {
    msg = engineOn ? 'Simulator on. Use the pedals or the arrow keys.' : 'Simulator on. Tap Start, then use the pedals.';
    tone = 'ok';
  } else if (g.status === 'insecure') {
    msg = 'Open this page over https:// so the browser allows GPS and pairing.';
    tone = 'bad';
  } else if (engineOn && audio.ctx && audio.ctx.state !== 'running') {
    msg = 'The browser paused the sound. Tap the engine button to bring it back.';
    tone = 'warn';
  } else if (g.status === 'denied' && !p.streaming) {
    msg = 'Location is blocked. Allow location for this site so the engine can follow your speed.';
    tone = 'bad';
  } else if (p.connected && !p.streaming) {
    msg = 'Phone found. On the phone, tap Connect and allow motion access.';
    tone = 'warn';
  } else if (p.everConnected && !p.connected) {
    msg = "Phone signal lost. Using GPS until it's back. Is the phone's screen still on?";
    tone = 'warn';
  } else if (!engineOn) {
    if (p.streaming) msg = 'Phone connected. Tap Start to fire up the engine.';
    else if (panel === 'pair') msg = 'Tap Start to fire up the engine. Scan the code to pair your phone for instant throttle.';
    else msg = 'Tap Start to fire up the engine.';
    tone = p.streaming ? 'ok' : 'idle';
  } else if (p.streaming && fused.calibration === 'learning') {
    msg = 'Phone connected. Drive off normally: it learns which way is forward within seconds.';
    tone = 'ok';
  } else if (p.streaming && g.status === 'denied') {
    msg = 'Location is blocked, so speed is estimated from the phone. Allow location for accurate revs.';
    tone = 'warn';
  } else if (p.streaming) {
    msg = fused.calibration === 'ok' ? 'Phone calibrated. The throttle follows your right foot.' : 'Phone connected. The throttle follows your right foot.';
    tone = 'ok';
  } else if (g.status === 'lost') {
    msg = 'GPS signal lost. Holding the last known speed.';
    tone = 'warn';
  } else if (g.status === 'waiting' || g.status === 'off') {
    msg = 'Waiting for GPS…';
    tone = 'warn';
  } else if (g.status === 'unavailable') {
    msg = 'No GPS in this browser. Pair your phone or turn on the simulator.';
    tone = 'warn';
  } else {
    msg = 'GPS only. Pair your phone for instant throttle response.';
    tone = 'ok';
  }
  ui.setStatus(msg, tone);

  // Mirror the engine to the phone screen.
  const e = latest.engine;
  const speed = settings.units === 'mph' ? fused.speed * 2.23694 : fused.speed * 3.6;
  link.setTelemetry({
    on: vehicle.running ? 1 : 0,
    rpm: Math.round(e.rpm / 10) * 10,
    gear: !vehicle.running ? '–' : e.neutral ? 'N' : String(e.gear),
    spd: Math.round(speed),
    u: settings.units === 'mph' ? 'mph' : 'km/h',
    cal: fused.calibration,
    ax: Math.round(fused.accel * 10) / 10, // forward acceleration, m/s²
    ay: Math.round(fused.lateral * 10) / 10, // lateral (left +), m/s²
  });
}
setInterval(refreshStatus, 250);

// ---------------------------------------------------------------------------
// Start-up
// ---------------------------------------------------------------------------

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    link.kick();
    if (vehicle.on) audio.resume();
  }
});
window.addEventListener('online', () => link.kick());

renderPairing();
applySettings();
link.start();
gps.start();
refreshStatus();

// Let the app open offline after the first visit (https or localhost only).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

// Expose for debugging in the browser console.
window.untesled = { vehicle, fusion, link, audio, gps, sim, settings, config: CONFIG };

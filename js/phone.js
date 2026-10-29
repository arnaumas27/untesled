/**
 * phone.js — the phone page: read the motion sensors and stream them to the
 * car through the relay. The phone plays no sound and sends no location.
 *
 * Samples arrive at 50–100 Hz; they are averaged and sent 25 times a second
 * as linear acceleration + gravity in the phone's own axes. The car works
 * out the orientation, so the phone can sit in any mount.
 */

import { CONFIG, resolveBrokers } from './config.js';
import { PhoneLink, normalizeCode, isValidCode, formatCode, CODE_LENGTH } from './link.js';

const CODE_KEY = 'untesled.phone.code';
const $ = (id) => document.getElementById(id);

const ua = navigator.userAgent;
const isIOS = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const device = /iPhone/.test(ua) ? 'iPhone' : isIOS ? 'iPad' : /Android/.test(ua) ? 'Android' : 'Phone';
const hasMotionApi = typeof window.DeviceMotionEvent !== 'undefined';
const hasPermissionApi = hasMotionApi && typeof DeviceMotionEvent.requestPermission === 'function';

let code = null;
let link = null;
let lastLinkState = null;
let searchingSince = 0;

// Sensor state. Whether we are really streaming is decided by samples
// actually arriving, not by what the permission API answers.
let listening = false; // sensor listeners attached
let listenSince = 0;
let asking = false; // permission prompt on screen
let denied = false; // the user said no
let needsTap = false; // the browser wants a tap before sharing motion (iOS)
let gotMotion = false;
let lastMotionAt = -Infinity;
let wakeLock = null;

// ---------------------------------------------------------------------------
// Sensor sampling
// ---------------------------------------------------------------------------

const acc = { n: 0, ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0, rx: 0, ry: 0, rz: 0, rn: 0 };
let gravityLp = null; // only for phones without gyro-fused acceleration
let rateCount = 0;
let rateStart = performance.now();
let rateHz = 0;

// iOS reports both accelerations with the opposite sign to the W3C spec (and
// to Android). Start from the platform's usual convention, then confirm it
// against the orientation angles, which every platform reports the same way.
let sign = isIOS ? -1 : 1;
let signVotes = 0;
let signDecided = false;
let orientation = null;

function onOrientation(e) {
  if (e.beta != null && e.gamma != null) orientation = { beta: e.beta, gamma: e.gamma, t: performance.now() };
}

/** Vote on the sign convention: gravity's reaction must point "up". */
function checkSign(gx, gy, gz) {
  if (signDecided || !orientation || performance.now() - orientation.t > 400) return;
  if (Math.abs(orientation.gamma) > 45) return; // landscape: rely on the platform default
  const b = (orientation.beta * Math.PI) / 180;
  const c = (orientation.gamma * Math.PI) / 180;
  const up = [-Math.cos(b) * Math.sin(c), Math.sin(b), Math.cos(b) * Math.cos(c)];
  const d = (gx * up[0] + gy * up[1] + gz * up[2]) / 9.81;
  if (Math.abs(d) < 0.6) return; // phone moving around: no clear answer
  signVotes += d > 0 ? 1 : -1;
  if (Math.abs(signVotes) >= 15) {
    sign = signVotes > 0 ? 1 : -1;
    signDecided = true;
  }
}

function onMotion(e) {
  const ag = e.accelerationIncludingGravity;
  if (!ag || ag.x == null || ag.y == null || ag.z == null) return;
  gotMotion = true;
  lastMotionAt = performance.now();

  let ax;
  let ay;
  let az;
  let gx;
  let gy;
  let gz;
  const a = e.acceleration;
  if (a && a.x != null && a.y != null && a.z != null) {
    ax = a.x;
    ay = a.y;
    az = a.z;
    gx = ag.x - a.x;
    gy = ag.y - a.y;
    gz = ag.z - a.z;
  } else {
    // No gyroscope: estimate gravity as the slow average.
    const k = 0.02;
    gravityLp = gravityLp
      ? [gravityLp[0] + (ag.x - gravityLp[0]) * k, gravityLp[1] + (ag.y - gravityLp[1]) * k, gravityLp[2] + (ag.z - gravityLp[2]) * k]
      : [ag.x, ag.y, ag.z];
    [gx, gy, gz] = gravityLp;
    ax = ag.x - gx;
    ay = ag.y - gy;
    az = ag.z - gz;
  }

  acc.ax += ax;
  acc.ay += ay;
  acc.az += az;
  acc.gx += gx;
  acc.gy += gy;
  acc.gz += gz;
  acc.n++;
  const r = e.rotationRate;
  if (r && r.alpha != null && r.beta != null && r.gamma != null) {
    acc.rx += r.alpha;
    acc.ry += r.beta;
    acc.rz += r.gamma;
    acc.rn++;
  }
  rateCount++;
  checkSign(gx, gy, gz);
}

const round3 = (x) => Math.round(x * 1000) / 1000;

function sendSample() {
  const now = performance.now();
  if (now - rateStart >= 1000) {
    rateHz = (rateCount * 1000) / (now - rateStart);
    rateCount = 0;
    rateStart = now;
  }
  if (!acc.n) return;
  const k = sign / acc.n;
  const a = [round3(acc.ax * k), round3(acc.ay * k), round3(acc.az * k)];
  const g = [round3(acc.gx * k), round3(acc.gy * k), round3(acc.gz * k)];
  // Mean rotation rate (deg/s): vibration cancels out, picking the phone up doesn't.
  const rot = acc.rn ? Math.round(Math.hypot(acc.rx, acc.ry, acc.rz) / acc.rn) : null;
  for (const key in acc) acc[key] = 0;
  if (link && listening) link.sendMotion(a, g, Math.round(rateHz), rot);
}

function listen() {
  // Re-adding is harmless and makes sure iOS delivers after a fresh grant.
  window.removeEventListener('devicemotion', onMotion);
  window.removeEventListener('deviceorientation', onOrientation);
  window.addEventListener('devicemotion', onMotion);
  window.addEventListener('deviceorientation', onOrientation);
  if (!listening) listenSince = performance.now();
  listening = true;
}

function unlisten() {
  window.removeEventListener('devicemotion', onMotion);
  window.removeEventListener('deviceorientation', onOrientation);
  listening = false;
}

/**
 * Start the motion sensors. On page load (`fromTap` false) this works right
 * away on Android; iOS only shares motion after the user taps Connect and
 * accepts its prompt.
 */
async function startMotion(fromTap) {
  if (!hasMotionApi) {
    render();
    return;
  }
  listen();
  keepAwake();
  if (!hasPermissionApi) {
    render();
    return;
  }
  if (fromTap) {
    asking = true;
    render();
  }
  let result;
  try {
    // Ask for both at once; iOS shows a single prompt for the pair.
    const asks = [DeviceMotionEvent.requestPermission()];
    if (typeof window.DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
      asks.push(DeviceOrientationEvent.requestPermission().catch(() => 'denied'));
    }
    [result] = await Promise.all(asks);
  } catch {
    result = 'needs-tap'; // no user gesture yet
  }
  asking = false;
  if (result === 'granted') {
    needsTap = false;
    denied = false;
    listen();
  } else if (fromTap && result === 'denied' && !gotMotion) {
    denied = true;
  } else {
    needsTap = true;
  }
  render();
}

// ---------------------------------------------------------------------------
// Screen wake lock (the page stops sending when the phone sleeps)
// ---------------------------------------------------------------------------

async function keepAwake() {
  if (wakeLock || !('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    /* not allowed right now (e.g. battery saver); the tips tell the user */
  }
}

function releaseWake() {
  if (wakeLock) wakeLock.release().catch(() => {});
  wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    if (listening) keepAwake();
    if (link) link.kick();
  }
});

// ---------------------------------------------------------------------------
// Pairing code and link
// ---------------------------------------------------------------------------

function readStoredCode() {
  try {
    return localStorage.getItem(CODE_KEY);
  } catch {
    return null;
  }
}

function storeCode(c) {
  try {
    localStorage.setItem(CODE_KEY, c);
  } catch {
    /* private mode */
  }
}

function showCodeForm(prefill = '') {
  $('cardMain').hidden = true;
  $('cardCode').hidden = false;
  const input = $('codeInput');
  input.value = prefill;
  input.focus();
}

function startLink() {
  $('cardCode').hidden = true;
  $('cardMain').hidden = false;
  if (link) link.stop();
  link = new PhoneLink({ code, brokers: resolveBrokers(), device });
  link.start();
  lastLinkState = null;
  if (!listening && !denied) startMotion(false);
  render();
}

$('codeForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const c = normalizeCode($('codeInput').value);
  if (!isValidCode(c)) {
    $('codeError').textContent = `The code has ${CODE_LENGTH} characters, for example K7M P9X.`;
    return;
  }
  $('codeError').textContent = '';
  code = c;
  storeCode(c);
  history.replaceState(null, '', `${location.pathname}${location.search}#${c}`);
  startLink();
});

$('changeCodeBtn').addEventListener('click', () => {
  if (link) link.stop();
  link = null;
  showCodeForm(code ? formatCode(code) : '');
  render();
});

$('connectBtn').addEventListener('click', () => {
  const state = link ? link.getState().state : 'stopped';
  if (isStreaming() && state === 'taken') {
    link.claim();
  } else if (isStreaming()) {
    // Disconnect: stop sending and tell the car we left.
    unlisten();
    releaseWake();
    if (link) link.stop();
    link = null;
  } else {
    if (!link) startLink();
    else if (state === 'taken') link.claim();
    denied = false;
    startMotion(true); // must run inside the tap for the iOS permission prompt
  }
  render();
});

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

function isStreaming() {
  return listening && performance.now() - lastMotionAt < 1500;
}

function render() {
  if ($('cardMain').hidden) return;
  const now = performance.now();
  const ls = link ? link.getState() : { state: 'stopped', relay: { state: 'down' } };
  if (ls.state !== lastLinkState) {
    if (ls.state === 'searching') searchingSince = now;
    lastLinkState = ls.state;
  }
  const codeText = code ? formatCode(code) : '';
  const streaming = isStreaming();
  const noSensor = !hasMotionApi || (listening && !gotMotion && !needsTap && !asking && now - listenSince > 3000);

  let tone = 'busy';
  let text = 'Connecting…';
  let detail = `Car code ${codeText}`;
  let button = { label: 'Connect', stop: false, disabled: false };

  if (noSensor) {
    tone = 'bad';
    text = 'No motion sensor found';
    detail = "This device doesn't report motion. Open this page on your phone.";
    button.disabled = true;
  } else if (denied) {
    tone = 'bad';
    text = 'Motion access was blocked';
    detail = 'Reload this page and tap Allow when your phone asks. The car keeps going on GPS meanwhile.';
  } else if (!link) {
    tone = 'idle';
    text = 'Disconnected';
    detail = `Tap Connect to pair with car ${codeText} again.`;
  } else if (ls.state === 'connecting') {
    tone = 'busy';
    text = 'Connecting…';
  } else if (ls.state === 'offline') {
    tone = 'bad';
    text = "Can't reach the relay";
    detail = "Check this phone's internet connection. It keeps retrying.";
  } else if (ls.state === 'searching') {
    const slow = now - searchingSince > 12000;
    tone = slow ? 'warn' : 'busy';
    text = slow ? "Your car isn't answering" : 'Looking for your car…';
    detail = slow
      ? `Check that Untesled is open on the car's screen and shows the code ${codeText}.`
      : `Car code ${codeText}`;
  } else if (ls.state === 'taken') {
    tone = 'warn';
    text = 'Another phone is connected';
    detail = 'Tap the button to use this phone instead.';
    button.label = 'Use this phone';
  } else if (asking) {
    tone = 'busy';
    text = 'Waiting for permission…';
    detail = 'Tap Allow so the car can feel your acceleration.';
  } else if (streaming) {
    tone = 'ok';
    text = 'Connected to your car';
    const cal = ls.car && ls.car.cal;
    detail =
      cal === 'learning'
        ? 'Drive off normally: the car learns which way is forward.'
        : cal === 'ok'
          ? 'Calibrated. Enjoy the drive.'
          : 'Sending motion. Calibration finishes as you drive.';
    button = { label: 'Disconnect', stop: true, disabled: false };
  } else {
    tone = 'ok';
    text = 'Car found';
    detail = needsTap ? 'Tap Connect and allow motion access.' : 'Starting the motion sensor…';
  }

  const state = $('phoneState');
  if (state.dataset.tone !== tone) state.dataset.tone = tone;
  setText($('stateText'), text);
  setText($('stateDetail'), detail);

  const btn = $('connectBtn');
  setText(btn, button.label);
  btn.classList.toggle('is-stop', button.stop);
  btn.disabled = button.disabled;
  btn.hidden = ls.state === 'offline' && !!link;

  // Live readout of the car.
  const car = ls.car;
  const showLive = !!link && ls.state === 'connected' && !!car;
  $('live').hidden = !showLive;
  $('stats').hidden = !showLive;
  if (showLive) {
    const gear = car.on ? String(car.gear) : '–';
    setText($('liveGear'), gear);
    $('liveGear').classList.toggle('is-word', gear.length > 2);
    setText($('liveRpm'), car.rd || `${Number(car.rpm || 0).toLocaleString('en-US')} rpm`);
    setText($('liveSpeed'), String(car.spd || 0));
    setText($('liveUnit'), car.u || 'km/h');
    const bar = Number.isFinite(car.bar) ? car.bar : (car.rpm || 0) / 9000;
    $('liveBar').style.width = `${((1 - Math.min(1, bar)) * 100).toFixed(1)}%`;
    // What the car feels, as on its G-meter: up = accelerating, left = turning left.
    const g = 9.81 * 0.6;
    const x = Math.max(-1, Math.min(1, -(car.ay || 0) / g)) * 40;
    const y = Math.max(-1, Math.min(1, -(car.ax || 0) / g)) * 40;
    $('bubbleDot').style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    setText($('statRate'), streaming ? `${Math.round(rateHz)} Hz` : '–');
    setText($('statRtt'), ls.rtt != null ? `${Math.round(ls.rtt)} ms` : '–');
    setText($('statRelay'), ls.active || '–');
  }
}

function setText(el, text) {
  if (el.textContent !== text) el.textContent = text;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

setInterval(sendSample, 1000 / CONFIG.phoneSendHz);
setInterval(render, 200);

const fromHash = normalizeCode(decodeURIComponent(location.hash.slice(1)));
const stored = normalizeCode(readStoredCode());
if (isValidCode(fromHash)) {
  code = fromHash;
  storeCode(code);
} else if (isValidCode(stored)) {
  code = stored;
}

if (code) startLink();
else showCodeForm();

// The QR may be scanned again while this tab is open, with a new code.
window.addEventListener('hashchange', () => {
  const c = normalizeCode(decodeURIComponent(location.hash.slice(1)));
  if (isValidCode(c) && c !== code) {
    code = c;
    storeCode(c);
    startLink();
  }
});

window.addEventListener('pagehide', () => {
  if (link) link.stop();
});

// Restored from the back/forward cache: the link was closed on pagehide.
window.addEventListener('pageshow', (e) => {
  if (e.persisted && code && !$('cardMain').hidden) startLink();
});

// Let the app open offline after the first visit (https or localhost only).
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}

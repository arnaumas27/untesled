/**
 * ui.js — everything on the car screen: tachometer, readouts, the animated
 * car, status chips and messages, pairing / phone / simulator panels and the
 * settings drawer. It only displays state and reports taps; app.js decides.
 */

import { shiftLights } from './vehicle.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const C = 220; // tach centre (viewBox 440)
const START_DEG = 135;
const SWEEP_DEG = 270;
const MAX_RPM = 10000;
const REDLINE = 9000;

const $ = (id) => document.getElementById(id);
const rad = (deg) => (deg * Math.PI) / 180;
const polar = (r, deg) => [C + r * Math.cos(rad(deg)), C + r * Math.sin(rad(deg))];
const rpmAngle = (rpm) => START_DEG + (SWEEP_DEG * Math.min(Math.max(rpm, 0), MAX_RPM)) / MAX_RPM;
const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function arcPath(r, a0, a1) {
  const [x0, y0] = polar(r, a0);
  const [x1, y1] = polar(r, a1);
  const large = a1 - a0 > 180 ? 1 : 0;
  return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}

function svgEl(name, attrs, parent) {
  const el = document.createElementNS(SVG_NS, name);
  for (const k in attrs) el.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(el);
  return el;
}

/** Set text only when it changed (avoids layout work every frame). */
function setText(el, text) {
  if (el && el.textContent !== text) el.textContent = text;
}

export class CarUI {
  constructor() {
    this.app = $('app');
    this.el = {
      tach: $('tach'),
      fill: $('tachFill'),
      pointer: $('tachPointer'),
      gear: $('gear'),
      speed: $('speed'),
      speedUnit: $('speedUnit'),
      rpm: $('rpm'),
      powerLoad: $('powerLoad'),
      powerRegen: $('powerRegen'),
      startBtn: $('startBtn'),
      startLabel: $('startLabel'),
      startSub: $('startSub'),
      revBtn: $('revBtn'),
      volume: $('volume'),
      volumeOut: $('volumeOut'),
      wheelRear: $('wheelRear'),
      wheelFront: $('wheelFront'),
      carBody: $('carBody'),
      flame: $('flame'),
      status: $('statusMsg'),
      qr: $('qr'),
      pairCode: $('pairCode'),
      settingsCode: $('settingsCode'),
      manualUrl: $('manualUrl'),
      relayLine: $('relayLine'),
      modeLabel: $('modeLabel'),
      modeHint: $('modeHint'),
      settings: $('settings'),
      scrim: $('scrim'),
      settingsBtn: $('settingsBtn'),
      simToggle: $('simToggle'),
      gDot: $('gDot'),
      chips: { gps: $('chipGps'), phone: $('chipPhone'), input: $('chipInput') },
      facts: { cal: $('factCal'), rate: $('factRate'), rtt: $('factRtt'), relay: $('factRelay'), device: $('phoneDevice') },
      panels: { pair: $('panelPair'), phone: $('panelPhone'), gps: $('panelGps'), sim: $('panelSim') },
    };
    this.handlers = {};
    this.units = 'kmh';
    this.wheelAngle = 0;
    this.flameAmp = 0;
    this.lastGear = null;
    this.shiftFlashUntil = 0;
    this.time = 0;
    this._buildTach();
    this._bindControls();
    this._fitTach();
  }

  /** Register a callback: start, revDown, revUp, volume, setting, sim, newCode, gpsOnly, showQr, pairAgain. */
  on(name, fn) {
    this.handlers[name] = fn;
  }

  _emit(name, ...args) {
    if (this.handlers[name]) this.handlers[name](...args);
  }

  // ---------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------

  _buildTach() {
    const ticks = $('tachTicks');
    for (let rpm = 0; rpm <= MAX_RPM; rpm += 250) {
      const a = rpmAngle(rpm);
      const major = rpm % 1000 === 0;
      const [x0, y0] = polar(major ? 176 : 184, a);
      const [x1, y1] = polar(194, a);
      svgEl('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: major ? 'tick-major' : 'tick-minor' }, ticks);
      if (major) {
        const [tx, ty] = polar(134, a);
        const t = svgEl('text', { x: tx, y: ty, class: rpm >= REDLINE ? 'tick-num is-red' : 'tick-num' }, ticks);
        t.textContent = String(rpm / 1000);
      }
    }
    const unit = svgEl('text', { x: C, y: 392, class: 'tick-unit' }, ticks);
    unit.textContent = '×1000 rpm';

    $('tachTrack').setAttribute('d', arcPath(164, START_DEG, START_DEG + SWEEP_DEG));
    $('tachRed').setAttribute('d', arcPath(164, rpmAngle(REDLINE), START_DEG + SWEEP_DEG));
    const fill = this.el.fill;
    fill.setAttribute('d', arcPath(164, START_DEG, START_DEG + SWEEP_DEG));
    this.fillLength = typeof fill.getTotalLength === 'function' ? fill.getTotalLength() : 164 * rad(SWEEP_DEG);
    fill.style.strokeDasharray = `${this.fillLength} ${this.fillLength}`;
    fill.style.strokeDashoffset = String(this.fillLength);

    // Shift lights along the top of the dial.
    const leds = $('tachLeds');
    this.leds = [];
    for (let i = 0; i < 10; i++) {
      const [x, y] = polar(208, 243 + (i * 54) / 9);
      this.leds.push(svgEl('circle', { cx: x, cy: y, r: 7, class: 'led' }, leds));
    }
    this.ledState = '';
  }

  _bindControls() {
    const e = this.el;
    e.startBtn.addEventListener('click', () => this._emit('start'));

    // Rev button: hold to rev (pointer and keyboard).
    const revDown = (ev) => {
      if (e.revBtn.disabled) return;
      ev.preventDefault();
      e.revBtn.classList.add('is-pressed');
      this._emit('revDown');
    };
    const revUp = () => {
      if (!e.revBtn.classList.contains('is-pressed')) return;
      e.revBtn.classList.remove('is-pressed');
      this._emit('revUp');
    };
    e.revBtn.addEventListener('pointerdown', (ev) => {
      e.revBtn.setPointerCapture(ev.pointerId);
      revDown(ev);
    });
    e.revBtn.addEventListener('pointerup', revUp);
    e.revBtn.addEventListener('pointercancel', revUp);
    e.revBtn.addEventListener('lostpointercapture', revUp);
    e.revBtn.addEventListener('keydown', (ev) => {
      if ((ev.key === ' ' || ev.key === 'Enter') && !ev.repeat) revDown(ev);
    });
    e.revBtn.addEventListener('keyup', (ev) => {
      if (ev.key === ' ' || ev.key === 'Enter') revUp();
    });
    e.revBtn.addEventListener('contextmenu', (ev) => ev.preventDefault());

    e.volume.addEventListener('input', () => {
      const v = Number(e.volume.value);
      this.setVolume(v);
      this._emit('volume', v);
    });

    // Settings drawer.
    e.settingsBtn.addEventListener('click', () => this.openSettings(true));
    $('settingsClose').addEventListener('click', () => this.openSettings(false));
    e.scrim.addEventListener('click', () => this.openSettings(false));
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !e.settings.hidden) this.openSettings(false);
    });
    for (const group of document.querySelectorAll('.segmented')) {
      group.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button[data-value]');
        if (btn) this._emit('setting', group.dataset.setting, btn.dataset.value);
      });
    }
    e.simToggle.addEventListener('change', () => this._emit('sim', e.simToggle.checked));
    $('newCodeBtn').addEventListener('click', () => this._emit('newCode'));
    $('gpsOnlyBtn').addEventListener('click', () => this._emit('gpsOnly'));
    $('showQrBtn').addEventListener('click', () => this._emit('showQr'));
    $('pairAgainBtn').addEventListener('click', () => this._emit('pairAgain'));

    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(() => this._fitTach()).observe(document.querySelector('.zone-tach'));
    }
    window.addEventListener('resize', () => this._fitTach());
  }

  /** Size the tach to the largest square that fits its zone. */
  _fitTach() {
    const zone = document.querySelector('.zone-tach');
    if (!zone) return;
    const r = zone.getBoundingClientRect();
    const narrow = window.innerWidth <= 760;
    const portrait = window.innerHeight > window.innerWidth;
    // In stacked layouts the zone's height follows the tach, so size from the
    // width and a share of the screen height instead.
    let avail;
    if (narrow) avail = Math.min(r.width, window.innerHeight * 0.62);
    else if (portrait) avail = Math.min(r.width, window.innerHeight * 0.5);
    else avail = Math.min(r.width, r.height);
    const size = Math.max(240, Math.min(avail, 760));
    this.el.tach.style.setProperty('--tach', `${Math.floor(size)}px`);
  }

  openSettings(open) {
    const e = this.el;
    e.settings.hidden = !open;
    e.scrim.hidden = !open;
    e.settingsBtn.setAttribute('aria-expanded', String(open));
    if (open) $('settingsClose').focus();
    else e.settingsBtn.focus();
  }

  // ---------------------------------------------------------------------
  // Settings, pairing, panels
  // ---------------------------------------------------------------------

  applySettings(s) {
    for (const group of document.querySelectorAll('.segmented')) {
      const value = s[group.dataset.setting];
      for (const btn of group.querySelectorAll('button')) {
        btn.setAttribute('aria-pressed', String(btn.dataset.value === value));
      }
    }
    this.units = s.units;
    setText(this.el.speedUnit, s.units === 'mph' ? 'mph' : 'km/h');
    this.el.simToggle.checked = !!s.sim;
    this.app.dataset.sim = s.sim ? 'on' : 'off';
    const names = { comfort: 'Comfort', sport: 'Sport', track: 'Track' };
    const hints = {
      comfort: 'Early, smooth upshifts and a quieter exhaust at low load.',
      sport: 'Holds gears longer, blips on downshifts, crackles when you lift.',
      track: 'Revs to the limit, aggressive downshifts, maximum crackle.',
    };
    setText(this.el.modeLabel, names[s.mode] || 'Sport');
    setText(this.el.modeHint, hints[s.mode] || '');
    this.setVolume(s.volume);
  }

  setVolume(v) {
    const e = this.el;
    e.volume.value = String(v);
    e.volume.style.setProperty('--fill', `${v}%`);
    setText(e.volumeOut, String(Math.round(v)));
  }

  /** Show the pairing QR, the code and the address for typing it by hand. */
  setPairing({ svg, code, manualUrl, warning }) {
    this.el.qr.innerHTML = svg;
    setText(this.el.pairCode, code);
    setText(this.el.settingsCode, code);
    setText(this.el.manualUrl, manualUrl);
    this.pairWarning = warning || null;
  }

  showPanel(name) {
    if (this.app.dataset.panel === name) return;
    this.app.dataset.panel = name;
    for (const [key, el] of Object.entries(this.el.panels)) el.hidden = key !== name;
  }

  setRelay(relay) {
    const line = this.el.relayLine;
    let text;
    let cls = '';
    if (this.pairWarning) {
      text = this.pairWarning;
      cls = 'is-bad';
    } else if (relay.state === 'up') {
      text = 'Ready. Waiting for your phone…';
      cls = 'is-ok';
    } else if (relay.state === 'connecting') {
      text = 'Connecting to the pairing relay…';
    } else {
      text = "Can't reach the pairing relay. Check the car's internet connection.";
      cls = 'is-bad';
    }
    setText(line, text);
    line.className = `relay ${cls}`;
  }

  /** @param {{gps:[state,text], phone:[state,text], input:[state,text]}} chips */
  setChips(chips) {
    for (const key of Object.keys(chips)) {
      const el = this.el.chips[key];
      const [state, text] = chips[key];
      if (el.dataset.state !== state) el.dataset.state = state;
      setText(el.querySelector('span'), text);
    }
  }

  setStatus(text, tone = 'idle') {
    const el = this.el.status;
    setText(el, text);
    if (el.dataset.tone !== tone) el.dataset.tone = tone;
  }

  setPhoneFacts({ device, calibration, rate, rtt, relay }) {
    const f = this.el.facts;
    setText(f.device, device || '');
    setText(f.cal, calibration);
    setText(f.rate, rate);
    setText(f.rtt, rtt);
    setText(f.relay, relay);
  }

  // ---------------------------------------------------------------------
  // Per-frame rendering
  // ---------------------------------------------------------------------

  /** Exhaust flame for a pop of strength 0..1. */
  pop(amp) {
    this.flameAmp = Math.max(this.flameAmp, 0.45 + 0.55 * amp);
  }

  /**
   * @param {object} s
   * @param {number} s.dt seconds since the last frame
   * @param {object} s.engine vehicle output
   * @param {number} s.speed m/s
   * @param {number} s.accel m/s²
   * @param {number} s.lateral m/s²
   * @param {boolean} s.canRev
   */
  render(s) {
    const e = this.el;
    const eng = s.engine;
    this.time += s.dt;

    // Engine state for CSS (lights, start ring).
    if (this.app.dataset.engine !== eng.state) {
      this.app.dataset.engine = eng.state;
      const on = eng.state === 'running' || eng.state === 'cranking';
      e.startBtn.setAttribute('aria-pressed', String(on));
      setText(e.startLabel, on ? 'Stop' : 'Start');
      setText(e.startSub, on ? 'Tap to stop' : 'Tap to start');
    }
    const braking = s.accel < -1.2;
    if (this.app.dataset.braking !== String(braking)) this.app.dataset.braking = String(braking);
    if (e.revBtn.disabled === s.canRev) e.revBtn.disabled = !s.canRev;

    // Tach.
    const rpm = eng.rpm;
    e.pointer.setAttribute('transform', `translate(${C} ${C}) rotate(${rpmAngle(rpm).toFixed(2)})`);
    e.fill.style.strokeDashoffset = String(this.fillLength * (1 - Math.min(rpm, MAX_RPM) / MAX_RPM));
    const zone = rpm >= 8300 ? 'red' : rpm >= 6800 ? 'hot' : 'cool';
    if (e.tach.dataset.zone !== zone) e.tach.dataset.zone = zone;
    this._leds(rpm);

    // Readouts.
    const off = eng.state === 'off' || eng.state === 'cranking';
    const gear = off ? '–' : eng.neutral ? 'N' : String(eng.gear);
    if (gear !== this.lastGear) {
      if (this.lastGear && gear !== '–' && this.lastGear !== '–') this.shiftFlashUntil = this.time + 0.25;
      this.lastGear = gear;
      setText(e.gear, gear);
    }
    e.gear.classList.toggle('is-shifting', this.time < this.shiftFlashUntil);
    const speed = this.units === 'mph' ? s.speed * 2.23694 : s.speed * 3.6;
    setText(e.speed, String(Math.round(speed)));
    setText(e.rpm, (Math.round(rpm / 50) * 50).toLocaleString('en-US'));
    const regen = Math.min(1, Math.max(0, eng.overrun, eng.pedal < 0 ? -eng.pedal : 0));
    e.powerLoad.style.transform = `scaleX(${eng.load.toFixed(3)})`;
    e.powerRegen.style.transform = `scaleX(${off ? 0 : regen.toFixed(3)})`;

    // Car: wheels turn with speed, the body shakes with the engine and
    // pitches with acceleration, flames on pops.
    const still = reducedMotion();
    if (!still) {
      this.wheelAngle = (this.wheelAngle + Math.min(s.speed * 45, 720) * s.dt) % 360;
      for (const w of [e.wheelRear, e.wheelFront]) {
        w.setAttribute('transform', `rotate(${this.wheelAngle.toFixed(1)} ${w.dataset.cx} ${w.dataset.cy})`);
      }
      const running = eng.state === 'running' || eng.state === 'cranking';
      const rpmN = Math.min(1, rpm / 9000);
      const amp = running ? 1.4 * (1 - rpmN) + 0.7 * eng.load + (eng.state === 'cranking' ? 1.2 : 0) : 0;
      const shake = amp * Math.sin(this.time * Math.PI * 2 * Math.max(rpm, 200) / 120);
      const pitch = Math.max(-1.4, Math.min(1.4, -s.accel * 0.16));
      e.carBody.setAttribute('transform', `translate(0 ${shake.toFixed(2)}) rotate(${pitch.toFixed(2)} 512 300)`);
    }
    if (this.flameAmp > 0.02) {
      e.flame.style.opacity = this.flameAmp.toFixed(2);
      e.flame.style.transform = `scaleX(${(0.5 + this.flameAmp * 0.9).toFixed(2)})`;
      this.flameAmp *= Math.exp(-s.dt / 0.07);
    } else if (this.flameAmp) {
      this.flameAmp = 0;
      e.flame.style.opacity = '0';
    }

    // G-meter (phone panel).
    if (!e.panels.phone.hidden) {
      const g = 9.81;
      const x = Math.max(-1, Math.min(1, -s.lateral / (0.8 * g))) * 50;
      const y = Math.max(-1, Math.min(1, -s.accel / (0.8 * g))) * 50;
      e.gDot.setAttribute('cx', x.toFixed(1));
      e.gDot.setAttribute('cy', y.toFixed(1));
    }
  }

  _leds(rpm) {
    const { lit, flash } = shiftLights(rpm);
    const blinkOn = Math.floor(this.time * 10) % 2 === 0;
    const key = flash ? (blinkOn ? 'F1' : 'F0') : String(lit);
    if (key === this.ledState) return;
    this.ledState = key;
    this.leds.forEach((led, i) => {
      let cls = 'led';
      if (flash) cls += blinkOn ? ' on-shift' : '';
      else if (i < lit) cls += i < 4 ? ' on-green' : i < 7 ? ' on-amber' : ' on-red';
      led.setAttribute('class', cls);
    });
  }
}

/**
 * ui.js — everything on the car screen: the dial, readouts, the animated
 * artwork, status chips and messages, pairing / G-meter / simulator panels and
 * the settings drawer. It only displays state and reports taps; app.js decides.
 */

import { shiftLights } from './vehicle.js';
import { artSvg, artTraits } from './art.js';
import { GAITS } from './synth-carriage.js';
import { SOUNDS } from './sounds.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const C = 220; // tach centre (viewBox 440)
const START_DEG = 135;
const SWEEP_DEG = 270;

const $ = (id) => document.getElementById(id);
const rad = (deg) => (deg * Math.PI) / 180;
const polar = (r, deg) => [C + r * Math.cos(rad(deg)), C + r * Math.sin(rad(deg))];
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

const GMAX_KEY = 'untesled.gmax';

function emptyGMax() {
  return { sectors: [0, 0, 0, 0, 0, 0, 0, 0], accel: 0, brake: 0, left: 0, right: 0 };
}

function loadGMax() {
  try {
    const m = JSON.parse(localStorage.getItem(GMAX_KEY));
    if (m && Array.isArray(m.sectors) && m.sectors.length === 8) return { ...emptyGMax(), ...m };
  } catch {
    /* nothing stored */
  }
  return emptyGMax();
}

function saveGMax(m) {
  try {
    localStorage.setItem(GMAX_KEY, JSON.stringify(m));
  } catch {
    /* private mode: maxima last for this visit only */
  }
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
      startNoun: $('startNoun'),
      artFrame: $('artFrame'),
      specLabel: $('specLabel'),
      soundGrid: $('soundGrid'),
      soundHint: $('soundHint'),
      popsSetting: $('popsSetting'),
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
      gMax: $('gMax'),
      gValues: { accel: $('gAccel'), brake: $('gBrake'), left: $('gLeft'), right: $('gRight') },
      pairAgainBtn: $('pairAgainBtn'),
      chips: { gps: $('chipGps'), phone: $('chipPhone'), input: $('chipInput') },
      panels: { pair: $('panelPair'), g: $('panelG'), sim: $('panelSim') },
    };
    this.gmax = loadGMax();
    this.gmaxDirty = false;
    this.gmaxSavedAt = 0;
    this._drawGMax();
    this.handlers = {};
    this.units = 'kmh';
    this.flameAmp = 0;
    this.lastGear = null;
    this.shiftFlashUntil = 0;
    this.time = 0;
    this.fanAngle = 0;
    this.stridePhase = 0;
    this.sound = null;
    this._buildSoundPicker();
    this._bindControls();
    this._fitTach();
  }

  /** Register a callback: start, revDown, revUp, setting, sim, newCode, gpsOnly, pairAgain. */
  on(name, fn) {
    this.handlers[name] = fn;
  }

  _emit(name, ...args) {
    if (this.handlers[name]) this.handlers[name](...args);
  }

  // ---------------------------------------------------------------------
  // Construction
  // ---------------------------------------------------------------------

  /** One button per sound in Settings, each with a small drawing. */
  _buildSoundPicker() {
    this.el.soundGrid.innerHTML = SOUNDS.map(
      (snd) => `<button type="button" data-value="${snd.id}" aria-pressed="false">${artSvg(snd.id, { prefix: `thumb-${snd.id}`, thumb: true })}<span>${snd.name}</span></button>`,
    ).join('');
  }

  /** Switch the dial, labels and artwork to a sound from sounds.js. */
  setSound(sound) {
    if (this.sound === sound) return;
    this.sound = sound;
    const e = this.el;
    this._buildTach(sound.dial);
    this.ledState = '';
    setText(e.specLabel, sound.spec);
    setText(e.startNoun, sound.startNoun);
    setText(e.revBtn, sound.revLabel);
    setText(e.soundHint, sound.hint);
    e.popsSetting.hidden = !sound.pops;
    this.app.dataset.sound = sound.id;

    // Artwork, and the parts that move.
    e.artFrame.innerHTML = artSvg(sound.id);
    const q = (sel) => Array.from(e.artFrame.querySelectorAll(sel));
    this.art = {
      body: e.artFrame.querySelector('[data-body]'),
      spins: q('[data-spin]').map((el) => ({ el, cx: el.dataset.cx, cy: el.dataset.cy, rm: Number(el.dataset.rm), angle: 0 })),
      fans: q('[data-fan]'),
      glows: q('[data-glow]').map((el) => ({ el, base: Number(el.getAttribute('opacity') || 1) })),
      flame: e.artFrame.querySelector('[data-flame]'),
      legs: q('[data-leg]').map((el) => ({ el, leg: Number(el.dataset.leg), seg: el.dataset.seg })),
      tail: e.artFrame.querySelector('[data-tail]'),
      ...artTraits(sound.id),
    };
    this.lastGlow = -1;
    this.lastGear = null;
    if (this.lastSettings) this.applySettings(this.lastSettings);
  }

  _buildTach(dial) {
    this.dial = dial;
    const ticks = $('tachTicks');
    ticks.textContent = '';
    for (let v = 0; v <= dial.max; v += dial.minor) {
      const a = this._angle(v);
      const major = v % dial.major === 0;
      const [x0, y0] = polar(major ? 176 : 184, a);
      const [x1, y1] = polar(194, a);
      svgEl('line', { x1: x0, y1: y0, x2: x1, y2: y1, class: major ? 'tick-major' : 'tick-minor' }, ticks);
      const label = major ? dial.label(v) : '';
      if (label) {
        const [tx, ty] = polar(label.length > 2 ? 124 : 134, a);
        let cls = v >= dial.red ? 'tick-num is-red' : 'tick-num';
        if (label.length > 2) cls += ' is-small';
        const t = svgEl('text', { x: tx, y: ty, class: cls }, ticks);
        t.textContent = label;
      }
    }
    const unit = svgEl('text', { x: C, y: 392, class: 'tick-unit' }, ticks);
    unit.textContent = dial.unit;

    $('tachTrack').setAttribute('d', arcPath(164, START_DEG, START_DEG + SWEEP_DEG));
    $('tachRed').setAttribute('d', arcPath(164, this._angle(dial.red), START_DEG + SWEEP_DEG));
    const fill = this.el.fill;
    fill.setAttribute('d', arcPath(164, START_DEG, START_DEG + SWEEP_DEG));
    this.fillLength = typeof fill.getTotalLength === 'function' ? fill.getTotalLength() : 164 * rad(SWEEP_DEG);
    fill.style.strokeDasharray = `${this.fillLength} ${this.fillLength}`;
    fill.style.strokeDashoffset = String(this.fillLength);

    // Shift lights along the top of the dial.
    if (!this.leds) {
      const leds = $('tachLeds');
      this.leds = [];
      for (let i = 0; i < 10; i++) {
        const [x, y] = polar(208, 243 + (i * 54) / 9);
        this.leds.push(svgEl('circle', { cx: x, cy: y, r: 7, class: 'led' }, leds));
      }
    }
    this.ledState = '';
  }

  /** Dial angle (degrees) for a value on the current dial. */
  _angle(v) {
    const max = this.dial.max;
    return START_DEG + (SWEEP_DEG * Math.min(Math.max(v, 0), max)) / max;
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

    $('gResetBtn').addEventListener('click', () => {
      this.gmax = emptyGMax();
      saveGMax(this.gmax);
      this._drawGMax();
    });

    // Settings drawer.
    e.settingsBtn.addEventListener('click', () => this.openSettings(true));
    $('settingsClose').addEventListener('click', () => this.openSettings(false));
    e.scrim.addEventListener('click', () => this.openSettings(false));
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' && !e.settings.hidden) this.openSettings(false);
    });
    for (const group of document.querySelectorAll('.segmented, .sound-grid')) {
      group.addEventListener('click', (ev) => {
        const btn = ev.target.closest('button[data-value]');
        if (btn) this._emit('setting', group.dataset.setting, btn.dataset.value);
      });
    }
    e.simToggle.addEventListener('change', () => this._emit('sim', e.simToggle.checked));
    $('newCodeBtn').addEventListener('click', () => this._emit('newCode'));
    $('gpsOnlyBtn').addEventListener('click', () => this._emit('gpsOnly'));
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
    this.lastSettings = s;
    for (const group of document.querySelectorAll('.segmented, .sound-grid')) {
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
    const hints = this.sound ? this.sound.modeHints : {};
    setText(this.el.modeLabel, names[s.mode] || 'Sport');
    setText(this.el.modeHint, hints[s.mode] || '');
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

  /** Offer "Pair a phone" on the G-meter panel when no phone is connected. */
  setPairOffer(show) {
    if (this.el.pairAgainBtn.hidden === show) this.el.pairAgainBtn.hidden = !show;
  }

  // ---------------------------------------------------------------------
  // G-meter with remembered maxima
  // ---------------------------------------------------------------------

  /** Record a reading: fwd = forward acceleration, right = to the right (g). */
  _trackG(fwd, right) {
    const m = this.gmax;
    const mag = Math.hypot(fwd, right);
    if (mag < 0.05) return;
    let changed = false;
    // Eight directions, so the stored maxima draw a shape on the meter.
    const sector = (Math.round(Math.atan2(right, fwd) / (Math.PI / 4)) + 8) % 8;
    if (mag > m.sectors[sector]) {
      m.sectors[sector] = mag;
      changed = true;
    }
    for (const [key, val] of [['accel', fwd], ['brake', -fwd], ['right', right], ['left', -right]]) {
      if (val > m[key]) {
        m[key] = val;
        changed = true;
      }
    }
    if (changed) {
      this.gmaxDirty = true;
      this._drawGMax();
    }
  }

  _drawGMax() {
    const m = this.gmax;
    const R = 56; // svg units per 1 g
    const pts = m.sectors.map((g, i) => {
      const a = (i * Math.PI) / 4; // 0 = forward (up), clockwise
      const r = Math.min(g, 1.15) * R;
      return `${(Math.sin(a) * r).toFixed(1)},${(-Math.cos(a) * r).toFixed(1)}`;
    });
    this.el.gMax.setAttribute('points', pts.join(' '));
    for (const key of ['accel', 'brake', 'left', 'right']) setText(this.el.gValues[key], m[key].toFixed(2));
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
   * @param {object} s.display what the model shows (see Vehicle.display)
   * @param {number} s.speed m/s
   * @param {number} s.accel m/s²
   * @param {number} s.lateral m/s²
   * @param {boolean} s.canRev
   */
  render(s) {
    const e = this.el;
    const d = s.display;
    const dial = this.dial;
    this.time += s.dt;

    // Engine state for CSS (lights, start ring).
    if (this.app.dataset.engine !== d.state) {
      this.app.dataset.engine = d.state;
      const on = d.state === 'running' || d.state === 'cranking';
      e.startBtn.setAttribute('aria-pressed', String(on));
      setText(e.startLabel, on ? 'Stop' : 'Start');
      setText(e.startSub, on ? 'Tap to stop' : 'Tap to start');
    }
    const braking = s.accel < -1.2;
    if (this.app.dataset.braking !== String(braking)) this.app.dataset.braking = String(braking);
    if (e.revBtn.disabled === s.canRev) e.revBtn.disabled = !s.canRev;

    // Dial.
    const value = d.value;
    e.pointer.setAttribute('transform', `translate(${C} ${C}) rotate(${this._angle(value).toFixed(2)})`);
    e.fill.style.strokeDashoffset = String(this.fillLength * (1 - Math.min(value, dial.max) / dial.max));
    const zone = value >= dial.red * 0.92 ? 'red' : value >= dial.red * 0.755 ? 'hot' : 'cool';
    if (e.tach.dataset.zone !== zone) e.tach.dataset.zone = zone;
    this._leds(value);

    // Readouts.
    if (d.gear !== this.lastGear) {
      if (this.lastGear && d.gear !== '–' && this.lastGear !== '–' && !d.word) this.shiftFlashUntil = this.time + 0.25;
      this.lastGear = d.gear;
      setText(e.gear, d.gear);
      e.gear.classList.toggle('is-word', !!d.word);
      e.gear.classList.toggle('is-long', d.gear.length > 7);
    }
    e.gear.classList.toggle('is-shifting', this.time < this.shiftFlashUntil);
    const speed = this.units === 'mph' ? s.speed * 2.23694 : s.speed * 3.6;
    setText(e.speed, String(Math.round(speed)));
    setText(e.rpm, d.readout);
    const off = d.state === 'off' || d.state === 'cranking';
    e.powerLoad.style.transform = `scaleX(${Math.min(1, Math.max(0, d.load)).toFixed(3)})`;
    e.powerRegen.style.transform = `scaleX(${off ? 0 : Math.min(1, d.regen).toFixed(3)})`;

    this._animateArt(s, d);

    // G-meter: live dot (up = accelerating, left = turning left) and maxima.
    if (!e.panels.g.hidden) {
      const fwd = s.accel / 9.81;
      const right = -s.lateral / 9.81;
      const clampG = (v) => Math.max(-1.15, Math.min(1.15, v));
      e.gDot.setAttribute('cx', (clampG(right) * 56).toFixed(1));
      e.gDot.setAttribute('cy', (-clampG(fwd) * 56).toFixed(1));
      if (s.trackG) this._trackG(fwd, right);
      if (this.gmaxDirty && this.time - this.gmaxSavedAt > 2) {
        saveGMax(this.gmax);
        this.gmaxDirty = false;
        this.gmaxSavedAt = this.time;
      }
    }
  }

  /** Wheels turn with speed, the body shakes with the engine and pitches with acceleration. */
  _animateArt(s, d) {
    const art = this.art;
    if (!art) return;
    const still = reducedMotion();
    if (!still) {
      const dt = s.dt;
      for (const w of art.spins) {
        w.angle = (w.angle + Math.min((s.speed / w.rm) * 57.3, 1080) * dt) % 360;
        w.el.setAttribute('transform', `rotate(${w.angle.toFixed(1)} ${w.cx} ${w.cy})`);
      }
      if (art.fans.length) {
        this.fanAngle = (this.fanAngle + (d.spin || 0) * 1900 * dt) % 360;
        for (const f of art.fans) f.setAttribute('transform', `rotate(${this.fanAngle.toFixed(1)})`);
      }
      let y = d.shake * Math.sin(this.time * Math.PI * 2 * d.shakeHz);
      if (art.hover) y += 4 * Math.sin(this.time * 1.4);
      let x = 0;
      let sx = 1;
      let opacity = 1;
      if (d.jump != null) {
        // Hyperspace: shake while charging, streak off to the right, come back.
        const j = d.jump;
        if (j < 1.1) y += 2.5 * (j / 1.1) * Math.sin(this.time * 90);
        else if (j < 1.45) {
          const k = (j - 1.1) / 0.35;
          sx = 1 + 2.5 * k;
          x = 900 * k * k;
          opacity = 1 - k;
        } else if (j < 2.6) opacity = 0;
        else opacity = Math.min(1, (j - 2.6) / 0.6);
      }
      if (art.hasLegs) y += this._legs(s, d);
      const pitch = Math.max(-1.4, Math.min(1.4, -s.accel * 0.16));
      art.body.setAttribute('transform', `translate(${x.toFixed(1)} ${y.toFixed(2)}) rotate(${pitch.toFixed(2)} 550 300) scale(${sx.toFixed(3)} 1)`);
      art.body.style.opacity = opacity === 1 ? '' : opacity.toFixed(2);
    }
    // Engine glows (jet exhaust, sublight drive, lantern).
    const glow = Math.round(d.glow * 50) / 50;
    if (glow !== this.lastGlow) {
      this.lastGlow = glow;
      for (const g of art.glows) g.el.style.opacity = (g.base * glow).toFixed(2);
    }
    const flame = art.flame;
    if (!flame) return;
    if (this.flameAmp > 0.02) {
      flame.style.opacity = this.flameAmp.toFixed(2);
      flame.style.transform = `scaleX(${(0.5 + this.flameAmp * 0.9).toFixed(2)})`;
      this.flameAmp *= Math.exp(-s.dt / 0.07);
    } else if (this.flameAmp) {
      this.flameAmp = 0;
      flame.style.opacity = '0';
    }
  }

  /** Horse legs follow the gait; returns the body's bounce. */
  _legs(s, d) {
    const gait = d.gait || 0;
    const g = GAITS[gait];
    if (gait > 0) this.stridePhase = (this.stridePhase + d.stride * s.dt) % 1;
    const swing = [0, 14, 20, 24, 30][gait];
    const fold = [0, 30, 55, 62, 70][gait];
    for (const part of this.art.legs) {
      let angle = 0;
      if (gait > 0) {
        const beat = g.beats.find((b) => b[1] === part.leg);
        const local = (this.stridePhase - beat[0] + 1) % 1;
        if (local < g.duty) {
          // Hoof on the ground: the leg sweeps from forward to back.
          if (part.seg === 'upper') angle = -swing + (2 * swing * local) / g.duty;
        } else {
          // In the air: back to the front, folding the lower leg.
          const k = (local - g.duty) / (1 - g.duty);
          if (part.seg === 'upper') angle = swing - 2 * swing * (0.5 - 0.5 * Math.cos(Math.PI * k));
          else angle = (part.leg < 2 ? 1 : -1) * fold * Math.sin(Math.PI * k);
        }
      } else if (part.seg === 'upper' && s.paw && part.leg === 1) {
        angle = -18 * Math.max(0, Math.sin(this.time * 9));
      }
      part.el.setAttribute('transform', `rotate(${angle.toFixed(1)})`);
    }
    if (this.art.tail) {
      const sway = gait > 0 ? 4 * Math.sin(this.stridePhase * Math.PI * 2) : 1.5 * Math.sin(this.time * 0.8);
      this.art.tail.setAttribute('transform', `rotate(${sway.toFixed(1)} 672 172)`);
    }
    const bounce = [0, 0.6, 2.2, 2.8, 3.2][gait];
    const beats = gait === 2 ? 2 : 1;
    return -bounce * Math.abs(Math.sin(this.stridePhase * Math.PI * beats));
  }

  _leds(value) {
    const [start, end] = this.sound ? this.sound.lights : [6000, 8700];
    const { lit, flash } = shiftLights(value, 10, start, end);
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

/**
 * link.js — phone ↔ car pairing over public MQTT relays.
 *
 * Both sides connect to every broker in CONFIG.brokers at once. The phone says
 * hello on all of them; the car answers on each, and the phone keeps whichever
 * relay answered first (usually the fastest). Data then flows only through
 * that relay, while the others stay connected as warm spares.
 *
 * Topics:  <prefix>/<code>/up    phone → car  (hello, motion, ping, bye)
 *          <prefix>/<code>/down  car → phone  (welcome, heartbeat, pong)
 */

import { MqttClient } from './mqtt.js';
import { CONFIG } from './config.js';

/** Unambiguous characters only: no 0/O, 1/I/L. */
export const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const CODE_LENGTH = 6;

const decoder = new TextDecoder();
const now = () => performance.now();

export function newSessionCode() {
  const bytes = new Uint8Array(CODE_LENGTH);
  crypto.getRandomValues(bytes);
  let code = '';
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

/** Uppercase and keep only valid code characters ("k7m-p9x" → "K7MP9X"). */
export function normalizeCode(input) {
  return [...String(input || '').toUpperCase()].filter((c) => CODE_ALPHABET.includes(c)).join('');
}

export function isValidCode(code) {
  return typeof code === 'string' && code.length === CODE_LENGTH && normalizeCode(code) === code;
}

/** "K7MP9X" → "K7M P9X" for display. */
export function formatCode(code) {
  return code.length === CODE_LENGTH ? `${code.slice(0, 3)} ${code.slice(3)}` : code;
}

export function topicsFor(code) {
  const base = `${CONFIG.topicPrefix}/${code}`;
  return { up: `${base}/up`, down: `${base}/down` };
}

function parse(payload) {
  try {
    const msg = JSON.parse(decoder.decode(payload));
    return msg && typeof msg === 'object' ? msg : null;
  } catch {
    return null;
  }
}

/** A finite 3-vector with sane magnitudes, or null. */
function vec3(v, limit) {
  if (!Array.isArray(v) || v.length !== 3) return null;
  for (const x of v) if (typeof x !== 'number' || !Number.isFinite(x) || Math.abs(x) > limit) return null;
  return v;
}

/**
 * Keeps one MQTT connection per broker alive, reconnecting with backoff.
 */
class BrokerPool {
  constructor(brokers, { onMessage, onChange }) {
    this.entries = brokers.map((def) => ({ def, client: null, state: 'idle', retryMs: 1000, timer: null }));
    this.onMessage = onMessage;
    this.onChange = onChange;
    this.subscription = null;
    this.running = false;
  }

  start(subscription) {
    this.subscription = subscription;
    this.running = true;
    for (const e of this.entries) this._connect(e);
  }

  stop() {
    this.running = false;
    for (const e of this.entries) {
      clearTimeout(e.timer);
      const client = e.client;
      e.client = null;
      e.state = 'idle';
      if (client) client.close();
    }
    this._changed();
  }

  /** Reconnect dropped brokers right away (e.g. when the page becomes visible again). */
  kick() {
    if (!this.running) return;
    for (const e of this.entries) {
      if (e.state === 'down') {
        clearTimeout(e.timer);
        e.retryMs = 1000;
        this._connect(e);
      }
    }
  }

  publish(id, topic, payload) {
    const e = this.entries.find((x) => x.def.id === id);
    return !!(e && e.client && e.client.connected && e.client.publish(topic, payload));
  }

  get upIds() {
    return this.entries.filter((e) => e.state === 'up').map((e) => e.def.id);
  }

  get summary() {
    return this.entries.map((e) => ({ id: e.def.id, state: e.state }));
  }

  async _connect(e) {
    if (!this.running) return;
    e.state = 'connecting';
    this._changed();
    const client = new MqttClient(e.def.url, {
      username: e.def.username,
      password: e.def.password,
      keepalive: 20,
    });
    e.client = client;
    client.onmessage = (topic, payload) => this.onMessage(e.def.id, topic, payload);
    client.onclose = () => {
      if (e.client !== client) return; // stopped or replaced
      e.client = null;
      e.state = 'down';
      this._changed();
      this._scheduleRetry(e);
    };
    try {
      await client.connect();
    } catch {
      return; // onclose has scheduled a retry
    }
    if (e.client !== client) return;
    e.retryMs = 1000;
    if (this.subscription) client.subscribe(this.subscription);
    e.state = 'up';
    this._changed();
  }

  _scheduleRetry(e) {
    if (!this.running) return;
    clearTimeout(e.timer);
    const delay = e.retryMs * (0.8 + Math.random() * 0.4);
    e.retryMs = Math.min(e.retryMs * 2, 30000);
    e.timer = setTimeout(() => this._connect(e), delay);
  }

  _changed() {
    if (this.onChange) this.onChange();
  }
}

/** Short summary of relay health for the UI. */
function relayState(summary) {
  const up = summary.filter((s) => s.state === 'up').length;
  if (up > 0) return { state: 'up', up, total: summary.length };
  const trying = summary.some((s) => s.state === 'connecting' || s.state === 'idle');
  return { state: trying ? 'connecting' : 'down', up, total: summary.length };
}

// ---------------------------------------------------------------------------
// Car side
// ---------------------------------------------------------------------------

export class CarLink {
  /**
   * @param {object} opts
   * @param {string} opts.code               session code
   * @param {Array}  opts.brokers            broker definitions
   * @param {(sample: object) => void} opts.onMotion  called for each motion message
   */
  constructor({ code, brokers, onMotion }) {
    this.code = code;
    this.topics = topicsFor(code);
    this.onMotion = onMotion;
    this.pool = new BrokerPool(brokers, {
      onMessage: (id, topic, payload) => this._onMessage(id, topic, payload),
      onChange: () => {},
    });
    this.phone = null;
    this.telemetry = { on: 0, rpm: 0, gear: 0, spd: 0, u: 'km/h', cal: 'none' };
    this._timer = null;
    this._tick = 0;
  }

  start() {
    this.pool.start(this.topics.up);
    clearInterval(this._timer);
    this._timer = setInterval(() => this._heartbeat(), 1000 / CONFIG.heartbeatHz);
  }

  stop() {
    clearInterval(this._timer);
    this.pool.stop();
  }

  /** Switch to a new pairing code (drops the current phone). */
  setCode(code) {
    this.stop();
    this.code = code;
    this.topics = topicsFor(code);
    this.phone = null;
    this.start();
  }

  kick() {
    this.pool.kick();
  }

  /** Latest engine readout, mirrored to the phone in heartbeats. */
  setTelemetry(t) {
    Object.assign(this.telemetry, t);
  }

  /** A phone is paired and talking to us (any message recently). */
  get phoneConnected() {
    return !!this.phone && now() - this.phone.lastSeen < CONFIG.carTimeoutMs;
  }

  /** The phone is streaming motion data right now. */
  get phoneStreaming() {
    return !!this.phone && now() - this.phone.lastMotion < CONFIG.phoneTimeoutMs;
  }

  /** Snapshot for the UI. */
  getState() {
    const p = this.phone;
    return {
      relay: relayState(this.pool.summary),
      relays: this.pool.summary,
      phone: p
        ? {
            connected: this.phoneConnected,
            streaming: this.phoneStreaming,
            everConnected: true,
            device: p.device,
            hz: this.phoneStreaming ? p.hz : 0,
            rtt: p.rtt,
            relay: p.brokerId,
          }
        : { connected: false, streaming: false, everConnected: false },
    };
  }

  _onMessage(brokerId, topic, payload) {
    if (topic !== this.topics.up) return;
    const msg = parse(payload);
    if (!msg || typeof msg.id !== 'string' || msg.id.length > 32) return;
    const t = now();

    switch (msg.t) {
      case 'hi':
        this._touch(msg, brokerId, t, true);
        this.pool.publish(brokerId, this.topics.down, JSON.stringify({ t: 'wel', ph: msg.id }));
        break;

      case 'm': {
        const phone = this._touch(msg, brokerId, t, false);
        if (!phone) return;
        const a = vec3(msg.a, 80);
        const g = vec3(msg.g, 30);
        if (!a || !g) return;
        if (t - phone.lastMotion > CONFIG.phoneTimeoutMs) {
          phone.rateStart = t;
          phone.rateCount = 0;
        }
        phone.lastMotion = t;
        phone.rateCount++;
        if (t - phone.rateStart >= 1000) {
          phone.hz = (phone.rateCount * 1000) / (t - phone.rateStart);
          phone.rateStart = t;
          phone.rateCount = 0;
        }
        if (this.onMotion) {
          const rot = typeof msg.r === 'number' && Number.isFinite(msg.r) ? msg.r : undefined;
          this.onMotion({ t, seq: msg.n, a, g, rot, hz: typeof msg.hz === 'number' ? msg.hz : 0 });
        }
        break;
      }

      case 'pi':
        this._touch(msg, brokerId, t, false);
        this.pool.publish(brokerId, this.topics.down, JSON.stringify({ t: 'po', k: msg.k }));
        break;

      case 'bye':
        if (this.phone && this.phone.id === msg.id) this.phone = null; // left on purpose
        break;

      default:
        break;
    }
  }

  /**
   * Register activity from a phone. The last phone to say hello takes over;
   * data from another phone is ignored while the active one is alive.
   */
  _touch(msg, brokerId, t, isHello) {
    let p = this.phone;
    if (!p || p.id !== msg.id) {
      if (p && !isHello && t - p.lastSeen < CONFIG.carTimeoutMs) return null;
      p = this.phone = {
        id: msg.id,
        device: '',
        brokerId,
        lastSeen: t,
        lastMotion: -Infinity,
        hz: 0,
        rtt: null,
        rateStart: t,
        rateCount: 0,
      };
    }
    p.lastSeen = t;
    p.brokerId = brokerId;
    if (typeof msg.dev === 'string') p.device = msg.dev.slice(0, 24);
    if (typeof msg.rtt === 'number' && Number.isFinite(msg.rtt)) p.rtt = msg.rtt;
    return p;
  }

  _heartbeat() {
    this._tick = (this._tick + 1) % CONFIG.heartbeatHz;
    const active = this.phoneConnected ? this.phone.brokerId : null;
    const hb = JSON.stringify({ t: 'hb', ...this.telemetry, ph: active ? this.phone.id : null });
    // Full rate on the phone's relay; once a second everywhere else so a
    // phone that is still searching can find us on any relay.
    if (active) this.pool.publish(active, this.topics.down, hb);
    if (this._tick === 0) {
      for (const id of this.pool.upIds) if (id !== active) this.pool.publish(id, this.topics.down, hb);
    }
  }
}

// ---------------------------------------------------------------------------
// Phone side
// ---------------------------------------------------------------------------

export class PhoneLink {
  /**
   * @param {object} opts
   * @param {string} opts.code
   * @param {Array}  opts.brokers
   * @param {string} [opts.device]  short device label shown on the car
   */
  constructor({ code, brokers, device = 'Phone' }) {
    this.id = Math.random().toString(36).slice(2, 10);
    this.code = code;
    this.device = device;
    this.topics = topicsFor(code);
    this.pool = new BrokerPool(brokers, {
      onMessage: (id, topic, payload) => this._onMessage(id, topic, payload),
      onChange: () => this._relaysChanged(),
    });
    this.active = null; // relay the car answered on
    this.seen = {}; // relay id → last time the car was heard there
    this.car = null; // latest heartbeat
    this.carLastSeen = -Infinity;
    this.ownedByOther = false;
    this.welcomed = false;
    this.seq = 0;
    this.rtt = null;
    this._pings = new Map();
    this._pingId = 0;
    this._timer = null;
    this._tick = 0;
  }

  start() {
    this.pool.start(this.topics.down);
    clearInterval(this._timer);
    this._timer = setInterval(() => this._housekeeping(), 500);
  }

  stop() {
    if (this.active) this.pool.publish(this.active, this.topics.up, JSON.stringify({ t: 'bye', id: this.id }));
    clearInterval(this._timer);
    this.pool.stop();
    this.active = null;
    this.welcomed = false;
  }

  kick() {
    this.pool.kick();
  }

  /** Ask the car to use this phone again (after another phone took over). */
  claim() {
    this.welcomed = false;
    this.ownedByOther = false;
    this._hello();
  }

  get carConnected() {
    return now() - this.carLastSeen < CONFIG.carTimeoutMs;
  }

  /**
   * Send one averaged motion sample: `a` linear acceleration and `g` gravity
   * reaction (m/s², phone axes), `r` mean rotation rate (deg/s) if known.
   * Returns false if nobody is listening.
   */
  sendMotion(a, g, hz, r) {
    if (!this.active || !this.carConnected || !this.welcomed) return false;
    this.seq++;
    const msg = { t: 'm', id: this.id, n: this.seq, a, g, hz };
    if (r != null) msg.r = r;
    if (this.seq % 25 === 1 && this.rtt != null) msg.rtt = Math.round(this.rtt);
    return this.pool.publish(this.active, this.topics.up, JSON.stringify(msg));
  }

  getState() {
    let state;
    const relay = relayState(this.pool.summary);
    if (relay.state !== 'up') state = relay.state === 'connecting' ? 'connecting' : 'offline';
    else if (!this.carConnected) state = 'searching';
    else if (this.ownedByOther) state = 'taken';
    else if (!this.welcomed) state = 'searching';
    else state = 'connected';
    return { state, relay, active: this.active, rtt: this.rtt, car: this.car };
  }

  _hello() {
    const msg = JSON.stringify({ t: 'hi', id: this.id, dev: this.device });
    for (const id of this.pool.upIds) this.pool.publish(id, this.topics.up, msg);
  }

  _housekeeping() {
    this._tick++;
    // Drop a relay that went quiet and fall back to the freshest other one.
    if (this.active && now() - (this.seen[this.active] || -Infinity) > 2000) this._failover();
    if (!this.welcomed && !this.ownedByOther) this._hello();
    else if (this.welcomed && this.active && this._tick % 2 === 0) this._ping();
  }

  /** A relay connected or dropped: react now instead of waiting for a tick. */
  _relaysChanged() {
    if (this.active && !this.pool.upIds.includes(this.active)) this._failover();
    if (!this.welcomed && !this.ownedByOther) this._hello();
  }

  /** Move to the connected relay where the car was heard most recently. */
  _failover() {
    const t = now();
    const up = this.pool.upIds;
    let best = null;
    for (const id of up) {
      if (id === this.active) continue;
      const at = this.seen[id] || -Infinity;
      if (t - at < 2500 && (!best || at > this.seen[best])) best = id;
    }
    this.active = best;
    if (!best) this.welcomed = false;
  }

  _ping() {
    const k = (this._pingId = (this._pingId + 1) % 100000);
    this._pings.set(k, now());
    if (this._pings.size > 20) this._pings.delete(this._pings.keys().next().value);
    this.pool.publish(this.active, this.topics.up, JSON.stringify({ t: 'pi', id: this.id, k }));
  }

  _onMessage(brokerId, topic, payload) {
    if (topic !== this.topics.down) return;
    const msg = parse(payload);
    if (!msg) return;
    const t = now();

    if (msg.t === 'po') {
      const sent = this._pings.get(msg.k);
      if (sent != null) {
        this._pings.delete(msg.k);
        const rtt = t - sent;
        this.rtt = this.rtt == null ? rtt : this.rtt * 0.7 + rtt * 0.3;
      }
      return;
    }

    if (msg.t !== 'hb' && msg.t !== 'wel') return;
    this.seen[brokerId] = t;
    this.carLastSeen = t;

    if (msg.t === 'wel') {
      if (msg.ph !== this.id) return;
      if (!this.welcomed) {
        this.welcomed = true;
        this.ownedByOther = false;
        this.active = brokerId; // first relay to answer wins
      }
      return;
    }

    // Heartbeat.
    this.car = msg;
    if (!this.active) this.active = brokerId;
    if (this.welcomed && msg.ph && msg.ph !== this.id) {
      this.ownedByOther = true; // another phone took over this car
      this.welcomed = false;
    } else if (this.ownedByOther && !msg.ph) {
      this.ownedByOther = false; // the other phone left; reconnect on the next tick
    } else if (!this.welcomed && msg.ph === this.id) {
      this.welcomed = true;
      this.active = brokerId;
    }
  }
}

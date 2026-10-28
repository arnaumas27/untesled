/**
 * mqtt.js — minimal MQTT 3.1.1 client over WebSocket (no dependencies).
 *
 * Supports exactly what Untesled needs: CONNECT, SUBSCRIBE and PUBLISH with
 * QoS 0, keep-alive pings and dead-connection detection. One instance is one
 * connection attempt; create a new client to reconnect.
 */

const TYPE = {
  CONNECT: 1,
  CONNACK: 2,
  PUBLISH: 3,
  SUBSCRIBE: 8,
  SUBACK: 9,
  PINGREQ: 12,
  PINGRESP: 13,
  DISCONNECT: 14,
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** MQTT "remaining length" variable-length integer. */
function encodeLength(n) {
  const out = [];
  do {
    let byte = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) byte |= 0x80;
    out.push(byte);
  } while (n > 0);
  return out;
}

/** Build a packet from a header byte and body chunks (Uint8Array or number[]). */
function packet(header, ...chunks) {
  const bodyLen = chunks.reduce((sum, c) => sum + c.length, 0);
  const len = encodeLength(bodyLen);
  const out = new Uint8Array(1 + len.length + bodyLen);
  out[0] = header;
  out.set(len, 1);
  let offset = 1 + len.length;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** UTF-8 string prefixed with its 16-bit length. */
function lengthPrefixed(str) {
  const bytes = encoder.encode(str);
  const out = new Uint8Array(bytes.length + 2);
  out[0] = bytes.length >> 8;
  out[1] = bytes.length & 0xff;
  out.set(bytes, 2);
  return out;
}

export function randomClientId(prefix = 'ut-') {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let id = prefix;
  for (const b of bytes) id += chars[b % chars.length];
  return id.slice(0, 23); // MQTT 3.1.1 servers must accept up to 23 bytes
}

export class MqttClient {
  /**
   * @param {string} url  wss://host:port/path
   * @param {object} [opts]
   * @param {string} [opts.clientId]
   * @param {number} [opts.keepalive=20] seconds
   * @param {string} [opts.username]
   * @param {string} [opts.password]
   * @param {number} [opts.connectTimeout=8000] ms
   */
  constructor(url, opts = {}) {
    this.url = url;
    this.clientId = opts.clientId || randomClientId();
    this.keepalive = opts.keepalive ?? 20;
    this.username = opts.username;
    this.password = opts.password;
    this.connectTimeout = opts.connectTimeout ?? 8000;

    /** @type {(topic: string, payload: Uint8Array) => void} */
    this.onmessage = null;
    /** @type {(reason: string) => void} */
    this.onclose = null;

    this.connected = false;
    this._ws = null;
    this._rx = null; // partial packet bytes
    this._lastRx = 0;
    this._pingTimer = null;
    this._packetId = 1;
    this._closed = false;
  }

  /** Open the socket and complete the MQTT handshake. Resolves on CONNACK. */
  connect() {
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (reason) => {
        if (!settled) {
          settled = true;
          reject(new Error(reason));
        }
        this._teardown(reason);
      };

      let ws;
      try {
        ws = new WebSocket(this.url, ['mqtt']);
      } catch (err) {
        fail(`socket error: ${err.message}`);
        return;
      }
      ws.binaryType = 'arraybuffer';
      this._ws = ws;

      const timer = setTimeout(() => fail('connect timeout'), this.connectTimeout);

      ws.onopen = () => this._send(this._connectPacket());

      ws.onmessage = (ev) => {
        if (typeof ev.data === 'string') return; // MQTT is binary only
        this._lastRx = Date.now();
        this._receive(new Uint8Array(ev.data), (code) => {
          clearTimeout(timer);
          if (settled) return;
          settled = true;
          if (code === 0) {
            this.connected = true;
            this._startPings();
            resolve();
          } else {
            reject(new Error(`broker refused connection (code ${code})`));
            this._teardown(`refused ${code}`);
          }
        });
      };

      ws.onerror = () => {
        clearTimeout(timer);
        fail('socket error');
      };
      ws.onclose = () => {
        clearTimeout(timer);
        fail('socket closed');
      };
    });
  }

  subscribe(topic) {
    const id = this._nextPacketId();
    this._send(packet(0x82, [id >> 8, id & 0xff], lengthPrefixed(topic), [0]));
  }

  /** Publish with QoS 0. `payload` may be a string or bytes. */
  publish(topic, payload) {
    if (!this.connected) return false;
    const body = typeof payload === 'string' ? encoder.encode(payload) : payload;
    return this._send(packet(TYPE.PUBLISH << 4, lengthPrefixed(topic), body));
  }

  close() {
    if (this._closed) return;
    if (this.connected) this._send(new Uint8Array([TYPE.DISCONNECT << 4, 0]));
    this._teardown('closed by client');
  }

  // ---- internals ----

  _connectPacket() {
    let flags = 0x02; // clean session
    const payload = [lengthPrefixed(this.clientId)];
    if (this.username != null) {
      flags |= 0x80;
      payload.push(lengthPrefixed(this.username));
    }
    if (this.password != null) {
      flags |= 0x40;
      payload.push(lengthPrefixed(this.password));
    }
    const header = [0, 4, 0x4d, 0x51, 0x54, 0x54, 4, flags, this.keepalive >> 8, this.keepalive & 0xff];
    return packet(TYPE.CONNECT << 4, header, ...payload);
  }

  _nextPacketId() {
    this._packetId = (this._packetId % 65535) + 1;
    return this._packetId;
  }

  _send(bytes) {
    const ws = this._ws;
    if (!ws || ws.readyState !== 1) return false;
    // Drop data if the socket is badly backed up: stale telemetry is useless.
    if (ws.bufferedAmount > 64 * 1024) return false;
    try {
      ws.send(bytes);
      return true;
    } catch {
      return false;
    }
  }

  /** Parse one WebSocket frame, which may hold several or partial packets. */
  _receive(chunk, onConnack) {
    let data = chunk;
    if (this._rx) {
      data = new Uint8Array(this._rx.length + chunk.length);
      data.set(this._rx);
      data.set(chunk, this._rx.length);
      this._rx = null;
    }

    let offset = 0;
    while (offset + 2 <= data.length) {
      const header = data[offset];
      let len = 0;
      let mult = 1;
      let i = offset + 1;
      let complete = false;
      while (i < data.length && i < offset + 5) {
        const b = data[i++];
        len += (b & 0x7f) * mult;
        mult *= 128;
        if ((b & 0x80) === 0) {
          complete = true;
          break;
        }
      }
      if (!complete || i + len > data.length) break; // wait for more bytes
      this._handle(header >> 4, header & 0x0f, data.subarray(i, i + len), onConnack);
      offset = i + len;
    }
    if (offset < data.length) this._rx = data.slice(offset);
  }

  _handle(type, flags, body, onConnack) {
    switch (type) {
      case TYPE.CONNACK:
        onConnack(body.length >= 2 ? body[1] : 255);
        break;
      case TYPE.PUBLISH: {
        const qos = (flags >> 1) & 3;
        const topicLen = (body[0] << 8) | body[1];
        const topic = decoder.decode(body.subarray(2, 2 + topicLen));
        let p = 2 + topicLen;
        if (qos > 0) p += 2; // packet identifier (we only subscribe at QoS 0)
        if (this.onmessage) this.onmessage(topic, body.subarray(p));
        break;
      }
      default:
        break; // SUBACK, PINGRESP: nothing to do beyond _lastRx bookkeeping
    }
  }

  _startPings() {
    const intervalMs = Math.max(2000, (this.keepalive * 1000) / 2);
    this._pingTimer = setInterval(() => {
      if (Date.now() - this._lastRx > this.keepalive * 1500) {
        this._teardown('keepalive timeout');
        return;
      }
      this._send(new Uint8Array([TYPE.PINGREQ << 4, 0]));
    }, intervalMs);
  }

  _teardown(reason) {
    if (this._closed) return;
    this._closed = true;
    this.connected = false;
    clearInterval(this._pingTimer);
    const ws = this._ws;
    this._ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
    if (this.onclose) this.onclose(reason);
  }
}

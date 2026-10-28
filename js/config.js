/**
 * config.js — settings shared by the car page and the phone page.
 */

export const CONFIG = {
  /**
   * Public MQTT-over-WebSocket brokers used as a tiny relay between the phone
   * and the car. Both pages connect to all of them in parallel and use the
   * first one where the other side answers, so one broker being down or
   * blocked doesn't break pairing. Put your own broker first if you run one.
   * Messages contain only acceleration, RPM and speed (no location).
   */
  brokers: [
    { id: 'emqx', url: 'wss://broker.emqx.io:8084/mqtt' },
    { id: 'hivemq', url: 'wss://broker.hivemq.com:8884/mqtt' },
    { id: 'mosquitto', url: 'wss://test.mosquitto.org:8081/mqtt' },
    { id: 'eclipse', url: 'wss://mqtt.eclipseprojects.io:443/mqtt' },
  ],

  /** Topic namespace. Change it if you fork the protocol. */
  topicPrefix: 'untesled/v1',

  /** Phone → car motion messages per second. */
  phoneSendHz: 25,

  /** Car → phone heartbeat rate on the broker the phone uses (Hz). */
  heartbeatHz: 4,

  /** The phone counts as lost after this long without data (ms). */
  phoneTimeoutMs: 1500,

  /** The car counts as lost (on the phone) after this long without heartbeats (ms). */
  carTimeoutMs: 3000,
};

/**
 * Brokers to use, honouring a `?broker=wss://host:port/path` override
 * (comma-separated for several). Handy for self-hosting and testing.
 */
export function resolveBrokers(search = typeof location !== 'undefined' ? location.search : '') {
  const param = new URLSearchParams(search).get('broker');
  if (!param) return CONFIG.brokers;
  return param
    .split(',')
    .map((url) => url.trim())
    .filter((url) => /^wss?:\/\//i.test(url))
    .map((url, i) => ({ id: `custom${i + 1}`, url }));
}

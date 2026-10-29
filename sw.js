/**
 * sw.js — lets Untesled open even without a connection once it has been
 * visited. Network first, so a new deploy shows up on the next load; the
 * cache is only used when the network fails or takes more than 4 s.
 */

const CACHE = 'untesled-v4';
const ASSETS = [
  './',
  'index.html',
  'phone.html',
  'style.css',
  'js/app.js',
  'js/audio.js',
  'js/config.js',
  'js/dsp.js',
  'js/engine-worklet.js',
  'js/fusion.js',
  'js/gps.js',
  'js/link.js',
  'js/mqtt.js',
  'js/phone.js',
  'js/powertrains.js',
  'js/qr.js',
  'js/signs.js',
  'js/simulator.js',
  'js/sounds.js',
  'js/synth-carriage.js',
  'js/synth-freighter.js',
  'js/synth-jet.js',
  'js/synth-piston.js',
  'js/ui.js',
  'js/vehicle.js',
  'assets/icon.svg',
  'assets/fonts/michroma.woff2',
  'assets/fonts/tilt-neon-400.woff2',
  'assets/fonts/barlow-semi-condensed-400.woff2',
  'assets/fonts/barlow-semi-condensed-500.woff2',
  'assets/fonts/barlow-semi-condensed-600.woff2',
  'assets/fonts/barlow-semi-condensed-700.woff2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function fromNetwork(request, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(reject, timeoutMs);
    fetch(request).then(
      (response) => {
        clearTimeout(timer);
        resolve(response);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    fromNetwork(request, 4000)
      .then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(() => caches.match(request, { ignoreSearch: true }).then((hit) => hit || fetch(request))),
  );
});

/**
 * sounds.js — the sounds you can pick in Settings. Each one brings its own
 * model (how it reacts to the car), synth voice, dial and labels; its neon
 * sign lives in signs.js.
 */

import { Vehicle, FLAT6, V8, MOTO } from './vehicle.js';
import { Turbofan, Freighter, Carriage } from './powertrains.js';

const PISTON_HINTS = {
  comfort: 'Early, smooth upshifts and a quieter exhaust at low load.',
  sport: 'Holds gears longer, blips on downshifts, crackles when you lift.',
  track: 'Revs to the limit, aggressive downshifts, maximum crackle.',
};

const rpmDial = (max, red, major, minor) => ({ max, red, major, minor, label: (v) => String(v / 1000), unit: '×1000 rpm' });

export const SOUNDS = [
  {
    id: 'flat6',
    ready: 'fire up the engine',
    name: 'Flat six',
    hint: 'Porsche 911 GT3: a 4.0 flat-six to 9,000 rpm with a 7-speed PDK.',
    make: () => new Vehicle(FLAT6),
    dial: rpmDial(10000, 9000, 1000, 250),
    lights: FLAT6.lights,
    startNoun: 'Engine',
    revLabel: 'Hold to rev',
    pops: true,
    modeHints: PISTON_HINTS,
  },
  {
    id: 'v8',
    ready: 'fire up the engine',
    name: 'Classic V8',
    hint: 'A 70s muscle car: lazy, lumpy V8 burble and a 3-speed automatic.',
    make: () => new Vehicle(V8),
    dial: rpmDial(7000, 5800, 1000, 250),
    lights: V8.lights,
    startNoun: 'Engine',
    revLabel: 'Hold to rev',
    pops: true,
    modeHints: {
      comfort: 'Cruising: early shifts and a muffled rumble.',
      sport: 'Holds each gear longer, open exhaust.',
      track: 'Drag strip: late shifts and loud burble when you lift.',
    },
  },
  {
    id: 'moto',
    ready: 'fire up the engine',
    name: 'Superbike',
    hint: 'A 1000 cc inline-four screaming to 14,000 rpm, with quickshifter and pops.',
    make: () => new Vehicle(MOTO),
    dial: rpmDial(16000, 14000, 2000, 500),
    lights: MOTO.lights,
    startNoun: 'Engine',
    revLabel: 'Hold to rev',
    pops: true,
    modeHints: {
      comfort: 'Road mode: short shifts, a quieter exhaust.',
      sport: 'Holds gears high in the revs, blips on downshifts.',
      track: 'Race mode: shifts near the limiter, crackles on every lift.',
    },
  },
  {
    id: 'jet',
    ready: 'start the engine',
    name: 'Jet engine',
    hint: 'A CFM56-style turbofan: starter whine, slow spool-up, takeoff roar. Brake hard for reverse thrust.',
    make: () => new Turbofan(),
    dial: { max: 110, red: 100, major: 10, minor: 5, label: (v) => (v % 20 === 0 ? String(v) : ''), unit: 'N1 %' },
    lights: [70, 98],
    startNoun: 'Engine',
    revLabel: 'Hold for takeoff thrust',
    pops: false,
    modeHints: {
      comfort: 'Lazy spool-up, like a heavy airliner.',
      sport: 'A typical spool-up from idle to takeoff thrust.',
      track: 'Fighter-quick spool-up.',
    },
  },
  {
    id: 'freighter',
    ready: 'power up the reactor',
    name: 'Space freighter',
    hint: 'Film sci-fi starship drive: pulsing warp-core drone, metallic roar, spacey swirl. At a standstill, hold the button to jump to hyperspace.',
    make: () => new Freighter(),
    dial: { max: 100, red: 90, major: 10, minor: 5, label: (v) => (v % 20 === 0 ? String(v) : ''), unit: 'power %' },
    lights: [60, 95],
    startNoun: 'Reactor',
    revLabel: 'Hold to punch it',
    pops: false,
    modeHints: {
      comfort: 'Smooth, gentle power changes.',
      sport: 'Quick power response.',
      track: 'Instant power: point it and go.',
    },
  },
  {
    id: 'carriage',
    ready: 'hitch up the horse',
    name: 'Horse carriage',
    hint: 'Clip-clop: walk, trot, canter and gallop with your speed. Floor it and the whip cracks.',
    make: () => new Carriage(),
    dial: { max: 180, red: 150, major: 30, minor: 10, label: (v) => String(v), unit: 'strides / min' },
    lights: [110, 150],
    startNoun: 'Horse',
    revLabel: 'Hold to rear up',
    pops: false,
    modeHints: {
      comfort: 'A calm horse and no whip.',
      sport: 'The whip cracks when you floor it.',
      track: 'A lively horse: more whinnies, more whip.',
    },
  },
];

export const DEFAULT_SOUND = 'flat6';

export function soundById(id) {
  return SOUNDS.find((s) => s.id === id) || SOUNDS[0];
}

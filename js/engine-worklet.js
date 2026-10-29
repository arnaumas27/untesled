/**
 * engine-worklet.js — the sound engine's entry point.
 *
 * Runs inside an AudioWorklet (registered as 'untesled-engine'); the same
 * SynthHost also powers the ScriptProcessor fallback and the offline
 * renderer used in tests.
 *
 * The host owns one synth per sound and switches between them with a short
 * crossfade. Messages from the main thread:
 *   {voice: 'flat6' | 'v8' | 'moto' | 'jet' | 'freighter' | 'carriage'}
 *   {trigger: name}   one-shot sounds (whinny, whip, hyperspace jump…)
 *   {...params}       the current state for the synth (rpm, load, n1, gait…)
 */

import { PistonSynth, PISTON_VOICES, FlatSixSynth } from './synth-piston.js';
import { TurbofanSynth } from './synth-jet.js';
import { FreighterSynth } from './synth-freighter.js';
import { CarriageSynth } from './synth-carriage.js';

export { FlatSixSynth, PistonSynth, PISTON_VOICES, TurbofanSynth, FreighterSynth, CarriageSynth };

/** A synth for `voice` (unknown voices get the flat-six). */
export function createSynth(voice, sampleRate, seed) {
  switch (voice) {
    case 'v8':
    case 'moto':
      return new PistonSynth(sampleRate, seed || 4242, PISTON_VOICES[voice]);
    case 'jet':
      return new TurbofanSynth(sampleRate, seed);
    case 'freighter':
      return new FreighterSynth(sampleRate, seed);
    case 'carriage':
      return new CarriageSynth(sampleRate, seed);
    default:
      return new FlatSixSynth(sampleRate, seed);
  }
}

const FADE_SECONDS = 0.12;

export class SynthHost {
  constructor(sampleRate, voice = 'flat6') {
    this.sr = sampleRate;
    this.voice = voice;
    this.synth = createSynth(voice, sampleRate);
    this.old = null; // the previous synth, fading out
    this.fade = 0;
    this.scratchL = new Float32Array(128);
    this.scratchR = new Float32Array(128);
    /** Called with synth events, e.g. {type:'pop', amp}. */
    this.onEvent = null;
    this._wire();
  }

  _wire() {
    this.synth.onEvent = (ev) => this.onEvent && this.onEvent(ev);
  }

  setVoice(voice) {
    if (!voice || voice === this.voice) return;
    this.old = this.synth;
    this.old.onEvent = null;
    this.fade = 1;
    this.voice = voice;
    this.synth = createSynth(voice, this.sr);
    this._wire();
  }

  /** Handle one message from the main thread. */
  message(data) {
    if (!data) return;
    if (data.voice) this.setVoice(data.voice);
    else if (data.trigger) this.synth.trigger(data.trigger);
    else this.synth.setParams(data);
  }

  render(outL, outR, start = 0, end = outL.length) {
    this.synth.render(outL, outR, start, end);
    if (!this.old) return;
    const len = end - start;
    if (this.scratchL.length < len) {
      this.scratchL = new Float32Array(len);
      this.scratchR = new Float32Array(len);
    }
    const L = this.scratchL;
    const R = this.scratchR;
    this.old.render(L, R, 0, len);
    const step = 1 / (FADE_SECONDS * this.sr);
    for (let i = 0; i < len; i++) {
      this.fade = Math.max(0, this.fade - step);
      const g = this.fade * this.fade;
      outL[start + i] = outL[start + i] * (1 - g) + L[i] * g;
      outR[start + i] = outR[start + i] * (1 - g) + R[i] * g;
    }
    if (this.fade <= 0) this.old = null;
  }
}

// ---------------------------------------------------------------------------
// AudioWorklet registration (only inside an AudioWorkletGlobalScope)
// ---------------------------------------------------------------------------

if (typeof registerProcessor === 'function') {
  class EngineProcessor extends AudioWorkletProcessor {
    constructor(options) {
      super();
      const voice = options && options.processorOptions && options.processorOptions.voice;
      // `sampleRate` is a global in the worklet scope.
      this.host = new SynthHost(sampleRate, voice || 'flat6');
      this.host.onEvent = (ev) => this.port.postMessage(ev);
      this.port.onmessage = (e) => this.host.message(e.data);
    }

    process(_inputs, outputs) {
      const out = outputs[0];
      const L = out[0];
      const R = out[1] || out[0];
      this.host.render(L, R, 0, L.length);
      return true;
    }
  }
  registerProcessor('untesled-engine', EngineProcessor);
}

/**
 * audio.js — Web Audio output for the engine synth.
 *
 * Uses an AudioWorklet (audio runs on its own thread) and falls back to a
 * ScriptProcessorNode running the very same synth on browsers without
 * worklet support. Add `?noworklet` to the URL to force the fallback.
 */

import { FlatSixSynth } from './engine-worklet.js';

/** Perceptual volume curve: slider 0..1 → gain. */
const volumeToGain = (v) => v * v;

export class EngineAudio {
  constructor() {
    this.ctx = null;
    this.node = null;
    this.master = null;
    this.synth = null; // only in fallback mode
    this.mode = null; // 'worklet' | 'script'
    this.volume = 0.7;
    /** Called with the pop strength (0..1) when the exhaust pops. */
    this.onPop = null;
    /** Called when the browser suspends or resumes audio. */
    this.onStateChange = null;
  }

  get ready() {
    return !!this.node;
  }

  get running() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  /**
   * Create the audio graph. Call it from a tap or click: browsers only allow
   * sound to start in response to a user gesture.
   */
  async init() {
    if (this.ctx) {
      await this.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) throw new Error('This browser has no Web Audio support.');

    const ctx = (this.ctx = new AC({ latencyHint: 'interactive' }));
    const resumed = ctx.resume(); // start inside the gesture, before any await
    ctx.onstatechange = () => this.onStateChange && this.onStateChange(ctx.state);

    this.master = ctx.createGain();
    this.master.gain.value = volumeToGain(this.volume);
    // Safety limiter so pops and bangs can't clip the car's amplifier.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -4;
    limiter.knee.value = 4;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.15;
    this.master.connect(limiter).connect(ctx.destination);

    const forceFallback = new URLSearchParams(location.search).has('noworklet');
    if (!forceFallback && ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
      try {
        await ctx.audioWorklet.addModule(new URL('./engine-worklet.js', import.meta.url));
        this.node = new AudioWorkletNode(ctx, 'flat-six', {
          numberOfInputs: 0,
          numberOfOutputs: 1,
          outputChannelCount: [2],
        });
        this.node.port.onmessage = (e) => this._event(e.data);
        this.mode = 'worklet';
      } catch (err) {
        console.warn('[audio] AudioWorklet failed, using ScriptProcessor fallback:', err);
        this.node = null;
      }
    }

    if (!this.node) {
      const synth = (this.synth = new FlatSixSynth(ctx.sampleRate));
      synth.onEvent = (ev) => this._event(ev);
      const sp = ctx.createScriptProcessor(1024, 1, 2);
      sp.onaudioprocess = (e) => {
        const out = e.outputBuffer;
        synth.render(out.getChannelData(0), out.getChannelData(1));
      };
      this.node = sp;
      this.mode = 'script';
    }

    this.node.connect(this.master);
    await resumed;
  }

  async resume() {
    if (this.ctx && this.ctx.state !== 'running') {
      try {
        await this.ctx.resume();
      } catch {
        /* needs another gesture */
      }
    }
  }

  /** Engine state for the synth (see FlatSixSynth.setParams). */
  setParams(p) {
    if (!this.node) return;
    if (this.mode === 'worklet') this.node.port.postMessage(p);
    else this.synth.setParams(p);
  }

  /** @param {number} v 0..1 */
  setVolume(v) {
    this.volume = Math.min(1, Math.max(0, v));
    if (this.master) this.master.gain.setTargetAtTime(volumeToGain(this.volume), this.ctx.currentTime, 0.05);
  }

  _event(ev) {
    if (ev && ev.type === 'pop' && this.onPop) this.onPop(ev.amp);
  }
}

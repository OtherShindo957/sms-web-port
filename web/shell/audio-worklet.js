// Plays the game's audio (platform/audio/ai.cpp, "Browser output") on the
// browser's audio thread. The game writes stereo s16 frames into a ring in
// its shared wasm memory and advances `write`; this processor reads them and
// advances `read`, both frame counters in `ctl` (Atomics, no locks). The
// AudioContext runs at the game's 32 kHz. When the ring is empty the last
// frame is held (as the desktop output does) and the frames are counted in
// `dry`, from which the game queues more audio after a hitch.
'use strict';

const WRITE = 0, READ = 1, DRY = 2, SPEED = 3;

class SmsAudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.ring = new Int16Array(o.memory, o.ring, o.frames * 2);
    this.ctl = new Uint32Array(o.memory, o.ctl, 4);
    this.frames = o.frames;
    this.l = 0;
    this.r = 0;
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const left = out[0], right = out[1] || out[0];
    const ctl = this.ctl, ring = this.ring, cap = this.frames;
    const write = Atomics.load(ctl, WRITE);
    let read = Atomics.load(ctl, READ);
    const speed = Atomics.load(ctl, SPEED) || 1;  // fast-forward: skip frames as the desktop does
    let dry = 0;
    for (let i = 0; i < left.length; i++) {
      const avail = (write - read) >>> 0;
      if (avail) {
        const p = (read % cap) * 2;
        this.l = ring[p] / 32768;
        this.r = ring[p + 1] / 32768;
        read = (read + Math.min(avail, speed)) >>> 0;
      } else {
        dry++;
      }
      left[i] = this.l;
      right[i] = this.r;
    }
    Atomics.store(ctl, READ, read);
    if (dry) Atomics.add(ctl, DRY, dry);
    return true;
  }
}

registerProcessor('sms-audio', SmsAudioProcessor);

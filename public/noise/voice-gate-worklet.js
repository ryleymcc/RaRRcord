// RaRRcord voice gate. Runs after the denoiser and passes audio only while someone is talking.
//
// Keyboard clicks and other short transients that survive denoising are rejected because the gate
// only opens after the speech band stays loud for `attackMs`. A short lookahead delay means the
// start of a word is not cut off while the gate decides. Gain changes are ramped, so opening and
// closing never click.
const BLOCK = 128;

class VoiceGate extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions ?? {};
    const ms = value => Math.max(1, Math.round((value * sampleRate) / 1000));
    this.open = 10 ** ((o.openDb ?? -44) / 20);
    this.close = 10 ** ((o.closeDb ?? -50) / 20);
    this.attackBlocks = Math.max(1, Math.round(ms(o.attackMs ?? 18) / BLOCK));
    this.holdBlocks = Math.max(1, Math.round(ms(o.holdMs ?? 320) / BLOCK));
    this.delay = ms(o.lookaheadMs ?? 24);
    this.ring = new Float32Array(this.delay + BLOCK);
    this.write = 0;
    this.rise = 1 - Math.exp(-1 / ms(2));
    this.fall = 1 - Math.exp(-1 / ms(70));
    this.gain = 0;
    this.loud = 0;
    this.hold = 0;
    this.isOpen = false;
    this.enabled = o.enabled !== false;
    // Speech-band detector: about 200 Hz to 4 kHz, so rumble and hiss do not open the gate.
    this.hpA = Math.exp((-2 * Math.PI * 200) / sampleRate);
    this.lpA = Math.exp((-2 * Math.PI * 4000) / sampleRate);
    this.hpX = 0;
    this.hpY = 0;
    this.lpY = 0;
    this.port.onmessage = event => {
      const data = event.data ?? {};
      if (typeof data.enabled === "boolean") this.enabled = data.enabled;
      if (typeof data.openDb === "number") this.open = 10 ** (data.openDb / 20);
      if (typeof data.closeDb === "number") this.close = 10 ** (data.closeDb / 20);
    };
  }

  process(inputs, outputs) {
    const input = inputs[0]?.[0];
    const output = outputs[0];
    if (!output?.length) return true;
    const frames = output[0].length;
    let energy = 0;
    for (let i = 0; i < frames; i++) {
      const x = input ? input[i] : 0;
      const hp = this.hpA * (this.hpY + x - this.hpX);
      this.hpX = x;
      this.hpY = hp;
      this.lpY = (1 - this.lpA) * hp + this.lpA * this.lpY;
      energy += this.lpY * this.lpY;
    }
    const level = Math.sqrt(energy / frames);

    if (level > this.open) this.loud++;
    else this.loud = 0;
    if (this.loud >= this.attackBlocks) {
      this.isOpen = true;
      this.hold = this.holdBlocks;
    } else if (this.isOpen && level < this.close && --this.hold <= 0) {
      this.isOpen = false;
    } else if (this.isOpen && level >= this.close) {
      this.hold = this.holdBlocks;
    }
    const target = !this.enabled || this.isOpen ? 1 : 0;

    const size = this.ring.length;
    const out = output[0];
    for (let i = 0; i < frames; i++) {
      this.ring[this.write] = input ? input[i] : 0;
      const read = (this.write - this.delay + size) % size;
      this.write = (this.write + 1) % size;
      this.gain += (target - this.gain) * (target > this.gain ? this.rise : this.fall);
      out[i] = this.ring[read] * this.gain;
    }
    for (let c = 1; c < output.length; c++) output[c].set(out);
    return true;
  }
}

registerProcessor("rarrcord-voice-gate", VoiceGate);

// RaRRcord speaking meter. Listens to one voice and reports when its talking state changes.
//
// It reads every sample, so short words are not missed the way a 200 ms snapshot misses them.
// Each 10 ms window is measured in the speech band (about 150 Hz to 4 kHz) and compared with
// whichever is higher: the sensitivity floor, or 12 dB above this voice's own background noise.
// The noise floor follows quiet stretches quickly and rises only about 1 dB a second, so steady
// fan hiss on an un-denoised mic does not count as talking but speech over it does.
// Talking starts once 3 of the last 5 windows are loud (~30 ms, so a lone key click is ignored)
// and stops after `releaseMs` with nothing above the lower "keep talking" level.
const BLOCK = 128;

class SpeakingMeter extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions ?? {};
    this.minDb = o.minDb ?? -55;
    this.windowBlocks = Math.max(1, Math.round((0.01 * sampleRate) / BLOCK));
    this.releaseWindows = Math.max(1, Math.round((o.releaseMs ?? 220) / 1000 / (this.windowBlocks * BLOCK / sampleRate)));
    this.hpA = Math.exp((-2 * Math.PI * 150) / sampleRate);
    this.lpA = Math.exp((-2 * Math.PI * 4000) / sampleRate);
    this.hpX = 0; this.hpY = 0; this.lpY = 0;
    this.energy = 0; this.blocks = 0;
    this.floor = -70;
    this.recent = 0; // bit history of loud windows
    this.quiet = 0;
    this.speaking = false;
    this.port.onmessage = event => {
      if (typeof event.data?.minDb === "number") this.minDb = event.data.minDb;
    };
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (input) {
      let energy = 0;
      for (let i = 0; i < input.length; i++) {
        const x = input[i];
        const hp = this.hpA * (this.hpY + x - this.hpX);
        this.hpX = x; this.hpY = hp;
        this.lpY = (1 - this.lpA) * hp + this.lpA * this.lpY;
        energy += this.lpY * this.lpY;
      }
      this.energy += energy / input.length;
    }
    if (++this.blocks < this.windowBlocks) return true;
    const db = 10 * Math.log10(this.energy / this.blocks + 1e-12);
    this.energy = 0; this.blocks = 0;

    const on = Math.max(this.minDb, this.floor + 12);
    const keep = on - 6;
    const loud = db > on;
    this.recent = ((this.recent << 1) | (loud ? 1 : 0)) & 0b11111;
    let count = 0;
    for (let bits = this.recent; bits; bits &= bits - 1) count++;
    if (!this.speaking && count >= 3) {
      this.speaking = true;
      this.quiet = 0;
      this.report();
    } else if (this.speaking) {
      if (db > keep) this.quiet = 0;
      else if (++this.quiet >= this.releaseWindows) {
        this.speaking = false;
        this.report();
      }
    }
    // Background noise: fall fast to anything quieter, creep up slowly, never while talking.
    if (db < this.floor) this.floor += (db - this.floor) * 0.3;
    else if (!this.speaking) this.floor += 0.01;
    this.floor = Math.min(-30, Math.max(-85, this.floor));
    return true;
  }

  report() { this.port.postMessage({ speaking: this.speaking }); }
}

registerProcessor("rarrcord-speaking-meter", SpeakingMeter);

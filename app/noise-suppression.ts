import type { Preferences } from "./ra-client";

// "strong" runs GTCRN, a small neural denoiser that removes keyboard, mouse and fan noise well.
// "standard" runs RNNoise, which is lighter on CPU. Both are followed by a voice gate that keeps
// the line silent between words. "browser" uses the browser's built-in suppression only.
export type SuppressionMode = NonNullable<Preferences["suppression"]>;
export const suppressionModes: { value: SuppressionMode; label: string }[] = [
  { value: "strong", label: "Strong · AI voice isolation" },
  { value: "standard", label: "Standard · lighter on CPU" },
  { value: "browser", label: "Browser built-in" },
  { value: "off", label: "Off" },
];

export function suppressionMode(prefs: Pick<Preferences, "noise" | "suppression">): SuppressionMode {
  if (prefs.suppression && suppressionModes.some(m => m.value === prefs.suppression)) return prefs.suppression;
  // Settings saved before the AI modes existed only had an on/off switch.
  return prefs.noise === false ? "off" : "strong";
}

export function workletSupported() {
  return typeof AudioContext !== "undefined" && typeof AudioWorkletNode !== "undefined";
}

const usesModel = (mode: SuppressionMode) => mode === "strong" || mode === "standard";

/** getUserMedia constraints. The browser's own suppressor is turned off when a model replaces it, so the two do not fight. */
export function microphoneConstraints(prefs: Preferences, modelAvailable = workletSupported()): MediaStreamConstraints {
  const mode = suppressionMode(prefs);
  const model = usesModel(mode) && modelAvailable;
  return {
    audio: {
      deviceId: prefs.input ? { exact: prefs.input } : undefined,
      noiseSuppression: mode !== "off" && !model,
      echoCancellation: prefs.echo,
      autoGainControl: prefs.gain,
    },
  };
}

export type VoiceProcessor = {
  /** The stream to send. It is the raw microphone stream when no model runs. */
  stream: MediaStream;
  context?: AudioContext;
  /** Processed audio, for level meters. */
  output?: AudioNode;
  mode: SuppressionMode;
  /** Set when a model was asked for but could not run. */
  fallback?: string;
  setGate(enabled: boolean): void;
  close(): void;
};

const base = "/noise/";
const binaries = new Map<string, Promise<ArrayBuffer>>();
function binary(name: string) {
  let pending = binaries.get(name);
  if (!pending) {
    pending = fetch(base + name).then(r => {
      if (!r.ok) throw new Error("Could not load " + name);
      return r.arrayBuffer();
    });
    pending.catch(() => binaries.delete(name));
    binaries.set(name, pending);
  }
  // Each worklet gets its own copy, because posting the options can detach the buffer.
  return pending.then(buffer => buffer.slice(0));
}
const simd = () => WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));

/**
 * Builds mic → high-pass → denoiser → voice gate → stream.
 * Never throws: if anything fails it returns the raw stream and turns on the browser's suppressor instead.
 */
export async function processVoice(raw: MediaStream, prefs: Preferences): Promise<VoiceProcessor> {
  const mode = suppressionMode(prefs);
  const passthrough = (fallback?: string): VoiceProcessor => ({ stream: raw, mode, fallback, setGate() {}, close() {} });
  if (!usesModel(mode)) return passthrough();
  // microphoneConstraints already asked the browser to suppress noise in this case.
  if (!workletSupported()) return passthrough();
  let context: AudioContext | undefined;
  try {
    // Both models are built for 48 kHz audio.
    context = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    const strong = mode === "strong";
    const [wasm] = await Promise.all([
      strong ? binary("gtcrn.wasm") : binary(simd() ? "rnnoise_simd.wasm" : "rnnoise.wasm"),
      context.audioWorklet.addModule(base + (strong ? "gtcrn-worklet.js" : "rnnoise-worklet.js")),
      context.audioWorklet.addModule(base + "voice-gate-worklet.js"),
    ]);
    const source = context.createMediaStreamSource(raw);
    // Desk thumps and rumble carry no speech.
    const highpass = new BiquadFilterNode(context, { type: "highpass", frequency: 80, Q: 0.7 });
    const denoiser = new AudioWorkletNode(context, strong ? "@sapphi-red/web-noise-suppressor/gtcrn" : "@sapphi-red/web-noise-suppressor/rnnoise", {
      channelCount: 1, channelCountMode: "explicit", processorOptions: { maxChannels: 1, wasmBinary: wasm },
    });
    const gate = new AudioWorkletNode(context, "rarrcord-voice-gate", {
      channelCount: 1, channelCountMode: "explicit", processorOptions: { enabled: prefs.voiceGate !== false },
    });
    const destination = context.createMediaStreamDestination();
    destination.channelCount = 1;
    source.connect(highpass).connect(denoiser).connect(gate).connect(destination);
    void context.resume();
    const stream = destination.stream;
    const [input] = raw.getAudioTracks(), [output] = stream.getAudioTracks();
    // Let callers watch the processed track like the device track: it ends when the device does.
    input?.addEventListener("ended", () => { output?.stop(); output?.dispatchEvent(new Event("ended")); });
    const ctx = context;
    return {
      stream, context: ctx, output: gate, mode,
      setGate(enabled) { gate.port.postMessage({ enabled }); },
      close() {
        try { (denoiser.port as MessagePort).postMessage("destroy"); } catch {}
        source.disconnect();
        stream.getTracks().forEach(t => t.stop());
        void ctx.close().catch(() => {});
      },
    };
  } catch (error) {
    if (context) void context.close().catch(() => {});
    const fallback = { ...(microphoneConstraints(prefs, false).audio as MediaTrackConstraints) };
    delete fallback.deviceId;
    await raw.getAudioTracks()[0]?.applyConstraints(fallback).catch(() => {});
    return passthrough("AI noise suppression could not start, so the browser's suppression is used instead. " + (error instanceof Error ? error.message : ""));
  }
}

import type { Preferences } from "./ra-client";

// "smooth"  1080p at up to 144 FPS, tuned for motion (games, video). The default.
// "maximum" native resolution and refresh rate, tuned for text clarity.
// "custom"  the user's own resolution, frame rate, bitrate, codec and mode.
const qualityOrder = ["video/av1", "video/vp9", "video/h264", "video/vp8"];
// Software AV1/VP9 encoders cannot keep up with 1080p at 144 FPS. H.264 is the codec most
// likely to have a hardware encoder, so it leads until the browser says otherwise.
const smoothOrder = ["video/h264", "video/av1", "video/vp9", "video/vp8"];

// WebRTC falls back to a 2.5 Mbps ceiling above 960×540 when no maxBitrate is set, which
// blurs any screen share in motion. This estimate (~0.08 bits per pixel per frame) is roughly
// what H.264 needs for clean motion; it is clamped so slow links still get a sane ceiling.
export function defaultBitrateKbps(width: number, height: number, fps: number) {
  const estimate = Math.round(width * height * fps * 0.08 / 1000);
  return Math.min(50000, Math.max(2500, estimate));
}

export type ScreenProfile = ReturnType<typeof screenShareSettings>;

export function screenShareSettings(preferences: Preferences, adminBitrate: number) {
  const profile = preferences.screenQuality === "custom" ? "custom" : preferences.screenQuality === "maximum" ? "maximum" : "smooth";
  const target = /^\d{3,4}x\d{2,3}$/.test(preferences.resolution) ? preferences.resolution : "1080x60";
  const [customHeight, customFps] = target.split("x").map(Number);
  const height = profile === "smooth" ? 1080 : profile === "maximum" ? 2160 : customHeight;
  const fps = profile === "custom" ? customFps : 144;
  const width = Math.round(height * 16 / 9);
  const personal = profile === "custom" && preferences.bitrate > 0 ? preferences.bitrate : defaultBitrateKbps(width, height, fps);
  const caps = [adminBitrate, personal].filter(n => Number.isSafeInteger(n) && n > 0);
  const hint: "motion" | "detail" = profile === "maximum" || (profile === "custom" && preferences.mode === "detail") ? "detail" : "motion";
  return {
    profile,
    maximum: profile === "maximum",
    capture: profile === "maximum" ? {frameRate:{ideal:fps}} :
      {width:{ideal:width,max:width},height:{ideal:height,max:height},frameRate:{ideal:fps,max:fps}},
    frameRateCap: fps,
    bitrateCap: Math.min(...caps) * 1000,
    hint,
    // Motion keeps the frame rate and lets resolution drop under load; detail keeps text sharp.
    degradation: (hint === "detail" ? "maintain-resolution" : "maintain-framerate") as RTCDegradationPreference,
    codec: profile === "custom" ? preferences.codec : profile === "smooth" ? "smooth" : "quality",
    width, height, fps,
  };
}

// The track reports its real frame rate once capture starts; the encoder ceiling follows it so a
// 165 Hz monitor is not held to 144 and a 60 Hz one does not reserve bitrate for frames it never makes.
export function encoderFrameRate(profile: ScreenProfile, captured?: number) {
  if (profile.profile === "maximum" && captured && Number.isFinite(captured) && captured > 0) return Math.round(captured);
  return profile.frameRateCap;
}

type Probe = {mimeType:string; smooth:boolean; powerEfficient:boolean};
const probes = new Map<string, Promise<Probe[]>>();

// Asks the browser which codecs it can encode smoothly, and in hardware, at this size and rate.
export function probeEncoders(width: number, height: number, fps: number, bitrateKbps: number, mimeTypes: string[]) {
  const key = [width, height, fps, bitrateKbps, ...mimeTypes].join(":");
  let probe = probes.get(key);
  if (!probe) {
    const capabilities = typeof navigator === "undefined" ? undefined : navigator.mediaCapabilities;
    probe = Promise.all(mimeTypes.map(async mimeType => {
      try {
        if (!capabilities?.encodingInfo) throw new Error("unsupported");
        const info = await capabilities.encodingInfo({type:"webrtc", video:{contentType:mimeType, width, height, bitrate:bitrateKbps*1000, framerate:fps}} as MediaEncodingConfiguration);
        return {mimeType, smooth:info.supported && info.smooth, powerEfficient:info.supported && info.powerEfficient};
      } catch {
        return {mimeType, smooth:false, powerEfficient:false};
      }
    }));
    probes.set(key, probe);
  }
  return probe;
}

export function videoCodecPreferences<T extends {mimeType:string}>(codecs: T[], preference: string, probed: Probe[] = []) {
  const order = preference === "quality" ? qualityOrder : preference === "smooth" ? smoothOrder : ["video/" + preference.toLowerCase()];
  const known = new Map(probed.map(p => [p.mimeType.toLowerCase(), p]));
  function rank(codec:T) {
    const mime = codec.mimeType.toLowerCase();
    const index = order.indexOf(mime);
    if (index === -1) return order.length * 3;
    // A hardware encoder that keeps up beats one that keeps up in software, which beats one that cannot.
    const p = preference === "smooth" ? known.get(mime) : undefined;
    const tier = !p ? 0 : p.powerEfficient && p.smooth ? 0 : p.smooth ? 1 : 2;
    return tier * order.length + index;
  }
  return [...codecs].sort((a,b)=>rank(a)-rank(b));
}

export async function applyNativeCapture(track: MediaStreamTrack) {
  const caps = track.getCapabilities?.();
  const current = track.getSettings();
  const constraints: MediaTrackConstraints = {frameRate:{ideal:144}};
  let apply = false;
  for (const key of ["width","height","frameRate"] as const) {
    const maximum=caps?.[key]?.max;
    if (!maximum || !Number.isFinite(maximum) || maximum <= (current[key] ?? 0)) continue;
    constraints[key]={ideal:maximum};
    apply = true;
  }
  if (apply) await track.applyConstraints(constraints);
}

// Display audio is game or video sound, not a voice: browser voice processing only harms it.
export const displayMediaOptions = (profile: ScreenProfile) => ({
  video: profile.capture,
  audio: {echoCancellation:false, noiseSuppression:false, autoGainControl:false},
  systemAudio: "include",
  selfBrowserSurface: "exclude",
  surfaceSwitching: "include",
}) as DisplayMediaStreamOptions;

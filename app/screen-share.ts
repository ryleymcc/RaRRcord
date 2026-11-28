import type { Preferences } from "./ra-client";

// "smooth"  1080p at 60 FPS, tuned for motion (games, video). The default.
// "maximum" native resolution at up to 60 FPS, tuned for text clarity.
// Capture and encode run on the same GPU the sharer's game is using, once per viewer in a mesh call,
// so the presets stop at 60 FPS: 144 FPS share costs the game frames. Custom still offers 120 and 144.
const presetFps = 60;
// "custom"  the user's own resolution, frame rate, bitrate, codec and mode.
const qualityOrder = ["video/av1", "video/vp9", "video/h264", "video/vp8"];
// Software AV1/VP9 encoders cannot keep up with 1080p at high frame rates. H.264 is the codec most
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
  const fps = profile === "custom" ? customFps : presetFps;
  const width = Math.round(height * 16 / 9);
  const personal = profile === "custom" && preferences.bitrate > 0 ? preferences.bitrate : defaultBitrateKbps(width, height, fps);
  const caps = [adminBitrate, personal].filter(n => Number.isSafeInteger(n) && n > 0);
  const hint: "motion" | "detail" = profile === "maximum" || (profile === "custom" && preferences.mode === "detail") ? "detail" : "motion";
  return {
    profile,
    maximum: profile === "maximum",
    capture: profile === "maximum" ? {frameRate:{ideal:fps,max:fps}} :
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

// Every viewer in a mesh call gets their own encode of the share. Past this many encoded frames a second
// (two viewers at 60 FPS) the encoders start taking frames from the sharer's game, so more viewers share it.
const encodeBudget = 120;

// The track reports its real frame rate once capture starts; the encoder ceiling follows it down so a
// 30 Hz surface does not reserve bitrate for frames it never makes, but never above the profile's cap.
// With three or more viewers each encode is held to an even share of the budget, but not below 30 FPS.
export function encoderFrameRate(profile: ScreenProfile, captured?: number, viewers = 1) {
  let fps = profile.frameRateCap;
  if (captured && Number.isFinite(captured) && captured > 0) fps = Math.min(fps, Math.round(captured));
  if (viewers > 2) fps = Math.min(fps, Math.max(30, Math.floor(encodeBudget / viewers)));
  return fps;
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

// Raises capture to the surface's native resolution. The frame rate stays at the profile's cap:
// matching a 120-165 Hz monitor would double the capture and encode work taken from the game.
export async function applyNativeCapture(track: MediaStreamTrack, fps = presetFps) {
  const caps = track.getCapabilities?.();
  const current = track.getSettings();
  const constraints: MediaTrackConstraints = {frameRate:{ideal:fps,max:fps}};
  let apply = false;
  for (const key of ["width","height"] as const) {
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

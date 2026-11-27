import type { Preferences } from "./ra-client";

const codecOrder = ["video/av1", "video/vp9", "video/h264", "video/vp8"];

export function screenShareSettings(preferences: Preferences, adminBitrate: number) {
  const maximum = preferences.screenQuality !== "custom";
  const target = /^\d{3,4}x\d{2,3}$/.test(preferences.resolution) ? preferences.resolution : "1080x60";
  const [height, fps] = target.split("x").map(Number);
  const caps = [adminBitrate, maximum ? 0 : preferences.bitrate].filter(n => Number.isSafeInteger(n) && n > 0);
  return {
    maximum,
    capture: maximum ? {frameRate:{ideal:144}} : {height:{ideal:height},frameRate:{ideal:fps}},
    frameRateCap: maximum ? undefined : fps,
    bitrateCap: caps.length ? Math.min(...caps) * 1000 : undefined,
    hint: maximum || preferences.mode === "detail" ? "detail" : "motion",
    codec: maximum ? "quality" : preferences.codec,
  } as const;
}

export function videoCodecPreferences<T extends {mimeType:string}>(codecs: T[], preference: string) {
  const order = preference === "quality" ? codecOrder : ["video/" + preference.toLowerCase()];
  function rank(codec:T) {
    const index=order.indexOf(codec.mimeType.toLowerCase());
    return index===-1 ? order.length : index;
  }
  return [...codecs].sort((a,b)=>rank(a)-rank(b));
}

export async function useNativeCapture(track: MediaStreamTrack) {
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


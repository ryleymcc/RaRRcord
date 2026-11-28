import type { Preferences } from "./ra-client.ts";

export type MediaDevicePreferences = Pick<Preferences, "input" | "output" | "camera">;

const storageKey = (userId: string) => "rarrcord.mediaDevices:" + userId;

export function accountPreferences({ input, output, camera, ...prefs }: Partial<Preferences>) {
  return prefs;
}

export function loadMediaDevices(userId: string): MediaDevicePreferences {
  let saved: Partial<MediaDevicePreferences> | null = null;
  try {
    saved = JSON.parse(localStorage.getItem(storageKey(userId)) ?? "null");
  } catch {
    // A fresh browser, malformed data or disabled storage uses system defaults.
  }
  return {
    input: typeof saved?.input === "string" ? saved.input : "",
    output: typeof saved?.output === "string" ? saved.output : "",
    camera: typeof saved?.camera === "string" ? saved.camera : "",
  };
}

export function saveMediaDevices(userId: string, { input, output, camera }: MediaDevicePreferences) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify({ input, output, camera }));
  } catch {
    throw new Error("This browser could not save your microphone, speaker or camera selection.");
  }
}

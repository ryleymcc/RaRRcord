import test from "node:test";
import assert from "node:assert/strict";
import { defaults } from "../app/ra-client.ts";
import { accountPreferences, loadMediaDevices, saveMediaDevices } from "../app/media-device-preferences.ts";
import { microphoneConstraints } from "../app/noise-suppression.ts";

const values = new Map();
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  },
});

const system = { input: "", output: "", camera: "" };
const selected = { input: "usb-mic", output: "headphones", camera: "webcam" };

test("legacy account device IDs never reach capture or a profile save", () => {
  const synced = accountPreferences({ ...selected, echo: false, suppression: "browser" });
  assert.deepEqual(synced, { echo: false, suppression: "browser" });
  const phonePrefs = { ...defaults, ...synced, ...loadMediaDevices("new-browser") };
  assert.deepEqual(
    { input: phonePrefs.input, output: phonePrefs.output, camera: phonePrefs.camera },
    system,
  );
  assert.equal(phonePrefs.echo, false);
  assert.equal(microphoneConstraints(phonePrefs).audio.deviceId, undefined);
});

test("device selections round-trip locally and can be reset per account", () => {
  saveMediaDevices("alice", selected);
  assert.deepEqual(loadMediaDevices("alice"), selected);
  assert.deepEqual(microphoneConstraints({ ...defaults, ...loadMediaDevices("alice") }).audio.deviceId, { exact: "usb-mic" });
  assert.deepEqual(loadMediaDevices("bob"), system);
  saveMediaDevices("alice", system);
  assert.deepEqual(loadMediaDevices("alice"), system);
});

test("invalid local values use system defaults", () => {
  values.set("rarrcord.mediaDevices:alice", "{broken");
  assert.deepEqual(loadMediaDevices("alice"), system);
  values.set("rarrcord.mediaDevices:alice", JSON.stringify({ input: 42, camera: "webcam" }));
  assert.deepEqual(loadMediaDevices("alice"), { ...system, camera: "webcam" });
});

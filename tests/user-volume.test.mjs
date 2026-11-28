import test from "node:test";
import assert from "node:assert/strict";

const store=new Map();
globalThis.localStorage={getItem:k=>store.has(k)?store.get(k):null,setItem:(k,v)=>store.set(k,String(v)),removeItem:k=>store.delete(k)};
const { clampVolume, loadVolumes, setVolume, streamVolumeKey, loadScreenPreview, saveScreenPreview, canBoost } = await import("../app/user-volume.ts");

test("volumes are clamped to 0-200%", ()=>{
  assert.equal(clampVolume(-1),0);
  assert.equal(clampVolume(5),2);
  assert.equal(clampVolume(1.234),1.23);
  assert.equal(clampVolume(Number.NaN),1);
});

test("volumes are saved per user and survive a reload", ()=>{
  store.clear();
  let v=setVolume({}, "user-1", 1.5);
  v=setVolume(v, streamVolumeKey("user-1"), 0.4);
  v=setVolume(v, "user-2", 0);
  assert.deepEqual(loadVolumes(), {"user-1":1.5,"stream:user-1":0.4,"user-2":0});
  // Back to 100% removes the entry rather than storing the default.
  setVolume(v, "user-1", 1);
  assert.deepEqual(loadVolumes(), {"stream:user-1":0.4,"user-2":0});
});

test("bad saved data falls back to defaults", ()=>{
  store.set("rarrcord.userVolumes","not json");
  assert.deepEqual(loadVolumes(), {});
  store.set("rarrcord.userVolumes",JSON.stringify({a:"loud",b:9}));
  assert.deepEqual(loadVolumes(), {b:2});
});

test("own screen preview is on until hidden", ()=>{
  store.clear();
  assert.equal(loadScreenPreview(), true);
  saveScreenPreview(false);
  assert.equal(loadScreenPreview(), false);
  saveScreenPreview(true);
  assert.equal(loadScreenPreview(), true);
});

test("boost is off where Web Audio is missing", ()=>{
  assert.equal(canBoost(""), typeof AudioContext!=="undefined");
});

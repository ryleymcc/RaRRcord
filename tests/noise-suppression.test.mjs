import assert from "node:assert/strict";
import { test } from "node:test";
import { defaults } from "../app/ra-client.ts";
import { microphoneConstraints, processVoice, suppressionMode } from "../app/noise-suppression.ts";

test("noise suppression defaults to the AI model and keeps an older 'off' setting",()=>{
  assert.equal(suppressionMode(defaults),"strong");
  assert.equal(suppressionMode({...defaults,noise:false}),"off");
  assert.equal(suppressionMode({...defaults,noise:false,suppression:"standard"}),"standard");
  assert.equal(suppressionMode({...defaults,suppression:"bogus"}),"strong");
});

test("the browser suppressor is turned off only when a model replaces it",()=>{
  const audio=(prefs,model)=>microphoneConstraints({...defaults,...prefs},model).audio;
  assert.equal(audio({suppression:"strong"},true).noiseSuppression,false);
  assert.equal(audio({suppression:"standard"},true).noiseSuppression,false);
  assert.equal(audio({suppression:"strong"},false).noiseSuppression,true);
  assert.equal(audio({suppression:"browser"},true).noiseSuppression,true);
  assert.equal(audio({suppression:"off"},true).noiseSuppression,false);
  assert.deepEqual(audio({input:"usb",echo:false,gain:false},true),{deviceId:{exact:"usb"},noiseSuppression:false,echoCancellation:false,autoGainControl:false});
});

test("without AudioWorklet the raw microphone is sent unchanged",async()=>{
  const raw={getAudioTracks:()=>[],getTracks:()=>[]};
  const result=await processVoice(raw,{...defaults,suppression:"strong"});
  assert.equal(result.stream,raw);
  assert.equal(result.fallback,undefined);
  result.close();
});

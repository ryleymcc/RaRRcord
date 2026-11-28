import assert from "node:assert/strict";
import { test } from "node:test";
import { defaults } from "../app/ra-client.ts";
import { defaultBitrateKbps, displayMediaOptions, encoderFrameRate, screenShareSettings, applyNativeCapture, videoCodecPreferences } from "../app/screen-share.ts";

test("the default profile captures 1080p at 144 FPS and keeps motion smooth", () => {
  const settings = screenShareSettings(defaults,0);
  assert.equal(settings.profile,"smooth");
  assert.deepEqual(settings.capture,{width:{ideal:1920,max:1920},height:{ideal:1080,max:1080},frameRate:{ideal:144,max:144}});
  assert.equal(settings.frameRateCap,144);
  assert.equal(settings.bitrateCap,defaultBitrateKbps(1920,1080,144)*1000);
  assert.ok(settings.bitrateCap>=20000000,"well above WebRTC's 2.5 Mbps default");
  assert.equal(settings.hint,"motion");
  assert.equal(settings.degradation,"maintain-framerate");
  assert.equal(settings.codec,"smooth");
  assert.equal(screenShareSettings({...defaults,screenQuality:undefined},0).profile,"smooth");
});

test("sharpest profile uses native dimensions, keeps resolution and always sets ceilings", () => {
  const settings = screenShareSettings({...defaults,screenQuality:"maximum",resolution:"720x30",bitrate:2000},0);
  assert.deepEqual(settings.capture,{frameRate:{ideal:144}});
  assert.equal(settings.hint,"detail");
  assert.equal(settings.degradation,"maintain-resolution");
  assert.equal(settings.codec,"quality");
  assert.equal(settings.bitrateCap,50000000);
  assert.equal(encoderFrameRate(settings,165),165);
  assert.equal(encoderFrameRate(settings,undefined),144);
  assert.equal(encoderFrameRate(screenShareSettings(defaults,0),165),144);
});

test("custom settings and an explicit community ceiling apply to the sender", () => {
  const custom = {...defaults,screenQuality:"custom",resolution:"1440x60",bitrate:12000};
  const settings = screenShareSettings(custom,9000);
  assert.deepEqual(settings.capture,{width:{ideal:2560,max:2560},height:{ideal:1440,max:1440},frameRate:{ideal:60,max:60}});
  assert.equal(settings.frameRateCap,60);
  assert.equal(settings.bitrateCap,9000000);
  assert.equal(screenShareSettings(custom,0).bitrateCap,12000000);
  assert.equal(screenShareSettings({...custom,bitrate:0},0).bitrateCap,defaultBitrateKbps(2560,1440,60)*1000);
  assert.equal(screenShareSettings(defaults,9000).bitrateCap,9000000);
});

test("default bitrate scales with pixels and frames but stays within sane bounds", () => {
  assert.equal(defaultBitrateKbps(1920,1080,144),23888);
  assert.equal(defaultBitrateKbps(640,360,30),2500);
  assert.equal(defaultBitrateKbps(3840,2160,144),50000);
});

test("quality codec preference retains the browser's compatibility fallback list", () => {
  const offered=["video/VP8","video/rtx","video/H264","video/VP9","video/AV1"].map(mimeType=>({mimeType}));
  const names=items=>items.map(codec=>codec.mimeType);
  assert.deepEqual(names(videoCodecPreferences(offered,"quality")),["video/AV1","video/VP9","video/H264","video/VP8","video/rtx"]);
  assert.deepEqual(names(videoCodecPreferences(offered,"H264")),["video/H264","video/VP8","video/rtx","video/VP9","video/AV1"]);
  assert.equal(names(offered)[0],"video/VP8");
});

test("smooth codec preference puts a hardware encoder that keeps up first", () => {
  const offered=["video/VP8","video/rtx","video/H264","video/VP9","video/AV1"].map(mimeType=>({mimeType}));
  const names=items=>items.map(codec=>codec.mimeType);
  assert.deepEqual(names(videoCodecPreferences(offered,"smooth")),["video/H264","video/AV1","video/VP9","video/VP8","video/rtx"]);
  const probed=[
    {mimeType:"video/H264",smooth:true,powerEfficient:false},
    {mimeType:"video/AV1",smooth:true,powerEfficient:true},
    {mimeType:"video/VP9",smooth:false,powerEfficient:false},
    {mimeType:"video/VP8",smooth:true,powerEfficient:false},
  ];
  assert.deepEqual(names(videoCodecPreferences(offered,"smooth",probed)),["video/AV1","video/H264","video/VP8","video/VP9","video/rtx"]);
});

test("display capture asks for system audio without voice processing", () => {
  const options=displayMediaOptions(screenShareSettings(defaults,0));
  assert.deepEqual(options.audio,{echoCancellation:false,noiseSuppression:false,autoGainControl:false});
  assert.equal(options.systemAudio,"include");
  assert.equal(options.selfBrowserSurface,"exclude");
});

test("native capture uses the selected surface's reported resolution and refresh rate", async () => {
  let constraints;
  await applyNativeCapture({
    getCapabilities:()=>({width:{max:3440},height:{max:1440},frameRate:{max:165}}),
    getSettings:()=>({width:2580,height:1080,frameRate:60}),
    applyConstraints:async value=>{constraints=value;},
  });
  assert.deepEqual(constraints,{width:{ideal:3440},height:{ideal:1440},frameRate:{ideal:165}});
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { defaults } from "../app/ra-client.ts";
import { defaultBitrateKbps, displayMediaOptions, encoderFrameRate, frameRateSteps, governFrameRate, previewTrack, screenShareSettings, startGovernor, applyNativeCapture, videoCodecPreferences } from "../app/screen-share.ts";

test("the default profile captures 1080p at 60 FPS and keeps motion smooth", () => {
  const settings = screenShareSettings(defaults,0);
  assert.equal(settings.profile,"smooth");
  assert.deepEqual(settings.capture,{width:{ideal:1920,max:1920},height:{ideal:1080,max:1080},frameRate:{ideal:60,max:60}});
  assert.equal(settings.frameRateCap,60);
  assert.equal(settings.bitrateCap,defaultBitrateKbps(1920,1080,60)*1000);
  assert.ok(settings.bitrateCap>=8000000,"well above WebRTC's 2.5 Mbps default");
  assert.equal(settings.hint,"motion");
  assert.equal(settings.degradation,"maintain-framerate");
  assert.equal(settings.codec,"smooth");
  assert.equal(screenShareSettings({...defaults,screenQuality:undefined},0).profile,"smooth");
});

test("sharpest profile uses native dimensions, keeps resolution and always sets ceilings", () => {
  const settings = screenShareSettings({...defaults,screenQuality:"maximum",resolution:"720x30",bitrate:2000},0);
  assert.deepEqual(settings.capture,{frameRate:{ideal:60,max:60}});
  assert.equal(settings.hint,"detail");
  assert.equal(settings.degradation,"maintain-resolution");
  assert.equal(settings.codec,"quality");
  assert.equal(settings.bitrateCap,defaultBitrateKbps(3840,2160,60)*1000);
  assert.equal(encoderFrameRate(settings,165),60);
  assert.equal(encoderFrameRate(settings,30),30);
  assert.equal(encoderFrameRate(settings,undefined),60);
  assert.equal(encoderFrameRate(screenShareSettings(defaults,0),165),60);
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
  assert.equal(options.video.displaySurface,"monitor");
});

test("encoders share a frame budget once three or more people watch", () => {
  const smooth=screenShareSettings(defaults,0);
  assert.equal(encoderFrameRate(smooth,60,1),60);
  assert.equal(encoderFrameRate(smooth,60,2),60);
  assert.equal(encoderFrameRate(smooth,60,3),40);
  assert.equal(encoderFrameRate(smooth,60,8),30);
  const custom=screenShareSettings({...defaults,screenQuality:"custom",resolution:"1080x144"},0);
  assert.equal(encoderFrameRate(custom,144,1),144);
  assert.equal(encoderFrameRate(custom,144,4),30);
});

test("native capture uses the surface's resolution but keeps the profile's frame rate", async () => {
  let constraints;
  await applyNativeCapture({
    getCapabilities:()=>({width:{max:3440},height:{max:1440},frameRate:{max:165}}),
    getSettings:()=>({width:2580,height:1080,frameRate:60}),
    applyConstraints:async value=>{constraints=value;},
  });
  assert.deepEqual(constraints,{width:{ideal:3440},height:{ideal:1440},frameRate:{ideal:60,max:60}});
});

test("presets adapt and the governor's step caps the encoder", () => {
  const smooth=screenShareSettings(defaults,0);
  assert.equal(smooth.adaptive,true);
  assert.equal(screenShareSettings({...defaults,screenQuality:"custom"},0).adaptive,false);
  assert.equal(encoderFrameRate(smooth,60,1,45),45);
  assert.equal(encoderFrameRate(smooth,60,1,undefined),60);
  assert.equal(encoderFrameRate(smooth,60,4,45),30);
});

test("the governor starts at 60 without a hardware encoder that keeps up", () => {
  assert.deepEqual(frameRateSteps(144),[144,120,90,60,45,30]);
  assert.deepEqual(frameRateSteps(60),[60,45,30]);
  assert.equal(startGovernor(144,[{mimeType:"video/H264",smooth:true,powerEfficient:true}]).fps,144);
  assert.equal(startGovernor(144,[{mimeType:"video/H264",smooth:false,powerEfficient:false}]).fps,60);
  assert.equal(startGovernor(144,[]).fps,144);
});

test("the governor sheds frames quickly and adds them back slowly", () => {
  const clean={cpuLimited:false,software:false,encodeMs:2};
  const strained={cpuLimited:true,software:false,encodeMs:2};
  let g=startGovernor(60,[]);
  g=governFrameRate(g,strained,0);
  assert.equal(g.fps,60,"one strained sample is not enough");
  g=governFrameRate(g,strained,2000);
  assert.equal(g.fps,45);
  // Slow encodes count as strain too: 20 ms per frame is over budget at 45 FPS.
  g=governFrameRate(g,{...clean,encodeMs:20},4000);
  g=governFrameRate(g,{...clean,encodeMs:20},6000);
  assert.equal(g.fps,30);
  g=governFrameRate(governFrameRate(g,strained,8000),strained,10000);
  assert.equal(g.fps,30,"30 is the floor");
  for(let i=0;i<30;i++)g=governFrameRate(g,clean,12000+i*2000);
  assert.equal(g.fps,30,"held for two minutes after a drop");
  for(let i=0;i<30;i++)g=governFrameRate(g,clean,140000+i*2000);
  assert.equal(g.fps,45);
});

test("a software encoder never runs above 60 FPS", () => {
  const g=governFrameRate(startGovernor(144,[]),{cpuLimited:false,software:true,encodeMs:1},0);
  assert.equal(g.fps,60);
});

test("the self preview is a low-rate clone", async () => {
  let applied;
  const clone={applyConstraints:async c=>{applied=c;}};
  const result=await previewTrack({clone:()=>clone});
  assert.equal(result,clone);
  assert.deepEqual(applied,{frameRate:{max:10},height:{max:540}});
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { defaults } from "../app/ra-client.ts";
import { screenShareSettings, useNativeCapture, videoCodecPreferences } from "../app/screen-share.ts";

test("highest quality uses native dimensions and leaves send rate uncapped", () => {
  const settings = screenShareSettings({...defaults, resolution:"720x30", bitrate:2000},0);
  assert.deepEqual(settings.capture,{frameRate:{ideal:144}});
  assert.equal(settings.frameRateCap,undefined);
  assert.equal(settings.bitrateCap,undefined);
  assert.equal(settings.hint,"detail");
  assert.equal(settings.codec,"quality");
});

test("custom settings and an explicit community ceiling apply to the sender", () => {
  const custom = {...defaults,screenQuality:"custom",resolution:"1440x60",bitrate:12000};
  const settings = screenShareSettings(custom,9000);
  assert.deepEqual(settings.capture,{height:{ideal:1440},frameRate:{ideal:60}});
  assert.equal(settings.frameRateCap,60);
  assert.equal(settings.bitrateCap,9000000);
  assert.equal(screenShareSettings(custom,0).bitrateCap,12000000);
  assert.equal(screenShareSettings({...custom,bitrate:0},0).bitrateCap,undefined);
  assert.equal(screenShareSettings(defaults,9000).bitrateCap,9000000);
});

test("quality codec preference retains the browser's compatibility fallback list", () => {
  const offered=["video/VP8","video/rtx","video/H264","video/VP9","video/AV1"].map(mimeType=>({mimeType}));
  const names=items=>items.map(codec=>codec.mimeType);
  assert.deepEqual(names(videoCodecPreferences(offered,"quality")),["video/AV1","video/VP9","video/H264","video/VP8","video/rtx"]);
  assert.deepEqual(names(videoCodecPreferences(offered,"H264")),["video/H264","video/VP8","video/rtx","video/VP9","video/AV1"]);
  assert.equal(names(offered)[0],"video/VP8");
});

test("native capture uses the selected surface's reported resolution and refresh rate", async () => {
  let constraints;
  await useNativeCapture({
    getCapabilities:()=>({width:{max:3440},height:{max:1440},frameRate:{max:165}}),
    getSettings:()=>({width:2580,height:1080,frameRate:60}),
    applyConstraints:async value=>{constraints=value;},
  });
  assert.deepEqual(constraints,{width:{ideal:3440},height:{ideal:1440},frameRate:{ideal:165}});
});


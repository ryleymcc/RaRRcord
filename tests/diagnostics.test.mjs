import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnosticSample, webrtcInternalsUrl } from "../app/diagnostic-data.ts";

test("diagnostics retain measured zeros and identify the peer or stream for each reading", () => {
  const connection = { peer: "peer", name: "Pat", rtt: 12.5 };
  const outbound = { ...connection, stream: "send", direction: "Sending video", bitrate: 1560.75, fps: 30 };
  const inbound = { ...connection, stream: "receive", direction: "Receiving audio", bitrate: 49, loss: 0 };
  const sample = diagnosticSample(1000, [inbound, outbound]);
  assert.equal(sample.at, 1000);
  assert.equal(sample.values.bitrate.value, 1560.75);
  assert.equal(sample.values.fps.value, 30);
  assert.equal(sample.values.rtt.value, 12.5);
  assert.equal(sample.values.loss.value, 0);
  assert.equal(sample.values.loss.label, "Pat · Receiving audio");
  assert.notEqual(sample.values.loss.source, sample.values.bitrate.source);
  assert.equal(sample.values.rtt.source, diagnosticSample(2000, [inbound]).values.rtt.source);
  assert.deepEqual(diagnosticSample(3000, []).values, {});
  assert.deepEqual(diagnosticSample(4000, [{ ...outbound, fps: NaN, bitrate: Infinity, rtt: undefined }]).values, {});
});

test("WebRTC Internals uses the browser's privileged address when available", () => {
  assert.equal(webrtcInternalsUrl("Mozilla/5.0 Chrome/145.0 Safari/537.36 Edg/145.0"), "edge://webrtc-internals/");
  assert.equal(webrtcInternalsUrl("Mozilla/5.0 Firefox/148.0"), "about:webrtc");
  assert.equal(webrtcInternalsUrl("Mozilla/5.0 Chrome/145.0 Safari/537.36"), "chrome://webrtc-internals/");
  assert.equal(webrtcInternalsUrl("Mozilla/5.0 (iPhone) CriOS/145.0 Mobile/15E148 Safari/604.1"), undefined);
  assert.equal(webrtcInternalsUrl("Mozilla/5.0 (Macintosh) Version/18.0 Safari/605.1.15"), undefined);
});

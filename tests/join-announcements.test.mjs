import test from "node:test";
import assert from "node:assert/strict";
import { cleanAnnouncements, joinAnnouncement, speakAnnouncement } from "../app/voice-sounds.ts";

test("an announcement matches a username ignoring case and a leading @", () => {
  const list = [{ user: "@Friend", text: "Friend has joined" }];
  assert.equal(joinAnnouncement(list, "friend"), "Friend has joined");
  assert.equal(joinAnnouncement(list, "@FRIEND"), "Friend has joined");
  assert.equal(joinAnnouncement(list, "someone"), "");
  assert.equal(joinAnnouncement(list, ""), "");
});

test("blank rows are dropped and rows are trimmed and limited", () => {
  const rows = cleanAnnouncements([
    { user: "  @a  ", text: "  hello  " },
    { user: "", text: "no user" },
    { user: "b", text: "   " },
    { user: "c", text: "x".repeat(300) },
  ]);
  assert.deepEqual(rows.map(r => r.user), ["a", "c"]);
  assert.equal(rows[0].text, "hello");
  assert.equal(rows[1].text.length, 100);
  assert.equal(cleanAnnouncements(Array.from({ length: 40 }, (_, i) => ({ user: "u" + i, text: "t" }))).length, 20);
});

test("missing or malformed saved data is ignored", () => {
  assert.deepEqual(cleanAnnouncements(undefined), []);
  assert.deepEqual(cleanAnnouncements("nope"), []);
  assert.equal(joinAnnouncement(undefined, "a"), "");
});

test("speech is only attempted with a line and where the browser supports it", () => {
  const spoken = [];
  globalThis.SpeechSynthesisUtterance = class { constructor(text) { this.text = text; } };
  globalThis.speechSynthesis = { speak: u => spoken.push(u.text) };
  speakAnnouncement("   ");
  speakAnnouncement("  Hello there  ");
  assert.deepEqual(spoken, ["Hello there"]);
  delete globalThis.speechSynthesis;
  speakAnnouncement("silent");
  assert.deepEqual(spoken, ["Hello there"]);
});

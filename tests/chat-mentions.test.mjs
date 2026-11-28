import {test} from "node:test";
import assert from "node:assert/strict";
import {mentionAtCursor, mentionsUser, splitMentions} from "../lib/chat-mentions.ts";

test("mention tokens match full, case-insensitive usernames in prose",()=>{
  for(const body of ["Hey @ALICE!", "(@alice) @bob", "**@alice**", "_@alice_", "@alice."])assert.ok(mentionsUser(body,"alice"),body);
  for(const body of ["@alice2", "@alice_team", "name@alice.test", "@alice@example.test", "https://example.test/@alice", "`@alice`", "```js\n@alice\n```"]){
    assert.equal(mentionsUser(body,"alice"),false,body);
  }
  assert.deepEqual(splitMentions("Hi @ALICE, @bob!"),["Hi ","@ALICE",", ","@bob","!"]);
});

test("mention autocomplete replaces the handle at the cursor and skips code and email addresses",()=>{
  assert.deepEqual(mentionAtCursor("Hi @alice there",6),{start:3,end:9,query:"al"});
  assert.deepEqual(mentionAtCursor("@",1),{start:0,end:1,query:""});
  assert.equal(mentionAtCursor("name@ali",8),undefined);
  assert.equal(mentionAtCursor("`@ali",5),undefined);
  assert.equal(mentionAtCursor("```\n@ali",8),undefined);
});

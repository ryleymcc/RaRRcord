import {test} from "node:test";
import assert from "node:assert/strict";
import {messageLink,messageLinkPath,parseMessageLink,parseMessageQuery,splitMessageLinks} from "../lib/message-links.ts";

const origin="https://chat.example.test";
const general=origin+"/#chat/general/42";
const announcements=origin+"/?message=announcements%2F81";

test("message links round-trip with the existing chat fragment format",()=>{
  assert.equal(messageLink("general",42),"#chat/general/42");
  assert.equal(messageLinkPath("general",42),"/?message=general%2F42");
  assert.deepEqual(parseMessageLink(messageLink("team/space",42)),{channel:"team/space",id:42});
  assert.deepEqual(parseMessageQuery(new URL(messageLinkPath("team/space",42),origin).searchParams.get("message")),{channel:"team/space",id:42});
  for(const fragment of ["#chat/general/0","#chat/general/01","#chat/general/1/2","#chat/%E0/9","#chat/general/9007199254740992"]){
    assert.equal(parseMessageLink(fragment),undefined,fragment);
  }
});

test("pasted links recognize multiple messages and preserve the surrounding text",()=>{
  assert.deepEqual(splitMessageLinks(`See (${general}), then\n${announcements}!`,origin),[
    {text:"See ("},
    {text:general,target:{channel:"general",id:42}},
    {text:"), then\n"},
    {text:announcements,target:{channel:"announcements",id:81}},
    {text:"!"},
  ]);
});

test("other URLs stay as text even when they resemble a RaRRcord message link",()=>{
  for(const text of [
    "https://elsewhere.test/#chat/general/42",
    "http://chat.example.test/#chat/general/42",
    "https://chat.example.test@elsewhere.test/#chat/general/42",
    "https://elsewhere.test@chat.example.test/#chat/general/42",
    origin+"/other/#chat/general/42",
    origin+"/?unrelated=1#chat/general/42",
    origin+"/?message=general%2F42&message=general%2F81",
    origin+"/#chat/general/42/extra",
    origin+"/#chat/general/42more",
  ])assert.deepEqual(splitMessageLinks(text,origin),[{text}]);
});

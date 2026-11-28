import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { api } from "../worker/ra.ts";

function fixture() {
  const sqlite=new DatabaseSync(":memory:");
  const migrations=new URL("../drizzle/",import.meta.url);
  for(const file of readdirSync(migrations).filter(n=>n.endsWith(".sql")).sort())sqlite.exec(readFileSync(new URL(file,migrations),"utf8"));
  const DB={
    prepare(query){
      const statement=sqlite.prepare(query);
      return {bind(...args){return {
        first:async()=>statement.get(...args)??null,
        all:async()=>({results:statement.all(...args)}),
        run:()=>statement.run(...args),
        rows:()=>statement.all(...args),
      };}};
    },
    async batch(statements){
      sqlite.exec("BEGIN");
      try {const result=statements.map(s=>({results:s.rows()}));sqlite.exec("COMMIT");return result;}
      catch(error){sqlite.exec("ROLLBACK");throw error;}
    },
  };
  const objects=new Map();
  const BUCKET={
    async put(key,data,{httpMetadata}){objects.set(key,{body:await new Response(data).arrayBuffer(),httpMetadata});},
    async get(key){return objects.get(key);},
    async delete(key){for(const k of [key].flat())objects.delete(k);},
  };
  const origin="https://ra.example";
  const env={DB,BUCKET,RARRCORD_OWNER_EMAIL:"owner@example.test"};
  function visitor(id,email=id+"@example.test") {
    let cookie="";
    return async (path,{input,expect=200,otherOrigin,keepCookie=true,contentType,noLength}={})=>{
      const headers=new Headers();
      if(id){headers.set("x-rarrcord-user-id",id);headers.set("x-rarrcord-user-email",email);}
      if(cookie&&keepCookie)headers.set("cookie",cookie);
      if(input!==undefined){
        headers.set("origin",otherOrigin??origin);
        if(!(input instanceof FormData))headers.set("content-type","application/json");
      }
      let payload=input===undefined||input instanceof FormData?input:JSON.stringify(input);
      if(input instanceof FormData){
        // Browsers send a length with multipart uploads; Request objects built here do not.
        const encoded=new Response(input);
        headers.set("content-type",encoded.headers.get("content-type"));
        payload=await encoded.arrayBuffer();
        if(!noLength)headers.set("content-length",String(payload.byteLength));
      }
      const result=await api(new Request(origin+"/api/ra/"+path,{method:input===undefined?"GET":"POST",headers,body:payload}),env);
      if(contentType)assert.equal(result.headers.get("content-type"),contentType);
      const received=result.headers.get("set-cookie");
      if(received){
        assert.match(received,/HttpOnly; Secure; SameSite=Strict/);
        cookie=received.split(";")[0];
      }
      const body=result.headers.get("content-type")?.includes("application/json")?await result.json():await result.arrayBuffer();
      assert.equal(result.status,expect,path+" returned "+JSON.stringify(body));
      return body;
    };
  }
  return {visitor,objects,env};
}

test("independent app sessions enforce approval, origin, ownership, bans and revocation",async()=>{
  const {visitor}=fixture();
  const owner=visitor("owner"), member=visitor("member"), stranger=visitor("");
  await stranger("session",{expect:401});
  const pending=await member("enroll",{input:{username:"member",name:"Member",role:"admin",state:"approved"}});
  assert.equal(pending.user.state,"pending");
  await member("workspace",{expect:403});
  assert.equal((await owner("enroll",{input:{username:"owner"}})).user.role,"admin");
  await member("admin",{expect:403});
  await owner("admin",{input:{action:"account",target:"owner",state:"banned",role:"member"},expect:409});
  assert.equal((await owner("admin")).users.length,2);
  await owner("admin",{input:{action:"account",target:"member",state:"approved",role:"member"}});
  assert.equal((await member("enroll",{input:{}})).active,true);
  await member("workspace",{keepCookie:false,expect:403});
  await member("message",{input:{channel:"general",text:"bad origin"},otherOrigin:"https://elsewhere.example",expect:403});
  await owner("admin",{input:{action:"revoke",target:"member"}});
  await member("workspace",{expect:403});
  await member("enroll",{input:{},expect:401});
  await member("logout",{input:{}});
  await member("enroll",{input:{}});
  await owner("admin",{input:{action:"account",target:"member",state:"banned",role:"member"}});
  await member("workspace",{expect:403});
  await member("logout",{input:{}});
  assert.equal((await visitor("member")("enroll",{input:{}})).user.state,"banned");
});

test("message changes, private uploads and voice signaling stay inside authorized rooms",async()=>{
  const {visitor}=fixture();
  const owner=visitor("owner"), member=visitor("member"), second=visitor("second");
  await owner("enroll",{input:{username:"owner"}});
  for(const [id,client] of [["member",member],["second",second]]){
    await client("enroll",{input:{username:id}});
    await owner("admin",{input:{action:"account",target:id,state:"approved",role:"member"}});
    await client("enroll",{input:{}});
  }
  await member("message",{input:{channel:"general",text:"Hello",uid:"owner"}});
  const history=await second("history?channel=general");
  assert.equal(history.messages[0].uid,"member");
  const mid=history.messages[0].id;
  await second("message",{input:{channel:"general",action:"edit",id:mid,text:"Spoof"},expect:403});
  await member("message",{input:{channel:"general",action:"edit",id:mid,text:"Updated"}});
  assert.equal((await second("poll?channel=general&after="+history.cursor)).messages[0].body,"Updated");
  const {id:privateId}=await owner("admin",{input:{action:"channel",server:"community",name:"Private",kind:"private",users:["member"]}});
  await second("history?channel="+privateId,{expect:404});
  const form=new FormData();
  form.set("file",new File(["private notes"],"private.txt"));
  form.set("channel",privateId);
  await member("upload",{input:form});
  const file=(await member("history?channel="+privateId)).messages[0].attachment;
  assert.equal(new TextDecoder().decode(await member("attachment?key="+file)),"private notes");
  await second("attachment?key="+file,{expect:404});
  const peer=crypto.randomUUID(), peer2=crypto.randomUUID();
  assert.deepEqual(await member("ice"),{servers:[{urls:"stun:stun.cloudflare.com:3478"}],relay:false});
  await owner("admin",{input:{action:"settings",bitrate:8000,upload:1000000,stun:"stun:stun.example.test:3478"}});
  assert.deepEqual(await member("ice"),{servers:[{urls:"stun:stun.example.test:3478"}],relay:false});
  await member("signal",{input:{channel:"gaming",peer,target:peer2,data:{type:"subscribe",medium:"screen",active:true}},expect:403});
  await member("voice",{input:{action:"join",channel:"gaming",peer}});
  await second("voice",{input:{action:"join",channel:"general-voice",peer:peer2}});
  const rooms=(await owner("poll?rooms=1")).rooms.map(r=>r.channel+":"+r.uid).sort();
  assert.deepEqual(rooms,["gaming:member","general-voice:second"]);
  assert.equal((await owner("poll")).rooms,undefined);
  await member("signal",{input:{channel:"gaming",peer,target:peer2,data:{type:"subscribe",medium:"screen",active:true}},expect:404});
  await second("voice",{input:{action:"join",channel:"gaming",peer:peer2}});
  await member("signal",{input:{channel:"gaming",peer,target:peer2,data:{type:"subscribe",medium:"screen",active:true}}});
  const received=await second("poll?peer="+peer2);
  assert.equal(received.signals[0].sender,peer);
  assert.equal(received.voice.length,2);
  await owner("admin",{input:{action:"disconnect",target:"member"}});
  assert.equal((await second("poll?peer="+peer2)).voice.length,1);
  assert.equal((await member("poll?peer="+peer)).voice,null);
  assert.deepEqual((await owner("poll?rooms=1")).rooms.map(r=>r.uid),["second"]);
});

test("voice sidechat persists and shares the room's permissions and polling with voice",async()=>{
  const {visitor}=fixture();
  const owner=visitor("owner"), member=visitor("member"), blocked=visitor("blocked");
  await owner("enroll",{input:{username:"owner"}});
  for(const [id,client] of [["member",member],["blocked",blocked]]){
    await client("enroll",{input:{username:id}});
    await owner("admin",{input:{action:"account",target:id,state:"approved",role:"member"}});
    await client("enroll",{input:{}});
  }
  const {id:room}=await owner("admin",{input:{action:"channel",server:"community",name:"Role voice",kind:"voice",permission:"member"}});
  assert.ok(room);
  const {id:restricted}=await owner("admin",{input:{action:"channel",server:"community",name:"Restricted voice",kind:"voice",permission:"staff"}});
  const peer=crypto.randomUUID();
  await member("voice",{input:{action:"join",channel:room,peer}});
  await member("voice",{input:{channel:room,peer,screen:true}});
  const before=await member("history?channel="+room);
  await owner("message",{input:{channel:room,text:"Welcome 👩‍💻"}});
  const live=await member("poll?channel="+room+"&after="+before.cursor+"&peer="+peer);
  assert.equal(live.messages[0].body,"Welcome 👩‍💻");
  assert.equal(live.voice[0].screen,1);
  const mid=live.messages[0].id;
  await member("message",{input:{channel:room,id:mid,action:"react",emoji:"👍🏽"}});
  const reacted=await member("poll?channel="+room+"&after="+live.cursor);
  assert.deepEqual(JSON.parse(reacted.messages[0].reactions),{"👍🏽":1});
  assert.deepEqual(JSON.parse(reacted.messages[0].my_reactions),["👍🏽"]);
  assert.deepEqual(JSON.parse((await owner("history?channel="+room)).messages[0].my_reactions),[]);
  await member("message",{input:{channel:room,id:mid,action:"react",emoji:"👍👍"},expect:400});
  await member("message",{input:{channel:room,id:mid,action:"react",emoji:"👍🏽",remove:true}});
  assert.deepEqual(JSON.parse((await owner("history?channel="+room)).messages[0].reactions),{});
  await member("message",{input:{channel:"gaming",id:mid,action:"react",emoji:"🎉"},expect:404});
  await blocked("history?channel="+restricted,{expect:404});
  await blocked("poll?channel="+restricted,{expect:404});
  await blocked("message",{input:{channel:restricted,text:"No access"},expect:404});
  await blocked("typing",{input:{channel:restricted},expect:404});
  await owner("voice",{input:{action:"join",channel:restricted,peer:crypto.randomUUID()}});
  const visible=(await blocked("poll?rooms=1")).rooms;
  assert.deepEqual(visible.map(r=>[r.channel,r.uid,r.screen]),[[room,"member",1]]);
  assert.equal((await owner("poll?rooms=1")).rooms.length,2);

  const image=Buffer.from("47494638396101000100800000ffffff000000","hex");
  const frame=Buffer.from("21f904000a0000002c0000000001000100000202440100","hex");
  const gif=Buffer.concat([image,frame,frame,Buffer.from([0x3b])]);
  const form=new FormData();
  form.set("gif","1");
  form.set("file",new File([gif],"clipboard-image"));
  form.set("channel",restricted);
  await blocked("upload",{input:form,expect:404});
  form.set("reply",String(mid));
  await owner("upload",{input:form,expect:404});
  form.set("channel",room);
  form.set("text","Animated reply ✨");
  await member("upload",{input:form});
  await member("voice",{input:{action:"leave",channel:room,peer}});
  const history=await owner("history?channel="+room);
  const attachment=history.messages[1];
  assert.equal(attachment.body,"Animated reply ✨");
  assert.equal(attachment.filename,"clipboard-image.gif");
  assert.equal(attachment.reply,mid);
  assert.deepEqual(Buffer.from(await member("attachment?key="+attachment.attachment,{contentType:"image/gif"})),gif);
  await owner("admin",{input:{action:"channel",target:room,server:"community",name:"Role voice",kind:"voice",permission:"staff"}});
  await member("attachment?key="+attachment.attachment,{expect:404});
  await member("history?channel="+room,{expect:404});
  assert.deepEqual((await member("history?channel=gaming")).messages,[]);
  form.set("channel","gaming");
  form.delete("reply");
  form.set("file",new File(["not a gif"],"fake.gif"));
  await member("upload",{input:form,expect:415});
});

test("uploads need a length and count toward a daily allowance, and read routes are rate limited",async()=>{
  const {visitor}=fixture();
  const owner=visitor("limits-owner","owner@example.test");
  await owner("enroll",{input:{username:"limitsowner"}});
  const png=()=>{const form=new FormData();form.set("channel","general");form.set("file",new File([new Uint8Array([137,80,78,71,13,10,26,10,0,0])],"a.png"));return form;};
  await owner("upload",{input:png(),noLength:true,expect:411});
  await owner("upload",{input:png()});
  for(let i=0;i<10;i++)await owner("ice");
  await owner("ice",{expect:429});
});

test("names cannot hide characters or copy another member, and group DMs respect blocks",async()=>{
  const {visitor}=fixture();
  const owner=visitor("owner"), a=visitor("a"), b=visitor("b");
  await owner("enroll",{input:{username:"owner",name:"Alek"}});
  await a("enroll",{input:{username:"alek",name:"x"},expect:409});
  await a("enroll",{input:{username:"aaa",name:"alek"},expect:409});
  await a("enroll",{input:{username:"aaa",name:"A\u202eli\u200bce"}});
  await b("enroll",{input:{username:"bbb"}});
  for(const [id,client] of [["a",a],["b",b]]){await owner("admin",{input:{action:"account",target:id,state:"approved",role:"member"}});await client("enroll",{input:{}});}
  const people=(await owner("workspace")).people;
  assert.equal(people.find(p=>p.id==="a").name,"Alice");
  await b("profile",{input:{name:"ALEK",status:"online"},expect:409});
  await b("profile",{input:{name:"Bob",status:"online"}});
  await b("block",{input:{users:["a"]}});
  await owner("dm",{input:{users:["a","b"]},expect:403});
  const {id:dm}=await owner("dm",{input:{users:["a"]}});
  await owner("message",{input:{channel:dm,text:"hi"}});
  const mid=(await a("history?channel="+dm)).messages[0].id;
  await a("block",{input:{users:["owner"]}});
  await a("message",{input:{channel:dm,id:mid,action:"react",emoji:"👍"},expect:403});
});

test("deleting a channel or server removes its messages and files",async()=>{
  const {visitor,objects}=fixture();
  const owner=visitor("owner");
  await owner("enroll",{input:{username:"owner"}});
  const {id:server}=await owner("admin",{input:{action:"server",name:"Temp"}});
  const {id:channel}=await owner("admin",{input:{action:"channel",server,name:"temp",kind:"text"}});
  const form=new FormData();form.set("channel",channel);form.set("file",new File(["notes"],"n.txt"));
  await owner("upload",{input:form});
  await owner("message",{input:{channel,text:"bye"}});
  assert.equal(objects.size,1);
  await owner("admin",{input:{action:"server_delete",target:server}});
  assert.equal(objects.size,0);
  await owner("history?channel="+channel,{expect:404});
});

test("only administrators set server pictures and only members of that server can load them",async()=>{
  const {visitor,objects}=fixture();
  const owner=visitor("owner"), member=visitor("m");
  await owner("enroll",{input:{username:"owner"}});
  await member("enroll",{input:{username:"mmm"}});
  await owner("admin",{input:{action:"account",target:"m",state:"approved",role:"member"}});
  await member("enroll",{input:{}});
  const {id:server}=await owner("admin",{input:{action:"server",name:"Pics"}});
  const png=()=>new File([new Uint8Array([137,80,78,71,13,10,26,10,0,0])],"icon.png");
  const picture=(file=png())=>{const form=new FormData();form.set("server",server);form.set("file",file);return form;};
  await member("servericon",{input:picture(),expect:403});
  await owner("servericon",{input:picture(new File(["not an image"],"icon.txt")),expect:415});
  const missing=picture();missing.set("server","nope");
  await owner("servericon",{input:missing,expect:404});
  assert.equal(objects.size,0);
  await owner("servericon",{input:picture()});
  assert.equal(objects.size,1);
  const listed=(await owner("workspace")).servers.find(s=>s.id===server);
  assert.equal(listed.picture.length,8);
  await owner("servericon?key="+server,{contentType:"image/png"});
  // The picture is only for people who can see the server.
  await member("servericon?key="+server,{expect:404});
  // Replacing it removes the old file.
  await owner("servericon",{input:picture()});
  assert.equal(objects.size,1);
  await owner("admin",{input:{action:"server_picture_remove",target:server}});
  assert.equal(objects.size,0);
  await owner("servericon?key="+server,{expect:404});
  assert.equal((await owner("workspace")).servers.find(s=>s.id===server).picture,null);
  // Deleting the server removes its picture too.
  await owner("servericon",{input:picture()});
  assert.equal(objects.size,1);
  await owner("admin",{input:{action:"server_delete",target:server}});
  assert.equal(objects.size,0);
});

test("Cloudflare TURN credentials are fetched for calls and port 53 addresses are dropped",async()=>{
  const {visitor,env}=fixture();
  env.RARRCORD_TURN_KEY_ID="key1";env.RARRCORD_TURN_KEY_TOKEN="secret";
  const owner=visitor("turn-owner","owner@example.test");
  await owner("enroll",{input:{username:"turnowner"}});
  const real=globalThis.fetch;
  let seen;
  globalThis.fetch=async(url,init)=>{seen={url,auth:init.headers.authorization,body:init.body};return Response.json({iceServers:[{urls:["stun:stun.cloudflare.com:3478","stun:stun.cloudflare.com:53","turn:turn.cloudflare.com:3478?transport=udp","turn:turn.cloudflare.com:53?transport=udp","turns:turn.cloudflare.com:443?transport=tcp"],username:"u",credential:"c"}]});};
  try {
    const ice=await owner("ice");
    assert.equal(seen.url,"https://rtc.live.cloudflare.com/v1/turn/keys/key1/credentials/generate-ice-servers");
    assert.equal(seen.auth,"Bearer secret");
    assert.equal(JSON.parse(seen.body).ttl,86400);
    assert.equal(ice.relay,true);
    assert.deepEqual(ice.servers[1].urls,["stun:stun.cloudflare.com:3478","turn:turn.cloudflare.com:3478?transport=udp","turns:turn.cloudflare.com:443?transport=tcp"]);
  } finally { globalThis.fetch=real; }
});

test("administrators and moderators can move people between voice rooms, and the move is audited",async()=>{
  const {visitor}=fixture();
  const owner=visitor("owner"), member=visitor("member"), mod=visitor("mod");
  await owner("enroll",{input:{username:"owner"}});
  for(const [id,client] of [["member",member],["mod",mod]]){
    await client("enroll",{input:{username:id}});
    await owner("admin",{input:{action:"account",target:id,state:"approved",role:"member"}});
    await client("enroll",{input:{}});
  }
  assert.deepEqual((await owner("workspace")).moderates,["community"]);
  assert.deepEqual((await member("workspace")).moderates,[]);
  const peer=crypto.randomUUID(), modPeer=crypto.randomUUID();
  await member("voice",{input:{action:"join",channel:"gaming",peer}});
  assert.equal((await member("poll?peer="+peer)).room,"gaming");
  // Ordinary members cannot move anyone, including other members.
  await mod("move",{input:{target:"member",channel:"afk"},expect:403});
  await owner("move",{input:{target:"member",channel:"gaming"}}).then(r=>assert.equal(r.moved,false));
  assert.equal((await owner("move",{input:{target:"member",channel:"afk"}})).moved,true);
  // The moved client learns its new room from its own poll and rejoins there.
  const after=await member("poll?peer="+peer);
  assert.equal(after.room,"afk");
  assert.equal(after.moved,true);
  assert.deepEqual(after.voice,[]);
  // Until they rejoin, nobody in the new room is offered the old connection.
  const watcher=crypto.randomUUID();
  await owner("voice",{input:{action:"join",channel:"afk",peer:watcher}});
  assert.deepEqual((await owner("poll?peer="+watcher)).voice.map(v=>v.uid),["owner"]);
  await owner("voice",{input:{action:"leave",channel:"afk",peer:watcher}});
  assert.deepEqual((await owner("poll?rooms=1")).rooms.map(r=>r.channel+":"+r.uid),["afk:member"]);
  const fresh=crypto.randomUUID();
  await member("voice",{input:{action:"join",channel:"afk",peer:fresh}});
  const rejoined=await member("poll?peer="+fresh);
  assert.equal(rejoined.room,"afk");
  assert.equal(rejoined.moved,undefined);
  assert.deepEqual(rejoined.voice.map(v=>v.uid),["member"]);
  // Moderators of the server may move people too.
  await owner("admin",{input:{action:"member",server:"community",target:"mod",role:"moderator"}});
  assert.deepEqual((await mod("workspace")).moderates,["community"]);
  await mod("voice",{input:{action:"join",channel:"general-voice",peer:modPeer}});
  assert.equal((await mod("move",{input:{target:"member",channel:"general-voice"}})).moved,true);
  // Nobody can be moved into a room they may not enter, or once they have left voice.
  const {id:staff}=await owner("admin",{input:{action:"channel",server:"community",name:"Staff",kind:"voice",permission:"staff"}});
  await owner("move",{input:{target:"member",channel:staff},expect:403});
  await owner("move",{input:{target:"nobody",channel:"afk"},expect:404});
  const logs=(await owner("admin")).logs.filter(l=>l.action==="voice move").map(l=>l.uid+": "+l.detail);
  assert.deepEqual(logs,["mod: member afk -> general-voice","owner: member gaming -> afk"]);
});

test("voice rooms list people in the order they joined, and the member list alphabetically",async()=>{
  const {visitor}=fixture();
  const realNow=Date.now;
  let clock=realNow();
  Date.now=()=>clock;
  try {
    const owner=visitor("owner");
    await owner("enroll",{input:{username:"owner",name:"owner"}});
    const people={};
    for(const [id,name] of [["zed","Zed"],["amy","amy"],["bob","Bob"]]){
      people[id]=visitor(id);
      await people[id]("enroll",{input:{username:id,name}});
      await owner("admin",{input:{action:"account",target:id,state:"approved",role:"member"}});
      await people[id]("enroll",{input:{}});
    }
    const peers={zed:crypto.randomUUID(),amy:crypto.randomUUID(),bob:crypto.randomUUID()};
    for(const id of ["zed","amy","bob"]){
      clock+=1000;
      await people[id]("voice",{input:{action:"join",channel:"gaming",peer:peers[id]}});
    }
    const roster=async()=>(await people.amy("poll?peer="+peers.amy)).voice.map(p=>p.uid);
    const sidebar=async()=>(await owner("poll?rooms=1")).rooms.map(r=>r.uid);
    assert.deepEqual(await roster(),["zed","amy","bob"]);
    assert.deepEqual(await sidebar(),["zed","amy","bob"]);
    // Lease renewals happen on polls in any order; they must not reshuffle anyone.
    clock+=8000;
    await people.bob("poll?peer="+peers.bob);
    await people.zed("poll?peer="+peers.zed);
    assert.deepEqual(await roster(),["zed","amy","bob"]);
    // Reconnecting to the same room (a page reload) keeps your place.
    peers.zed=crypto.randomUUID();
    clock+=1000;
    await people.zed("voice",{input:{action:"join",channel:"gaming",peer:peers.zed}});
    assert.deepEqual(await roster(),["zed","amy","bob"]);
    // Leaving and coming back, or arriving from another room, puts you at the end.
    await people.zed("voice",{input:{action:"leave",channel:"gaming",peer:peers.zed}});
    clock+=1000;
    await people.zed("voice",{input:{action:"join",channel:"gaming",peer:peers.zed}});
    clock+=1000;
    await people.amy("voice",{input:{action:"join",channel:"general-voice",peer:peers.amy}});
    clock+=1000;
    await people.amy("voice",{input:{action:"join",channel:"gaming",peer:peers.amy}});
    assert.deepEqual(await roster(),["bob","zed","amy"]);
    // Someone moved by an admin also lands at the end of the new room.
    const ownerPeer=crypto.randomUUID();
    clock+=1000;
    await owner("voice",{input:{action:"join",channel:"afk",peer:ownerPeer}});
    await owner("move",{input:{target:"bob",channel:"afk"}});
    assert.equal((await people.bob("poll?peer="+peers.bob)).moved,true);
    clock+=1000;
    await people.bob("voice",{input:{action:"join",channel:"afk",peer:peers.bob}});
    assert.deepEqual((await owner("poll?peer="+ownerPeer)).voice.map(p=>p.uid),["owner","bob"]);
    // Same join time falls back to the name, ignoring case.
    const members=(await owner("workspace")).people.map(p=>p.id);
    assert.deepEqual(members,["amy","bob","owner","zed"]);
  } finally {Date.now=realNow;}
});

test("moderators can disconnect, kick and time out members for a chosen length, and it is audited",async()=>{
  const {visitor}=fixture();
  const owner=visitor("owner"), member=visitor("member"), mod=visitor("mod"), other=visitor("other");
  await owner("enroll",{input:{username:"owner"}});
  for(const [id,client] of [["member",member],["mod",mod],["other",other]]){
    await client("enroll",{input:{username:id}});
    await owner("admin",{input:{action:"account",target:id,state:"approved",role:"member"}});
    await client("enroll",{input:{}});
  }
  const act=(client,input,expect=200)=>client("moderate",{input:{server:"community",...input},expect});
  // Ordinary members cannot moderate; moderators cannot act on admins, other moderators or themselves.
  await act(member,{action:"timeout",target:"other",duration:60000},403);
  await owner("admin",{input:{action:"member",server:"community",target:"mod",role:"moderator"}});
  await act(mod,{action:"kick",target:"owner"},403);
  await act(mod,{action:"timeout",target:"mod",duration:60000},409);
  await act(owner,{action:"timeout",target:"member",duration:30000},400);
  await act(owner,{action:"timeout",target:"member",duration:29*86400000},400);

  // Disconnect from voice.
  const peer=crypto.randomUUID();
  await member("voice",{input:{action:"join",channel:"gaming",peer}});
  await act(mod,{action:"disconnect",target:"member"});
  assert.equal((await member("poll?peer="+peer)).voice,null);
  await act(mod,{action:"disconnect",target:"member"},404);

  // A timeout of 90 minutes stops messages, reactions, edits and voice, but not reading.
  await member("message",{input:{channel:"general",text:"Before"}});
  const mid=(await member("history?channel=general")).messages[0].id;
  await member("voice",{input:{action:"join",channel:"gaming",peer}});
  await act(mod,{action:"timeout",target:"member",duration:90*60000});
  assert.equal((await member("poll?peer="+peer)).voice,null);
  const refused=await member("message",{input:{channel:"general",text:"During"},expect:403});
  assert.match(refused.error,/timed out in this server for 90 minutes/);
  await member("message",{input:{channel:"general",action:"react",id:mid,emoji:"👍"},expect:403});
  await member("message",{input:{channel:"general",action:"edit",id:mid,text:"Edited"},expect:403});
  await member("voice",{input:{action:"join",channel:"gaming",peer},expect:403});
  await member("typing",{input:{channel:"general"}});
  assert.deepEqual((await other("poll?channel=general&after=0")).typing,[]);
  assert.equal((await member("history?channel=general")).messages.length,1);
  const timeouts=(await other("workspace")).timeouts;
  assert.equal(timeouts.length,1);
  assert.equal(timeouts[0].uid,"member");
  // Lifting it restores everything.
  await act(owner,{action:"timeout",target:"member",duration:0});
  await member("message",{input:{channel:"general",text:"After"}});
  assert.deepEqual((await other("workspace")).timeouts,[]);

  // Kicking removes the person from the server and its rooms.
  await member("voice",{input:{action:"join",channel:"gaming",peer}});
  await act(mod,{action:"kick",target:"member"});
  await member("history?channel=general",{expect:404});
  await member("voice",{input:{action:"join",channel:"gaming",peer},expect:404});
  assert.deepEqual((await owner("poll?rooms=1")).rooms,[]);
  await act(mod,{action:"kick",target:"member"},404);

  const logs=(await owner("admin")).logs.filter(l=>["voice disconnect","timeout","timeout removed","kick"].includes(l.action)).map(l=>l.uid+" "+l.action+": "+l.detail).reverse();
  assert.deepEqual(logs,[
    "mod voice disconnect: member in community",
    "mod timeout: member in community for 90 minutes",
    "owner timeout removed: member in community lifted",
    "mod kick: member in community",
  ]);
});

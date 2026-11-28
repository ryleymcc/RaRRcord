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
    async delete(key){objects.delete(key);},
  };
  const origin="https://ra.example";
  const env={DB,BUCKET,RARRCORD_OWNER_EMAIL:"owner@example.test"};
  function visitor(id,email=id+"@example.test") {
    let cookie="";
    return async (path,{input,expect=200,otherOrigin,keepCookie=true,contentType,noLength}={})=>{
      const headers=new Headers();
      if(id){headers.set("oai-authenticated-user-id",id);headers.set("oai-authenticated-user-email",email);}
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
  return {visitor};
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
  assert.deepEqual(await member("ice"),{servers:[{urls:"stun:stun.cloudflare.com:3478"}]});
  await owner("admin",{input:{action:"settings",bitrate:8000,upload:1000000,stun:"stun:stun.example.test:3478"}});
  assert.deepEqual(await member("ice"),{servers:[{urls:"stun:stun.example.test:3478"}]});
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

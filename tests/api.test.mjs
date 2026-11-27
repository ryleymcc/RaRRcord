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
      };}};
    },
    async batch(statements){
      sqlite.exec("BEGIN");
      try {const result=await Promise.all(statements.map(s=>s.run()));sqlite.exec("COMMIT");return result;}
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
    return async (path,{input,expect=200,otherOrigin,keepCookie=true}={})=>{
      const headers=new Headers();
      if(id){headers.set("oai-authenticated-user-id",id);headers.set("oai-authenticated-user-email",email);}
      if(cookie&&keepCookie)headers.set("cookie",cookie);
      if(input!==undefined){
        headers.set("origin",otherOrigin??origin);
        if(!(input instanceof FormData))headers.set("content-type","application/json");
      }
      const result=await api(new Request(origin+"/api/ra/"+path,{method:input===undefined?"GET":"POST",headers,
        body:input===undefined||input instanceof FormData?input:JSON.stringify(input)}),env);
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
  await member("signal",{input:{channel:"gaming",peer,target:peer2,data:{type:"subscribe",medium:"screen",active:true}},expect:404});
  await second("voice",{input:{action:"join",channel:"gaming",peer:peer2}});
  await member("signal",{input:{channel:"gaming",peer,target:peer2,data:{type:"subscribe",medium:"screen",active:true}}});
  const received=await second("poll?peer="+peer2);
  assert.equal(received.signals[0].sender,peer);
  assert.equal(received.voice.length,2);
  await owner("admin",{input:{action:"disconnect",target:"member"}});
  assert.equal((await second("poll?peer="+peer2)).voice.length,1);
  assert.equal((await member("poll?peer="+peer)).voice,null);
});

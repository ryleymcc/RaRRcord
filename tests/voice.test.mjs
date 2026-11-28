import assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";
import { setImmediate as settle } from "node:timers/promises";
import { defaults } from "../app/ra-client.ts";

register("data:text/javascript,"+encodeURIComponent(`
  export function resolve(specifier, context, next) {
    if (context.parentURL?.endsWith('/app/rtc.ts') && specifier.startsWith('./')) specifier += '.ts';
    return next(specifier, context);
  }
`),import.meta.url);
const { VoiceSession }=await import("../app/rtc.ts");

function microphone(id){
  const track=Object.assign(new EventTarget(),{
    kind:"audio",enabled:true,readyState:"live",
    stop(){this.readyState="ended";},
  });
  return {id,track,getTracks:()=>[track],getAudioTracks:()=>[track]};
}

function fixture(t,{capture,respond}={}){
  const errors=[],calls=[],requests=[],constraints=[];
  let serverPeer;
  t.mock.method(globalThis,"fetch",async (path,options)=>{
    const body=options.body&&JSON.parse(options.body);
    requests.push({path,body});
    const response=await respond?.(body);
    if(response)return response;
    if(body?.action==="join")serverPeer=body.peer;
    if(body?.action==="leave" && body.peer===serverPeer)serverPeer=undefined;
    return Response.json(path.endsWith("/ice")?{servers:[]}:{});
  });
  const globals={
    window:new EventTarget(),
    HTMLElement:class {},
    navigator:{mediaDevices:{getUserMedia:async value=>{
      constraints.push(value);
      return capture?capture(constraints.length):microphone(String(constraints.length));
    }}},
    RTCPeerConnection:class {
      senders=[];
      restarts=0;
      addTrack(track,stream){const sender={track,stream};this.senders.push(sender);return sender;}
      removeTrack(sender){this.senders=this.senders.filter(item=>item!==sender);}
      restartIce(){this.restarts++;}
      close(){this.closed=true;}
    },
  };
  for(const [name,value] of Object.entries(globals)){
    const previous=Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{configurable:true,value});
    t.after(()=>previous?Object.defineProperty(globalThis,name,previous):delete globalThis[name]);
  }
  globals.window.clearInterval=()=>{};
  const voice=new VoiceSession(call=>calls.push(call),()=>{},error=>errors.push(error));
  return {voice,calls,errors,requests,constraints,serverPeer:()=>serverPeer};
}

const remote={uid:"member",peer:"remote",name:"Member",cam:0,screen:0};

test("explicit join publishes the selected microphone, preserves mute through ICE recovery, and cleans up on leave",async t=>{
  const {voice,constraints,requests}=fixture(t);
  const prefs={...defaults,input:"usb-mic",noise:false,echo:true,gain:false};
  await voice.join("general-voice",prefs,0);
  await settle();
  const call=voice.call;
  assert.deepEqual(constraints,[{audio:{deviceId:{exact:"usb-mic"},noiseSuppression:false,echoCancellation:true,autoGainControl:false}}]);
  assert.equal(call.microphoneActive,true);
  await call.update([remote],[]);
  const {pc}=call.links.get(remote.peer);
  const track=call.local.get("voice").track;
  assert.deepEqual(pc.senders.map(sender=>sender.track),[track]);
  assert.equal(track.enabled,true);
  await call.toggleMicrophone();
  pc.iceConnectionState="failed";
  pc.oniceconnectionstatechange();
  await voice.join("general-voice",prefs,0);
  assert.equal(pc.restarts,1);
  assert.equal(track.enabled,false);
  assert.equal(call.microphoneActive,false);
  assert.equal(constraints.length,1);
  await call.toggleMicrophone();
  assert.equal(track.enabled,true);
  call.setDeaf(true);
  await call.toggleMicrophone();
  assert.equal(track.enabled,false);
  assert.equal(call.microphoneActive,false);
  call.setDeaf(false);
  assert.equal(track.enabled,true);
  voice.disconnect();
  assert.equal(voice.call,null);
  assert.equal(track.readyState,"ended");
  assert.equal(pc.closed,true);
  assert.ok(requests.some(({body})=>body?.action==="leave"&&body.peer===call.peer));
});

test("denied permission and a missing microphone keep the room connected and allow a retry",async t=>{
  const {voice,errors}=fixture(t,{capture:attempt=>{
    if(attempt<3)throw new DOMException("capture failed",attempt===1?"NotAllowedError":"NotFoundError");
    return microphone("retry");
  }});
  await voice.join("general-voice",defaults,0);
  await settle();
  const call=voice.call;
  assert.equal(call.microphoneActive,false);
  assert.equal(call.local.has("voice"),false);
  assert.match(errors[0],/permission was declined or blocked/);
  await call.toggleMicrophone();
  assert.equal(call.microphoneActive,false);
  assert.match(errors[1],/selected microphone is unavailable/);
  await call.toggleMicrophone();
  assert.equal(call.microphoneActive,true);
  call.local.get("voice").track.stop();
  call.local.get("voice").track.dispatchEvent(new Event("ended"));
  assert.equal(call.microphoneActive,false);
  voice.disconnect();
});

test("push to talk keeps the track silent until the configured key is pressed",async t=>{
  const {voice}=fixture(t);
  await voice.join("gaming",{...defaults,ptt:true,key:"KeyV"},0);
  await settle();
  const track=voice.call.local.get("voice").track;
  assert.equal(track.enabled,false);
  const keydown=Object.assign(new Event("keydown"),{code:"KeyV"});
  window.dispatchEvent(keydown);
  assert.equal(track.enabled,true);
  window.dispatchEvent(new Event("blur"));
  assert.equal(track.enabled,false);
  voice.disconnect();
});

test("switching rooms while permission is pending stops the old stream before starting another",async t=>{
  const first=Promise.withResolvers();
  const stale=microphone("old");
  const {voice,constraints,serverPeer}=fixture(t,{capture:attempt=>{
    if(attempt===1)return first.promise;
    assert.equal(stale.track.readyState,"ended");
    return microphone("new");
  }});
  await voice.join("general-voice",defaults,0);
  await settle();
  assert.equal(voice.call.microphonePending,true);
  await voice.join("gaming",defaults,0);
  assert.equal(voice.call.channel,"gaming");
  assert.equal(voice.call.microphoneActive,false);
  assert.equal(constraints.length,1);
  first.resolve(stale);
  await settle();
  assert.equal(voice.call.microphoneActive,true);
  assert.equal(serverPeer(),voice.call.peer);
  assert.equal(constraints.length,2);
  voice.ended(voice.call);
  assert.equal(voice.call,null);
  await settle();
  assert.equal(constraints.length,2);
});

test("a rapid switch supersedes an in-flight join, and a rejected join never opens the microphone",async t=>{
  const entered=Promise.withResolvers(),first=Promise.withResolvers();
  const {voice,calls,errors,constraints,requests,serverPeer}=fixture(t,{respond:async body=>{
    if(body?.action!=="join")return;
    if(body.channel==="general-voice"){entered.resolve();await first.promise;}
    if(body.channel==="locked")return Response.json({error:"Voice room unavailable."},{status:403});
  }});
  const old=voice.join("general-voice",defaults,0);
  await entered.promise;
  const next=voice.join("gaming",defaults,0);
  const duplicate=voice.join("gaming",defaults,0);
  first.resolve();
  await Promise.all([old,next,duplicate]);
  await settle();
  assert.deepEqual(calls.map(call=>call?.channel),["gaming"]);
  assert.equal(serverPeer(),voice.call.peer);
  assert.equal(requests.filter(({body})=>body?.action==="join").length,2);
  assert.equal(constraints.length,1);
  const track=voice.call.local.get("voice").track;
  await voice.join("locked",defaults,0);
  assert.equal(track.readyState,"ended");
  assert.equal(voice.call,null);
  assert.equal(constraints.length,1);
  assert.deepEqual(errors,["Voice room unavailable."]);
});

test("cameras and screen shares open automatically, and stopping one holds until that share ends; a share that ends sends no unsubscribe",async t=>{
  const {voice,requests}=fixture(t);
  await voice.join("general-voice",defaults,0);
  await settle();
  const call=voice.call;
  const subscriptions=()=>requests.filter(({path})=>path.endsWith("/signal")).map(({body})=>body.data).filter(data=>data.type==="subscribe");
  await call.update([{...remote,screen:1}],[]);
  assert.equal(call.watching(remote.peer,"screen"),true);
  assert.equal(call.watching(remote.peer,"cam"),false);
  await call.update([{...remote,screen:1,cam:1}],[]);
  assert.equal(call.watching(remote.peer,"cam"),true);
  call.watch(remote.peer,"screen",false);
  await call.update([{...remote,screen:1,cam:1}],[]);
  assert.equal(call.watching(remote.peer,"screen"),false);
  await call.update([{...remote,cam:1}],[]);
  await call.update([{...remote,cam:1,screen:1}],[]);
  assert.equal(call.watching(remote.peer,"screen"),true);
  await call.update([remote],[]);
  assert.equal(call.watching(remote.peer,"cam"),false);
  assert.equal(call.watching(remote.peer,"screen"),false);
  assert.deepEqual(subscriptions().map(({medium,active})=>medium+":"+active),["screen:true","cam:true","screen:false","screen:true"]);
  voice.disconnect();
});

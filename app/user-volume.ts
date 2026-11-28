// Per-listener volume for each person you hear, like a "User volume" slider.
// It is stored only in this browser, keyed by user id so it survives rejoining a call.
// Voice and screen-share audio are kept apart: "stream:<uid>" holds a person's stream volume.
export const maxVolume=2;
const storageKey="rarrcord.userVolumes";
const previewKey="rarrcord.screenPreview";

export const streamVolumeKey=(uid:string)=>"stream:"+uid;
export const clampVolume=(value:number)=>Number.isFinite(value)?Math.min(maxVolume,Math.max(0,Math.round(value*100)/100)):1;

export function loadVolumes():Record<string,number>{
  try{
    const raw=JSON.parse(localStorage.getItem(storageKey)??"{}") as unknown;
    if(!raw||typeof raw!=="object")return {};
    return Object.fromEntries(Object.entries(raw as Record<string,unknown>).filter(([,v])=>typeof v==="number").map(([k,v])=>[k,clampVolume(v as number)]));
  }catch{return {};}
}
// Full volume is the default, so it is not stored; this keeps the saved list to people you changed.
export function setVolume(volumes:Record<string,number>,key:string,value:number){
  const next={...volumes};
  const v=clampVolume(value);
  if(v===1)delete next[key];else next[key]=v;
  try{localStorage.setItem(storageKey,JSON.stringify(next));}catch{/* private mode: keep it for this visit only */}
  return next;
}

// Whether you see a preview of your own screen while you share it. On unless you hid it.
// Off unless chosen: drawing your own share costs the sharer GPU time, and a preview inside a shared screen is captured again.
export function loadScreenPreview(){try{return localStorage.getItem(previewKey)==="on";}catch{return false;}}
export function saveScreenPreview(on:boolean){try{localStorage.setItem(previewKey,on?"on":"off");}catch{/* ignore */}}

// Remote audio plays through a Web Audio gain node, so a person's volume is applied the same way at every level,
// including boosts above 100% that a media element cannot reach. Element volume on a remote WebRTC stream is
// unreliable in Chrome (it is ignored while the same track also feeds an AudioContext, as the speaking meter does).
// The element still plays the stream, muted: Chrome only decodes remote audio for Web Audio while an element plays it.
// One context per output device is shared by everyone you hear.
const contexts=new Map<string,AudioContext>();
type SinkContext=AudioContext & {setSinkId?(id:string):Promise<void>};
export function canBoost(output:string){
  if(typeof AudioContext==="undefined")return false;
  // Without AudioContext.setSinkId the audio would play on the default device instead of the chosen one.
  return !output||"setSinkId" in AudioContext.prototype;
}
export type Route={gain:GainNode;release:()=>void};
function contextFor(output:string){
  let context=contexts.get(output) as SinkContext|undefined;
  if(!context||context.state==="closed"){
    context=new AudioContext() as SinkContext;
    if(output)void context.setSinkId?.(output).catch(()=>{});
    contexts.set(output,context);
  }
  if(context.state!=="running")void context.resume().catch(()=>{});
  return context;
}
// Returns null while the browser keeps audio suspended (no click on the page yet); `ready` fires once it may start.
export function route(stream:MediaStream,output:string,ready:()=>void):Route|null{
  if(!canBoost(output)||!stream.getAudioTracks().length)return null;
  try{
    const context=contextFor(output);
    if(context.state!=="running"){
      context.addEventListener("statechange",()=>{if(context.state==="running")ready();},{once:true});
      return null;
    }
    const source=context.createMediaStreamSource(stream);
    const gain=context.createGain();
    source.connect(gain).connect(context.destination);
    return {gain,release:()=>{try{source.disconnect();gain.disconnect();}catch{/* already gone */}}};
  }catch{return null;}
}
export function setGain(route:Route,value:number){
  const now=route.gain.context.currentTime;
  // A short ramp avoids clicks while a slider is dragged.
  route.gain.gain.cancelScheduledValues(now);
  route.gain.gain.setTargetAtTime(value,now,0.015);
}

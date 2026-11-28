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
export function loadScreenPreview(){try{return localStorage.getItem(previewKey)!=="off";}catch{return true;}}
export function saveScreenPreview(on:boolean){try{localStorage.setItem(previewKey,on?"on":"off");}catch{/* ignore */}}

// A media element cannot play louder than volume 1, so boosts above 100% go through Web Audio.
// One context per output device is shared by every boosted person.
const contexts=new Map<string,AudioContext>();
type SinkContext=AudioContext & {setSinkId?(id:string):Promise<void>};
export function canBoost(output:string){
  if(typeof AudioContext==="undefined")return false;
  // Without AudioContext.setSinkId a boosted voice would play on the default device instead of the chosen one.
  return !output||"setSinkId" in AudioContext.prototype;
}
export function boost(stream:MediaStream,gainValue:number,output:string):(()=>void)|null{
  if(!canBoost(output)||!stream.getAudioTracks().length)return null;
  try{
    let context=contexts.get(output) as SinkContext|undefined;
    if(!context||context.state==="closed"){
      context=new AudioContext() as SinkContext;
      if(output)void context.setSinkId?.(output).catch(()=>{});
      contexts.set(output,context);
    }
    void context.resume().catch(()=>{});
    const source=context.createMediaStreamSource(stream);
    const gain=context.createGain();
    gain.gain.value=gainValue;
    source.connect(gain).connect(context.destination);
    return ()=>{try{source.disconnect();gain.disconnect();}catch{/* already gone */}};
  }catch{return null;}
}

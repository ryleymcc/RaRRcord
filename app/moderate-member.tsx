"use client";
import { useState } from "react";
import { confirmAction } from "./dialog";
import { request, type Channel, type Person } from "./ra-client";

// Discord-style presets, plus a custom length up to Discord's 28-day limit.
export const timeoutPresets=[["60 seconds",60000],["5 minutes",300000],["10 minutes",600000],["1 hour",3600000],["1 day",86400000],["1 week",604800000]] as const;
const units=[["minutes",60000],["hours",3600000],["days",86400000]] as const;
export const maxTimeout=28*86400000;

// "45 seconds", "90 minutes", "1 hour", "36 hours", "2 days": the largest unit that is exact or
// at least two of it, rounded up. Matches the wording the server uses.
export function timeLeft(ms:number){
  // Round up to the second, and past a minute to the minute, so "1:59:50" reads "2 hours".
  ms = Math.ceil(ms/1000)*1000;
  if (ms>60000) ms=Math.ceil(ms/60000)*60000;
  const steps=[[86400000,"day"],[3600000,"hour"],[60000,"minute"],[1000,"second"]] as const;
  const [size,unit]=steps.find(([size])=>ms%size===0&&ms>=size || ms>=2*size) ?? steps[3];
  const n=Math.ceil(ms/size);
  return n+" "+unit+(n===1?"":"s");
}

export default function ModerateMember({person,server,serverName,rooms,room,until,now,canMove,move,done,report}:{
  person:Person;server:string;serverName:string;rooms:Channel[];room?:string;until?:number;now:number;canMove:boolean;
  move:(room:Channel)=>Promise<void>;done:(message:string)=>void;report:(message:string)=>void;
}){
  const [destination,setDestination]=useState(rooms.find(r=>r.id!==room)?.id??"");
  const [amount,setAmount]=useState(30);
  const [unit,setUnit]=useState<number>(60000);
  const [busy,setBusy]=useState(false);
  const act=async (input:Record<string,unknown>,message:string)=>{
    setBusy(true);
    try{await request("moderate",{server,target:person.id,...input});done(message);}
    catch(e){report(e instanceof Error?e.message:"That didn’t work.");}
    finally{setBusy(false);}
  };
  const timeOut=(duration:number)=>act({action:"timeout",duration},person.name+" is timed out for "+timeLeft(duration)+".");
  const custom=Math.round(amount*unit);
  const customValid=Number.isFinite(custom)&&custom>=60000&&custom<=maxTimeout;
  const current=room?rooms.find(r=>r.id===room):undefined;
  const remaining=until?until-now:0;
  return <div className="settings-form moderate-member">
    <section>
      <h3>Voice</h3>
      {current?<>
        <p>{person.name} is in {current.name}.</p>
        {canMove&&rooms.length>1&&<div className="inline">
          <label>Move to <select value={destination} onChange={e=>setDestination(e.target.value)}>{rooms.filter(r=>r.id!==room).map(r=><option key={r.id} value={r.id}>{r.name}</option>)}</select></label>
          <button type="button" disabled={busy||!destination} onClick={async()=>{const target=rooms.find(r=>r.id===destination);if(!target)return;setBusy(true);try{await move(target);}finally{setBusy(false);}}}>Move</button>
        </div>}
        <button type="button" disabled={busy} onClick={()=>act({action:"disconnect"},person.name+" was disconnected from voice.")}>Disconnect from voice</button>
      </>:<p>{person.name} is not in a voice room here.</p>}
    </section>
    <section>
      <h3>Time out</h3>
      <p>A timed-out member can still read, but can’t send messages, react or join voice in {serverName} until it ends.</p>
      {remaining>0&&<div className="inline"><b>Timed out for {timeLeft(remaining)} more.</b><button type="button" disabled={busy} onClick={()=>act({action:"timeout",duration:0},person.name+"’s timeout was removed.")}>Remove timeout</button></div>}
      <div className="timeout-presets" role="group" aria-label="Timeout length">{timeoutPresets.map(([label,ms])=><button type="button" key={ms} disabled={busy} onClick={()=>timeOut(ms)}>{label}</button>)}</div>
      <form className="inline" onSubmit={e=>{e.preventDefault();if(customValid)void timeOut(custom);}}>
        <label>Custom <input type="number" min={1} step="any" value={amount} onChange={e=>setAmount(+e.target.value)} aria-label="Custom timeout length" style={{width:"6em"}}/></label>
        <select aria-label="Custom timeout unit" value={unit} onChange={e=>setUnit(+e.target.value)}>{units.map(([label,ms])=><option key={ms} value={ms}>{label}</option>)}</select>
        <button type="submit" disabled={busy||!customValid}>Time out</button>
      </form>
      {!customValid&&<small className="danger">Choose between 1 minute and 28 days.</small>}
    </section>
    <section>
      <h3>Kick</h3>
      <p>Removes {person.name} from {serverName} and its rooms. An administrator can add them back from Administration.</p>
      <button type="button" className="danger-button" disabled={busy} onClick={async()=>{
        const answer=await confirmAction({title:"Kick "+person.name,body:person.name+" will be removed from "+serverName+".",action:"Kick",danger:true});
        if(answer.ok)await act({action:"kick"},person.name+" was kicked from "+serverName+".");
      }}>Kick from {serverName}</button>
    </section>
  </div>;
}

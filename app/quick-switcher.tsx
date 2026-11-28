"use client";
import { useState } from "react";
import { AudioLines, Hash, LockKeyhole, MessageSquare, User } from "lucide-react";
import type { Channel, Person, Server } from "./ra-client";

type Entry={key:string;label:string;detail:string;kind:string;pick:()=>void};
// Ctrl+K: type part of a channel or person's name and press Enter.
export default function QuickSwitcher({channels,servers,people,me,openChannel,openPerson}:{channels:Channel[];servers:Server[];people:Person[];me?:string;openChannel:(c:Channel)=>void;openPerson:(p:Person)=>void}){
  const [query,setQuery]=useState("");
  const [index,setIndex]=useState(0);
  const serverName=new Map(servers.map(s=>[s.id,s.name]));
  const entries:Entry[]=[
    ...channels.map(c=>({key:"c"+c.id,label:c.name,detail:c.kind==="dm"?"Direct message":serverName.get(c.server??"")??"",kind:c.kind,pick:()=>openChannel(c)})),
    ...people.filter(p=>p.id!==me).map(p=>({key:"p"+p.id,label:p.name,detail:"@"+p.username,kind:"person",pick:()=>openPerson(p)})),
  ];
  const q=query.trim().toLowerCase();
  const results=(q?entries.filter(e=>(e.label+" "+e.detail).toLowerCase().includes(q)):entries).slice(0,12);
  const active=Math.min(index,Math.max(results.length-1,0));
  const icon=(kind:string)=>kind==="voice"?<AudioLines size={16}/>:kind==="private"?<LockKeyhole size={16}/>:kind==="dm"?<MessageSquare size={16}/>:kind==="person"?<User size={16}/>:<Hash size={16}/>;
  return <div className="switcher">
    <input data-autofocus aria-label="Find a channel or person" placeholder="Where would you like to go?" value={query} role="combobox" aria-expanded="true" aria-controls="switcher-results" aria-activedescendant={results[active]?"switch-"+results[active].key:undefined}
      onChange={e=>{setQuery(e.target.value);setIndex(0);}}
      onKeyDown={e=>{
        if(e.key==="ArrowDown"){e.preventDefault();setIndex((active+1)%Math.max(results.length,1));}
        else if(e.key==="ArrowUp"){e.preventDefault();setIndex((active-1+results.length)%Math.max(results.length,1));}
        else if(e.key==="Enter"){e.preventDefault();results[active]?.pick();}
      }}/>
    <ul id="switcher-results" role="listbox" aria-label="Results">
      {results.map((e,i)=><li key={e.key} id={"switch-"+e.key} role="option" aria-selected={i===active} onMouseMove={()=>setIndex(i)} onClick={e.pick}>{icon(e.kind)}<span>{e.label}</span><small>{e.detail}</small></li>)}
      {!results.length&&<li className="none">Nothing matches “{query}”</li>}
    </ul>
    <small className="switcher-hint">↑ ↓ to move · Enter to open · Esc to close</small>
  </div>;
}

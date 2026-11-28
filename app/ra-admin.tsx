"use client";
import {useEffect,useState,type FormEvent} from "react";
import {request,type Channel,type Person,type Server} from "./ra-client";
type Workspace={servers:Server[];channels:Channel[];settings:{key:string;value:string}[]};
type State={users:(Person&{seen:number})[];channels:Channel[];logs:{id:number;name:string;action:string;detail:string;time:number}[];streams:{uid:string;name:string;room:string;cam:number;screen:number}[];roles:{server:string;name:string}[];members:{server:string;uid:string;role:string}[]};
export default function Admin({space,server,report,refresh}:{space:Workspace;server:string;report:(text:string)=>void;refresh:()=>Promise<void>}){
  const [tab,setTab]=useState("Members");
  const [data,setData]=useState<State|null>(null);
  const [invite,setInvite]=useState("");
  const [targetServer,setTargetServer]=useState(server);
  const [channel,setChannel]=useState<Channel|null>(null);
  const [channelKind,setChannelKind]=useState("text");
  const [serverEdit,setServerEdit]=useState(false);
  const update=()=>request<State>("admin").then(setData).catch(e=>report(e.message));
  useEffect(()=>{void update();},[]);
  async function act(input:object){
    try{
      const result=await request<{invitation?:string}>("admin",input);
      if(result.invitation)setInvite(result.invitation);else report("Changes saved.");
      await Promise.all([update(),refresh()]);
    }catch(e){report((e as Error).message);}
  }
  const active=space.servers.find(s=>s.id===targetServer);
  const channels=(data?.channels??space.channels).filter(c=>c.server===targetServer);
  const roles=["member","moderator",...(data?.roles.filter(r=>r.server===targetServer).map(r=>r.name)??[])];
  const settings=Object.fromEntries(space.settings.map(r=>[r.key,r.value]));
  function form(e:FormEvent<HTMLFormElement>){e.preventDefault();return Object.fromEntries(new FormData(e.currentTarget));}
  const menu=<label>Server<select value={targetServer} onChange={e=>{setTargetServer(e.target.value);setChannel(null);setChannelKind("text");}}>{space.servers.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}</select></label>;
  return <div className="admin">
    <nav className="tabs" aria-label="Administration sections">{["Members","Servers","Activity","Settings"].map(t=><button className={t===tab?"active":""} key={t} onClick={()=>setTab(t)}>{t}{t==="Members"&&!!data?.users.some(u=>u.state==="pending")&&<span className="badge">{data.users.filter(u=>u.state==="pending").length}</span>}</button>)}</nav>
    {!data&&<p>Loading administration…</p>}
    {tab==="Members"&&data&&<div className="settings-form">
      <div className="admin-header"><div><h3>Membership requests</h3><p>Applications remain pending until an administrator approves them.</p></div><button onClick={()=>void update()}>Refresh</button></div>
      {data.users.filter(u=>u.state==="pending").map(u=><div className="admin-row" key={u.id}><span><strong>{u.name}</strong> @{u.username}</span><button className="primary" onClick={()=>void act({action:"account",target:u.id,state:"approved",role:"member"})}>Approve</button><button onClick={()=>void act({action:"account",target:u.id,state:"banned",role:"member"})}>Ban</button></div>)}
      {!data.users.some(u=>u.state==="pending")&&<p>No pending requests.</p>}
      <h3>Accounts</h3>
      {data.users.filter(u=>u.state!=="pending").map(u=><form className="admin-row" key={u.id+"-"+u.state+"-"+u.role} onSubmit={e=>void act({action:"account",target:u.id,...form(e)})}>
        <span><strong>{u.name}</strong><small>@{u.username} · {({online:"Online",idle:"Idle",dnd:"Do not disturb",offline:"Invisible"} as Record<string,string>)[u.status]??u.status}</small></span>
        <select aria-label={"Status for "+u.name} name="state" defaultValue={u.state}>{["approved","suspended","banned","deleted"].map(s=><option key={s} value={s}>{s[0].toUpperCase()+s.slice(1)}</option>)}</select>
        <select aria-label={"Role for "+u.name} name="role" defaultValue={u.role}><option value="member">Member</option><option value="admin">Administrator</option></select>
        <button>Save</button><button type="button" onClick={()=>void act({action:"revoke",target:u.id})}>Revoke sessions</button>
      </form>)}
      <h3>Single-use invitations</h3>
      <div className="inline">{menu}<button onClick={()=>void act({action:"invite",target:targetServer})}>Create invitation</button></div>
      {invite&&<label>Invitation code<input readOnly value={invite} onFocus={e=>e.target.select()}/><small>Expires in seven days. Site access and app approval still apply.</small></label>}
    </div>}
    {tab==="Servers"&&<div className="settings-form">
      {menu}
      <form className="inline" key={String(serverEdit)+targetServer} onSubmit={e=>void act({action:"server",target:serverEdit?targetServer:"",...form(e)})}>
        <label>Server name<input name="name" required maxLength={60} defaultValue={serverEdit?active?.name:""}/></label><label>Server icon<input name="icon" maxLength={4} defaultValue={serverEdit?active?.icon:""}/></label>
        <button className="primary">{serverEdit?"Rename server":"Create server"}</button>
        <button type="button" onClick={()=>setServerEdit(!serverEdit)}>{serverEdit?"Create new":"Edit selected"}</button>
        {serverEdit&&active&&<button type="button" className="danger" onClick={()=>{if(confirm("Delete this server and remove access to its channels?"))void act({action:"server_delete",target:targetServer});}}>Delete server</button>}
      </form>
      <h3>Channels</h3><p>Drag a channel onto another row to move it to that position.</p>
      <div>{channels.map(c=><div className="admin-row" draggable key={c.id} onDragStart={e=>e.dataTransfer.setData("text/plain",c.id)} onDragOver={e=>e.preventDefault()} onDrop={e=>{
        e.preventDefault();
        const source=channels.find(x=>x.id===e.dataTransfer.getData("text/plain"));
        if(source&&source.id!==c.id)void act({action:"order",target:source.id,destination:c.id,server:targetServer});
      }}><span>{c.name}<small>{c.kind} · {c.category||"Channels"}</small></span><button onClick={()=>{setChannel(c);setChannelKind(c.kind);}}>Edit</button><button className="danger" onClick={()=>{if(confirm("Delete this channel and remove access to its history?"))void act({action:"channel_delete",target:c.id});}}>Delete</button></div>)}</div>
      {channel&&<button onClick={()=>{setChannel(null);setChannelKind("text");}}>New channel</button>}
      <form className="settings-form" key={channel?.id??"new"} onSubmit={e=>{
        const fd=new FormData(e.currentTarget);e.preventDefault();
        void act({action:"channel",target:channel?.id,server:targetServer,...Object.fromEntries(fd),users:fd.getAll("users")});
      }}>
        <fieldset><legend>{channel?"Edit channel":"Create channel"}</legend>
          <label>Name<input name="name" defaultValue={channel?.name} required maxLength={60}/></label>
          <label>Type<select name="kind" value={channelKind} onChange={e=>setChannelKind(e.target.value)}><option value="text">Text</option><option value="voice">Voice</option><option value="private">Private text</option></select></label>
          <label>Category<input name="category" maxLength={40} defaultValue={channel?.category??"Text channels"}/></label>
          <label>Description<input name="description" maxLength={200} defaultValue={channel?.description}/></label>
          <label>Position<input name="position" type="number" min={0} defaultValue={channel?.position??channels.length}/></label>
          {channelKind==="private"?<div><p>Allowed server members</p>{data?.members.filter(m=>m.server===targetServer).map(m=><label key={m.uid} className="inline"><input name="users" type="checkbox" value={m.uid} defaultChecked={channel?.allowed?.includes(m.uid)??data.users.find(u=>u.id===m.uid)?.role==="admin"}/>{data.users.find(u=>u.id===m.uid)?.name??m.uid}</label>)}</div>:
            <label>Required role<select name="permission" defaultValue={channel?.permission}><option value="">Any server member</option>{roles.map(r=><option key={r}>{r}</option>)}</select></label>}
          <button className="primary">{channel?"Save channel":"Create channel"}</button>
        </fieldset>
      </form>
      <form className="inline" onSubmit={e=>void act({action:"role",server:targetServer,...form(e)})}><label>New role<input name="role" maxLength={32} required/></label><button>Create role</button></form>
      <form className="inline" onSubmit={e=>void act({action:"member",server:targetServer,...form(e)})}>
        <label>Account<select name="target" required>{data?.users.filter(u=>u.state==="approved").map(u=><option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label>Role<select name="role">{roles.map(r=><option key={r}>{r}</option>)}</select></label><button>Add or assign role</button>
        <button type="button" onClick={e=>{const f=e.currentTarget.form;if(f&&confirm("Remove this account from this server?"))void act({action:"member",server:targetServer,...Object.fromEntries(new FormData(f)),remove:true});}}>Remove membership</button>
      </form>
    </div>}
    {tab==="Activity"&&data&&<div className="settings-form">
      <div className="admin-header"><h3>Voice rooms and streams</h3><button onClick={()=>void update()}>Refresh</button></div>
      {!data.streams.length&&<p>No active voice connections.</p>}
      {data.streams.map(s=><div key={s.uid} className="admin-row"><span>{s.name}<small>{s.room}{s.cam?" · Camera":""}{s.screen?" · Screen share":""}</small></span><button onClick={()=>void act({action:"disconnect",target:s.uid})}>Disconnect</button></div>)}
      <h3>Audit log</h3>{data.logs.map(log=><div key={log.id} className="admin-row"><div><b>{log.action}</b><small>{log.name} · {new Date(log.time).toLocaleString()}</small><small>{log.detail}</small></div></div>)}
    </div>}
    {tab==="Settings"&&<form className="settings-form" onSubmit={e=>void act({action:"settings",...form(e)})}>
      <label>Maximum upload size (bytes)<input required name="upload" type="number" min={100000} max={20000000} defaultValue={settings.upload??8000000}/></label>
      <label>Community stream bitrate ceiling (Kbps)<input name="bitrate" type="number" min={0} max={4294967} placeholder="No community cap" defaultValue={Number(settings.bitrate)||""}/></label>
      <label>STUN server<input name="stun" placeholder="stun:hostname:3478" defaultValue={settings.stun??""}/></label>
      <p>STUN or a TURN relay can help users on different networks connect. A TURN broker can be configured in Sites using server-only values that issue short-lived credentials.</p><button className="primary">Save settings</button>
    </form>}
  </div>;
}

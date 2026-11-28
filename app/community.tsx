"use client";
import { Fragment,memo,useCallback,useEffect,useLayoutEffect,useRef,useState, type ClipboardEvent, type FormEvent, type ReactNode } from "react";
import { AudioLines, Expand, HeadphoneOff, LayoutGrid, Maximize2, MonitorOff, PhoneOff, VideoOff, Volume2, VolumeX, Eye, EyeOff, ChevronDown, CircleHelp, Copy, CornerUpLeft, Ellipsis, Flag, Headphones, Hash, LockKeyhole, LogOut, Menu, MessageSquare, Mic, MicOff, MonitorUp, Paperclip, ArrowDown, Download, FileText, Pencil, Pin, Plus, Reply, Search, Send, Settings, Shield, Smile, SmilePlus, Trash2, Users, Video, X } from "lucide-react";
import { ConfirmHost, Modal, confirmAction } from "./dialog";
import { friendlyError } from "./friendly-error";
import { useMedia } from "./use-media";
import QuickSwitcher from "./quick-switcher";
import { isImage, typingText, uploadWithProgress } from "./upload";
import { playVoiceCue } from "./voice-sounds";
import { canBoost, route, setGain, type Route, loadScreenPreview, loadVolumes, maxVolume, saveScreenPreview, setVolume, streamVolumeKey } from "./user-volume";
import { microphoneConstraints, processVoice, suppressionMode, suppressionModes, type VoiceProcessor } from "./noise-suppression";
import { VoiceSession, codecs, type Call, type Feed, type Metrics, type Participant, type Signal } from "./rtc";
import { request, defaults, qualities, type Channel, type Message, type Person, type Preferences, type Server } from "./ra-client";
import Admin from "./ra-admin";
import { DiagnosticCharts, WebRtcInternals } from "./diagnostic-charts";
import { diagnosticSample, type DiagnosticSample } from "./diagnostic-data";
import EmojiPicker from "./emoji-picker";

type Workspace={servers:Server[]; channels:Channel[]; people:Person[]; settings:{key:string;value:string}[];prefs:Partial<Preferences>};
type Auth={user:Person|null;active:boolean;ownerConfigured?:boolean};
type History={messages:Message[];cursor:number};
type RoomMember={channel:string;uid:string;name:string;has_avatar:boolean;cam:number;screen:number};
type Update={messages?:Message[];cursor?:number;typing?:{name:string}[];voice?:Participant[]|null;signals?:Signal[];rooms?:RoomMember[]};
const day=(v:number)=>new Date(v).toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric"});
const clock=(v:number)=>new Date(v).toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"});
const initials=(s:string)=>s.trim().split(/\s+/).slice(0,2).map(x=>x[0]).join("").toUpperCase();
const statuses=[["online","Online"],["idle","Idle"],["dnd","Do not disturb"],["offline","Invisible"]] as const;
const statusLabel=(s:string)=>statuses.find(x=>x[0]===s)?.[1]??s;
const avatarUrl=(id:string)=>"/api/ra/avatar?key="+encodeURIComponent(id);
function Avatar({name,uid,has,status}:{name:string;uid:string;has?:boolean;status?:string}){
  const color=[...uid].reduce((sum,c)=>sum+c.charCodeAt(0),0)%6;
  return <span className={"avatar hue-"+color}>{has?<img src={avatarUrl(uid)} alt=""/>:initials(name)}{status&&<i className={"presence "+status} title={statusLabel(status)}/>}</span>;
}
type VoiceMember={uid:string;name:string;avatar:boolean;live:boolean;cam:boolean;speaking:boolean};
function VoiceMembers({members}:{members:VoiceMember[]}){
  if(!members.length)return null;
  return <ul className="voice-members" aria-label="In this voice room">{members.map(m=><li key={m.uid} className={m.speaking?"speaking":""}>
    <Avatar name={m.name} uid={m.uid} has={m.avatar}/><span>{m.name}</span>{m.cam&&<Video size={13} aria-label="Camera on"/>}{m.live&&<b className="live-tag">LIVE</b>}
  </li>)}</ul>;
}
type RowActions={action:(kind:string,m:Message,extra?:object)=>Promise<void>;reply:(m:Message)=>void;pick:(m:Message)=>void;edit:(m:Message)=>void;menu:(id:number|null)=>void;jump:(id:number)=>void;remove:(m:Message)=>void;report:(m:Message)=>void};
const snippet=(text:string)=>text.replace(/\x60\x60\x60[\s\S]*?(\x60\x60\x60|$)/g,"[code]").replace(/\s+/g," ").trim().slice(0,120);
// A row only re-renders when its message, its neighbour, its menu or the viewer changes, not on every poll.
const MessageRow=memo(function MessageRow({m,previous,replyTo,me,admin,menuOpen,unreadStart=false,actions}:{m:Message;previous?:Message;replyTo?:Message;me?:string;admin:boolean;menuOpen:boolean;unreadStart?:boolean;actions:RowActions}){
  const newDay=!previous||day(previous.created)!==day(m.created);
  const joined=!unreadStart&&!m.reply&&!!previous&&!newDay&&previous.uid===m.uid&&m.created-previous.created<240000;
  const reacts=Object.entries(m.reactions?JSON.parse(m.reactions) as Record<string,number>:{});
  const mine=new Set<string>(m.my_reactions?JSON.parse(m.my_reactions):[]);
  const press=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
  const mineMessage=me===m.uid;
  const close=()=>actions.menu(null);
  return <div className="message-row" style={{containIntrinsicSize:joined?"auto 28px":"auto 72px"}}>
    {newDay&&<div className="date-divider"><span>{day(m.created)}</span></div>}
    {unreadStart&&<div className="unread-divider" role="separator"><span>New messages</span></div>}
    <article id={"msg-"+m.id} className={"message "+(joined?"joined":"")+(menuOpen?" menu-open":"")} aria-label={"Message by "+m.name}
      onContextMenu={event=>{if((event.target as HTMLElement).closest("a,img,pre,code"))return;event.preventDefault();actions.menu(m.id);}}
      onPointerDown={event=>{if(event.pointerType!=="touch")return;press.current=setTimeout(()=>actions.menu(m.id),450);}}
      onPointerUp={()=>clearTimeout(press.current)} onPointerMove={()=>clearTimeout(press.current)} onPointerCancel={()=>clearTimeout(press.current)}>
      {m.reply?<button type="button" className="reply-preview" onClick={()=>actions.jump(m.reply!)} disabled={!replyTo}>
        <CornerUpLeft size={13}/>{replyTo?<><Avatar name={replyTo.name} uid={replyTo.uid} has={replyTo.has_avatar}/><b title={"@"+replyTo.username}>{replyTo.name}</b><span>{replyTo.body?snippet(replyTo.body):replyTo.filename??"Attachment"}</span></>:<span>Replying to an earlier message</span>}
      </button>:null}
      {!joined&&<Avatar name={m.name} uid={m.uid} has={m.has_avatar}/>}
      <div className="message-content">
        {!joined&&<div className="byline"><strong title={"@"+m.username}>{m.name}</strong><time dateTime={new Date(m.created).toISOString()} title={new Date(m.created).toLocaleString()}>{clock(m.created)}</time>{!!m.edited&&<span className="edited">(edited)</span>}{!!m.pinned&&<span className="tag">Pinned</span>}<span className="handle">@{m.username}</span></div>}
        {m.body&&<div className="text-body">{markdown(m.body)}{!!m.edited&&joined&&<small> (edited)</small>}</div>}
        {m.attachment&&<Attachment message={m}/>}
        {reacts.length>0&&<div className="reaction-row">{reacts.map(([emoji,count])=><button key={emoji} type="button" aria-pressed={mine.has(emoji)} aria-label={emoji+" "+count+(mine.has(emoji)?", you reacted":"")} onClick={()=>void actions.action("react",m,{emoji,remove:mine.has(emoji)})}>{emoji} {count}</button>)}</div>}
      </div>
      <div className="message-tools" role="toolbar" aria-label="Message actions">
        <button type="button" aria-label="Add reaction" title="Add reaction" onClick={()=>actions.pick(m)}><SmilePlus size={17}/></button>
        <button type="button" aria-label="Reply" title="Reply" onClick={()=>actions.reply(m)}><Reply size={17}/></button>
        {mineMessage&&m.body&&<button type="button" aria-label="Edit" title="Edit" onClick={()=>actions.edit(m)}><Pencil size={16}/></button>}
        <button type="button" aria-label="More actions" title="More" aria-haspopup="menu" aria-expanded={menuOpen} onClick={()=>actions.menu(menuOpen?null:m.id)}><Ellipsis size={17}/></button>
      </div>
      {menuOpen&&<div className="message-menu" role="menu" aria-label={"Actions for message by "+m.name} onKeyDown={event=>{if(event.key==="Escape"){event.stopPropagation();close();}}}>
        <button role="menuitem" autoFocus onClick={()=>{close();actions.pick(m);}}><SmilePlus size={16}/>Add reaction</button>
        <button role="menuitem" onClick={()=>{close();actions.reply(m);}}><Reply size={16}/>Reply</button>
        {mineMessage&&m.body&&<button role="menuitem" onClick={()=>{close();actions.edit(m);}}><Pencil size={16}/>Edit message</button>}
        {m.body&&<button role="menuitem" onClick={()=>{close();void navigator.clipboard?.writeText(m.body).catch(()=>{});}}><Copy size={16}/>Copy text</button>}
        {(mineMessage||admin)&&<button role="menuitem" onClick={()=>{close();void actions.action("pin",m);}}><Pin size={16}/>{m.pinned?"Unpin":"Pin"}</button>}
        {!mineMessage&&<button role="menuitem" onClick={()=>{close();actions.report(m);}}><Flag size={16}/>Report</button>}
        {(mineMessage||admin)&&<button role="menuitem" className="danger" onClick={()=>{close();actions.remove(m);}}><Trash2 size={16}/>Delete message</button>}
      </div>}
    </article>
  </div>;
});
function IconButton({label,children,onClick,active=false,disabled=false,danger=false}:{label:string;children:ReactNode;onClick:()=>void;active?:boolean;disabled?:boolean;danger?:boolean}){
  return <button type="button" className={"icon-button"+(active?" active":"")+(danger?" danger":"")} title={label} aria-label={label} aria-pressed={active} onClick={onClick} disabled={disabled}>{children}</button>;
}
function inline(text:string) {
  return text.split(/(\*\*[^*\n]+\*\*|_[^_\n]+_|\x60[^\x60\n]+\x60|@[a-z0-9_]+)/gi).map((s,i)=>s.startsWith("**")?<strong key={i}>{s.slice(2,-2)}</strong>:s.startsWith("_")&&s.endsWith("_")?<em key={i}>{s.slice(1,-1)}</em>:s.startsWith("\x60")?<code key={i}>{s.slice(1,-1)}</code>:s.startsWith("@")?<span key={i} className="mention">{s}</span>:s);
}
function markdown(text:string){
  const parts=text.split(/\x60\x60\x60/);
  return parts.map((part,i)=>{
    // Newlines touching a code fence belong to the fence, not to the text around it.
    if(i%2===0){
      let prose=part;
      if(i>0)prose=prose.replace(/^\r?\n/,"");
      if(i<parts.length-1)prose=prose.replace(/\r?\n$/,"");
      return prose&&<span key={i}>{inline(prose)}</span>;
    }
    const start=part.indexOf("\n");
    const body=(start<0?part:part.slice(start+1)).replace(/\r?\n$/,"");
    return <pre key={i}><code>{body.split(/(".*?"|'.*?'|\/\/[^\n]*|\b(?:const|let|function|return|if|else|class|import|export|async|await|true|false|null|def|print)\b|\b\d+\b)/g).map((s,j)=>j%2?<span className="syntax" key={j}>{s}</span>:s)}</code></pre>;
  });
}
function Media({feed,deaf,output,volume,video}:{feed:Feed;deaf:boolean;output:string;volume:number;video:boolean}){
  const element=useRef<HTMLMediaElement|null>(null);
  const routed=useRef<Route|null>(null);
  const level=useRef(volume);
  const [ready,setReady]=useState(0);
  // Attach the stream only when it changes: reassigning srcObject restarts playback on every slider move.
  useEffect(()=>{
    const el=element.current;
    if(!el)return;
    el.srcObject=feed.stream;
    void el.play().catch(()=>{});
  },[feed.stream]);
  useEffect(()=>{
    const el=element.current;
    if(output && el && "setSinkId" in el)void (el as HTMLMediaElement & {setSinkId(id:string):Promise<void>}).setSinkId(output).catch(()=>{});
  },[output]);
  // Hearing someone goes through a gain node (see user-volume.ts); the element only plays it itself where Web Audio can't.
  useEffect(()=>{
    const el=element.current;
    if(!el)return;
    const r=deaf?null:route(feed.stream,output,()=>setReady(n=>n+1));
    routed.current=r;
    if(r)setGain(r,level.current);
    el.muted=deaf||!!r; el.volume=r?1:Math.min(1,level.current);
    return ()=>{r?.release();routed.current=null;};
  },[feed.stream,output,deaf,ready]);
  useEffect(()=>{
    level.current=volume;
    const el=element.current;
    if(routed.current)setGain(routed.current,volume);
    else if(el)el.volume=Math.min(1,volume);
  },[volume]);
  return video?<video autoPlay playsInline muted ref={node=>{element.current=node;}}/>:<audio autoPlay muted ref={node=>{element.current=node;}}/>;
}
// Your own volume for one person (or their stream): 0–200%, remembered in this browser. The speaker icon mutes them for you only.
function VolumeControl({label,value,output,change}:{label:string;value:number;output:string;change:(v:number)=>void}){
  const last=useRef(value>0?value:1);
  const top=canBoost(output)?maxVolume:1;
  const percent=Math.round(value*100);
  return <span className="volume">
    <button type="button" className="volume-mute" aria-label={(value===0?"Unmute ":"Mute ")+label+" for you"} title={value===0?"Unmute for you":"Mute for you"} aria-pressed={value===0}
      onClick={()=>{if(value===0)change(last.current);else{last.current=value;change(0);}}}>{value===0?<VolumeX size={15}/>:<Volume2 size={15}/>}</button>
    <input type="range" min={0} max={top} step={0.05} value={Math.min(value,top)} aria-label={label} aria-valuetext={percent+"%"}
      onChange={e=>{const v=+e.target.value;if(v>0)last.current=v;change(v);}} onDoubleClick={()=>change(1)}/>
    <output className="volume-value">{percent}%</output>
  </span>;
}
// One person or screen on the call stage. Video fills the tile; name, actions and fullscreen sit on top.
function StageTile({name,uid,avatar=false,speaking=false,screen=false,live=false,stream,mirror=false,deaf,output,volume,actions}:{name:string;uid:string;avatar?:boolean;speaking?:boolean;screen?:boolean;live?:boolean;stream?:MediaStream;mirror?:boolean;deaf:boolean;output:string;volume:number;actions?:ReactNode}){
  const tile=useRef<HTMLDivElement>(null);
  return <div ref={tile} className={"stage-tile"+(screen?" screen":"")+(stream?" has-video":"")+(speaking?" speaking":"")+(mirror?" mirror":"")}>
    {stream?<Media feed={{key:uid,peer:uid,kind:screen?"screen":"cam",stream}} deaf={deaf} output={output} volume={volume} video/>:<Avatar name={name.replace(/ \(you\)$/,"")} uid={uid} has={avatar}/>}
    <div className="tile-label">{screen?<MonitorUp size={14}/>:null}<span>{name}</span>{live&&<b className="live-tag">LIVE</b>}</div>
    <div className="tile-actions">{actions}
      {stream&&<button type="button" aria-label={"Full screen: "+name} title="Full screen" onClick={()=>{if(document.fullscreenElement)void document.exitFullscreen();else void tile.current?.requestFullscreen().catch(()=>{});}}><Expand size={15}/></button>}
    </div>
  </div>;
}
function Diagnostics({call,latency,errors}:{call:Call|null;latency:number|null;errors:{time:number;text:string}[]}){
  const [telemetry,setTelemetry]=useState<{call:Call;records:Metrics[];samples:DiagnosticSample[]}>();
  const records=telemetry?.call===call?telemetry.records:[];
  const samples=telemetry?.call===call?telemetry.samples:[];
  const [probe,setProbe]=useState("Unchecked");
  const [devices,setDevices]=useState<MediaDeviceInfo[]>([]);
  useEffect(()=>{
    void navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(()=>{});
  },[]);
  useEffect(()=>{
    if(!call)return;
    let live=true;
    let timer:ReturnType<typeof setTimeout>;
    const sample=async()=>{
      const records=await call.metrics().catch(()=>[]);
      if(!live)return;
      const reading=diagnosticSample(Date.now(),records);
      setTelemetry(previous=>({call,records,samples:[
        ...(previous?.call===call?previous.samples.slice(-39):[]),reading,
      ]}));
      timer=setTimeout(sample,1000);
    };
    void sample();
    return ()=>{live=false;clearTimeout(timer);};
  },[call]);
  function testSocket(){
    setProbe("Testing");
    const protocol=location.protocol==="https:"?"wss:":"ws:";
    const socket=new WebSocket(protocol+"//"+location.host+"/api/ra/transport");
    const timer=setTimeout(()=>{socket.close();setProbe("No upgrade response");},4000);
    socket.onmessage=()=>{clearTimeout(timer);setProbe("Authenticated upgrade succeeded");};
    socket.onerror=()=>{clearTimeout(timer);setProbe("Authenticated upgrade failed");};
    socket.onclose=()=>clearTimeout(timer);
  }
  const value=(n:number|undefined,unit="")=>n===undefined?"Unavailable":n.toLocaleString(undefined,{maximumFractionDigits:1})+unit;
  const capture=call?.local.get("screen")?.getVideoTracks()[0]?.getSettings();
  return <div className="diagnostics">
    <div className="metric-summary"><span>Transport <b>HTTPS polling</b></span><span>Signaling round trip <b>{value(latency??undefined," ms")}</b></span><span>WebSocket <b>{probe}</b></span><button onClick={testSocket}>Test upgrade</button></div>
    <WebRtcInternals/>
    <p>Screen capture {typeof navigator.mediaDevices?.getDisplayMedia==="function"?"available":"unavailable"} · Microphone {devices.some(d=>d.kind==="audioinput")?"detected":"unavailable"} · Camera {devices.some(d=>d.kind==="videoinput")?"detected":"unavailable"}</p>
    <p>Local codecs {typeof RTCRtpSender==="undefined"?"Unavailable":codecs().join(", ")||"Unavailable"}</p>
    <p>Screen capture {capture?.width&&capture.height?capture.width+" × "+capture.height+" · "+value(capture.frameRate," FPS"):"Unavailable"}</p>
    <DiagnosticCharts key={call?.peer} samples={samples}/>
    {!records.length&&<p>Join a voice room with another participant to measure a peer connection.</p>}
    {records.map(r=><div className="metric-card" key={JSON.stringify([r.peer,r.stream])}><h3>{r.name} · {r.direction}</h3><dl>{[
      ["Connection",r.connection],["ICE",r.ice],["ICE gathering",r.gathering],["Path",r.route??"Unavailable"],["Codec",r.codec??"Unavailable"],
      ["Resolution",r.resolution??"Unavailable"],["Rate",value(r.fps," FPS")],
      ...(r.direction==="Sending video"?[["Capture rate",value(r.captureFps," FPS")],["Encoder",r.encoder??"Unavailable"]]:[]),
      ...(r.direction==="Receiving video"?[["Decoder",r.decoder??"Unavailable"]]:[]),["Actual bitrate",value(r.bitrate," Kbps")],
      ...(r.direction==="Sending video"?[["Encoder target",value(r.targetBitrate," Kbps")]]:[]),
      ["Round trip",value(r.rtt," ms")],
      ["Packet loss",value(r.loss,"%")],["Jitter",value(r.jitter," ms")],["Frames dropped",value(r.dropped)],["Frames encoded",value(r.encoded)],["Frames decoded",value(r.decoded)],
      ["Encode time per frame",value(r.encodeMs," ms")],["Decode time per frame",value(r.decodeMs," ms")],["Available outgoing",value(r.available," Kbps")],["Quality limit",r.limited??"Unavailable"],
    ].map(([label,n])=><div key={label}><dt>{label}</dt><dd>{n}</dd></div>)}</dl></div>)}
    {errors.length>0&&<details className="metric-card"><summary>Recent errors ({errors.length})</summary><ul className="error-log">{errors.map(e=><li key={e.time+e.text}><time>{new Date(e.time).toLocaleTimeString()}</time> {e.text}</li>)}</ul></details>}
    <p>A relay requires configured TURN credentials. If peers stay disconnected, try a different network or ask an administrator to check relay configuration.</p>
  </div>;
}
const settingsTabs=[["profile","Profile"],["voice","Voice and video"],["screen","Screen share"],["app","Notifications"]] as const;
function UserSettings({person,prefs,limit,save,report,signOut}:{person:Person;prefs:Preferences;limit:number;save:()=>void;report:(x:string)=>void;signOut:()=>void}){
  const [tab,setTab]=useState<(typeof settingsTabs)[number][0]>("profile");
  const [picture,setPicture]=useState("");
  const [uploading,setUploading]=useState(false);
  const pictureInput=useRef<HTMLInputElement>(null);
  const [devices,setDevices]=useState<MediaDeviceInfo[]>([]);
  const [name,setName]=useState(person.name);
  const [status,setStatus]=useState(person.status);
  const [form,setForm]=useState(prefs);
  const [test,setTest]=useState("");
  const meterTimer=useRef<number|undefined>(undefined);
  const testing=useRef(false);
  const testResource=useRef<{stream:MediaStream;context:AudioContext;processor:VoiceProcessor;playback:HTMLAudioElement}|null>(null);
  const list=()=>navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(()=>{});
  const endTest=()=>{
    window.clearInterval(meterTimer.current);
    const r=testResource.current;testResource.current=null;testing.current=false;
    if(!r)return;
    r.playback.pause();r.playback.srcObject=null;r.processor.close();r.stream.getTracks().forEach(t=>t.stop());void r.context.close().catch(()=>{});
  };
  useEffect(()=>{void list(); return endTest;},[]);
  const change=<K extends keyof Preferences>(key:K,value:Preferences[K])=>setForm(f=>({...f,[key]:value}));
  const device=(label:string,key:"input"|"output"|"camera",kind:MediaDeviceKind)=><label>{label}<select value={form[key]} onChange={e=>change(key,e.target.value)}><option value="">System default</option>{devices.filter(d=>d.kind===kind&&d.deviceId).map((d,i)=><option key={d.deviceId} value={d.deviceId}>{d.label||label+" "+(i+1)}</option>)}</select></label>;
  async function testMic(){
    if(testing.current)return;
    testing.current=true;
    try{
      const stream=await navigator.mediaDevices.getUserMedia(microphoneConstraints(form));
      if(!testing.current){stream.getTracks().forEach(t=>t.stop());return;}
      // The test runs the same processing as a call and plays it back, so you hear what others hear.
      const processor=await processVoice(stream,form);
      if(!testing.current){processor.close();stream.getTracks().forEach(t=>t.stop());return;}
      const context=new AudioContext();
      const playback=new Audio();
      testResource.current={stream,context,processor,playback};
      if(processor.fallback)report(processor.fallback);
      playback.srcObject=processor.stream;
      if(form.output && "setSinkId" in playback)void (playback as HTMLAudioElement & {setSinkId(id:string):Promise<void>}).setSinkId(form.output).catch(()=>{});
      void playback.play().catch(()=>{});
      const analyser=context.createAnalyser();
      context.createMediaStreamSource(processor.stream).connect(analyser);
      const data=new Uint8Array(analyser.fftSize);
      const started=Date.now();
      meterTimer.current=window.setInterval(()=>{
        analyser.getByteTimeDomainData(data);
        const amplitude=Math.max(...data.map(n=>Math.abs(n-128)));
        setTest("Playing back what others hear (use headphones) · level "+Math.round(100*amplitude/128)+"%");
        if(Date.now()-started>10000){endTest();setTest("Test finished.");}
      },150);
      void list();
    }catch(e){endTest();report((e as Error).message);}
  }
  const dirty=name!==person.name||status!==person.status||JSON.stringify(form)!==JSON.stringify(prefs);
  useEffect(()=>()=>{if(picture)URL.revokeObjectURL(picture);},[picture]);
  return <form className="settings-form settings-tabs" onInvalidCapture={()=>setTab("profile")} onSubmit={async(e)=>{
    e.preventDefault();
    try{await request("profile",{name,status,prefs:form});save();}catch(e){report((e as Error).message);}
  }}>
    <nav className="tabs" role="tablist" aria-label="Settings sections">{settingsTabs.map(([id,label])=><button type="button" role="tab" key={id} aria-selected={tab===id} className={tab===id?"active":""} onClick={()=>setTab(id)}>{label}</button>)}</nav>
    <fieldset hidden={tab!=="profile"}><legend>Profile</legend><label>Display name<input required maxLength={40} value={name} onChange={e=>setName(e.target.value)}/></label>
      <label>Status<select value={status} onChange={e=>setStatus(e.target.value)}>{statuses.map(([s,label])=><option value={s} key={s}>{label}</option>)}</select></label>
      <div className="avatar-picker"><span className="avatar-large">{picture?<img src={picture} alt=""/>:<Avatar name={name||person.name} uid={person.id} has={person.avatar}/>}</span>
        <div><b>Profile picture</b><small>PNG, JPEG, WebP or GIF.</small></div>
        <button type="button" disabled={uploading} onClick={()=>pictureInput.current?.click()}>{uploading?"Uploading…":"Change picture"}</button>
        <input ref={pictureInput} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={async(e)=>{
          const file=e.target.files?.[0];e.target.value="";if(!file)return;const body=new FormData();body.set("file",file);
          setUploading(true);
          try{await request("avatar",body);setPicture(URL.createObjectURL(file));report("Profile picture updated.");}catch(e){report((e as Error).message);}
          finally{setUploading(false);}
        }}/>
      </div>
      <button type="button" className="signout" onClick={signOut}>Sign out</button>
    </fieldset>
    <fieldset hidden={tab!=="voice"}><legend>Audio and camera</legend>{device("Microphone","input","audioinput")}{device("Speaker","output","audiooutput")}{device("Camera","camera","videoinput")}
      <label>Speaking sensitivity<input type="range" min={1} max={30} value={form.sensitivity} onChange={e=>change("sensitivity",+e.target.value)}/></label>
      <label>Noise suppression<select value={suppressionMode(form)} onChange={e=>{const mode=e.target.value as NonNullable<Preferences["suppression"]>;setForm(f=>({...f,suppression:mode,noise:mode!=="off"}));}}>{suppressionModes.map(m=><option key={m.value} value={m.value}>{m.label}</option>)}</select></label>
      <div className="toggle-grid">{([["echo","Echo cancellation"],["gain","Automatic gain"],["ptt","Push to talk"]] as const).map(([k,label])=><label key={k}><input type="checkbox" checked={form[k]} onChange={e=>change(k,e.target.checked)}/>{label}</label>)}{(suppressionMode(form)==="strong"||suppressionMode(form)==="standard")&&<label><input type="checkbox" checked={form.voiceGate!==false} onChange={e=>change("voiceGate",e.target.checked)}/>Voice gate</label>}</div>
      {form.ptt&&<label>Push-to-talk key<input value={form.key} readOnly onKeyDown={e=>{if(e.code!=="Tab"){e.preventDefault();change("key",e.code);}}}/></label>}
      <div className="inline"><button type="button" onClick={()=>{if(testing.current){endTest();setTest("");}else void testMic();}}>{test.startsWith("Playing")?"Stop test":"Test microphone"}</button><span>{test}</span></div>
    </fieldset>
    <fieldset hidden={tab!=="screen"}><legend>Screen sharing</legend>
      <label>Quality profile<select value={form.screenQuality==="custom"||form.screenQuality==="maximum"?form.screenQuality:"smooth"} onChange={e=>change("screenQuality",e.target.value==="custom"||e.target.value==="maximum"?e.target.value:"smooth")}><option value="smooth">Smooth · 1080p up to 144 FPS</option><option value="maximum">Sharpest · native resolution</option><option value="custom">Custom</option></select></label>
      {form.screenQuality==="custom"?<>
        <label>Capture resolution and frame rate<select value={form.resolution} onChange={e=>change("resolution",e.target.value)}>{qualities.map(q=><option key={q} value={q}>{q.replace("2160","4K").replace("x"," · ")+" FPS"}</option>)}</select></label>
        <label>Bitrate ceiling (Kbps)<input aria-describedby="bitrate-help" type="number" min={0} max={limit||4294967} placeholder="No personal cap" value={form.bitrate||""} onChange={e=>change("bitrate",+e.target.value)}/></label>
        <small id="bitrate-help">Leave blank for no personal bitrate cap.</small>
        <label>Codec preference<select value={form.codec} onChange={e=>change("codec",e.target.value)}><option value="auto">Automatic</option>{typeof RTCRtpSender!=="undefined"&&codecs().map(c=><option key={c}>{c}</option>)}</select></label>
        <label>Streaming mode<select value={form.mode} onChange={e=>change("mode",e.target.value)}><option value="motion">Gaming · motion clarity</option><option value="detail">Desktop · text clarity</option></select></label>
      </>:form.screenQuality==="maximum"?<p>Captures at your monitor’s native resolution and refresh rate and keeps text sharp. Under load it drops frames rather than resolution.</p>
      :<p>Captures at 1080p and up to 144 FPS, prefers a hardware encoder, and keeps the frame rate steady. Under load it lowers resolution rather than frames. Each viewer needs its own upload of about 25 Mbps.</p>}
      {limit>0&&<small>Community bitrate ceiling {limit.toLocaleString()} Kbps.</small>}
    </fieldset>
    <fieldset hidden={tab!=="app"}><legend>Appearance and notifications</legend><label className="inline"><input type="checkbox" checked={form.compact} onChange={e=>change("compact",e.target.checked)}/>Compact messages</label>
      <label className="inline"><input type="checkbox" checked={form.notifications} onChange={async e=>{const want=e.target.checked;change("notifications",want&&"Notification" in window&&(await Notification.requestPermission())==="granted");}}/>Browser mention notifications</label>
      <label className="inline"><input type="checkbox" checked={form.voiceSounds!==false} onChange={e=>change("voiceSounds",e.target.checked)}/>Voice join and leave sounds</label>
      <label className="inline"><input type="checkbox" checked={!!form.hideIp} onChange={e=>change("hideIp",e.target.checked)}/>Hide my IP address in calls (routes calls through the relay, which can add a little delay)</label>
    </fieldset>
    <footer className="save-bar"><span>{dirty?"You have unsaved changes.":""}</span><a href="/privacy">Privacy</a><button className="primary" disabled={!dirty}>Save changes</button></footer>
  </form>;
}
export default function Community(){
  const [auth,setAuth]=useState<Auth|null>(null);
  const [space,setSpace]=useState<Workspace|null>(null);
  const [server,setServer]=useState("community");
  const [selected,setSelected]=useState("");
  const [messages,setMessages]=useState<Message[]>([]);
  const [typing,setTyping]=useState<string[]>([]);
  const [drafts,setDrafts]=useState<Record<string,string>>({});
  const [gifDraft,setGifDraft]=useState<{channel:string;file:File}|null>(null);
  const [staged,setStaged]=useState<{channel:string;file:File;key:string}[]>([]);
  const [progress,setProgress]=useState<{name:string;fraction:number}|null>(null);
  const [dragging,setDragging]=useState(false);
  const [unreadFrom,setUnreadFrom]=useState<{channel:string;id:number}|null>(null);
  const [sending,setSending]=useState(false);
  const [picker,setPicker]=useState<"emoji"|"gif"|Message|null>(null);
  const [sidechat,setSidechat]=useState("");
  const [edit,setEdit]=useState<Message|null>(null);
  const [reply,setReply]=useState<Message|null>(null);
  const [find,setFind]=useState("");
  const [pinned,setPinned]=useState(false);
  const [modal,setModal]=useState("");
  const modalRef=useRef(modal);
  useEffect(()=>{modalRef.current=modal;},[modal]);
  const [toast,setToast]=useState("");
  const wide=useMedia("(min-width: 861px)");
  const [membersPref,setMembersPref]=useState(true);
  const [membersSheet,setMembersSheet]=useState(false);
  // Wide screens keep the member list docked; narrow screens open it as a panel over the chat.
  const members=wide?membersPref:membersSheet;
  const [mobile,setMobile]=useState(false);
  const [menu,setMenu]=useState<number|null>(null);
  const [errors,setErrors]=useState<{time:number;text:string}[]>([]);
  const [call,setCall]=useState<Call|null>(null);
  const [latency,setLatency]=useState<number|null>(null);
  const [,refreshCall]=useState(0);
  const [rooms,setRooms]=useState<RoomMember[]>([]);
  const roomsAt=useRef(0);
  const cueState=useRef<{call:Call|null;uids:Set<string>|null}>({call:null,uids:null});
  const [volumes,setVolumes]=useState<Record<string,number>>(()=>typeof window==="undefined"?{}:loadVolumes());
  const [screenPreview,setScreenPreview]=useState(()=>typeof window==="undefined"||loadScreenPreview());
  const changeVolume=(key:string,value:number)=>setVolumes(v=>setVolume(v,key,value));
  const previewScreen=(on:boolean)=>{saveScreenPreview(on);setScreenPreview(on);};
  const [stage,setStage]=useState(false);
  const [speaker,setSpeaker]=useState(false);
  const [dmUsers,setDmUsers]=useState<string[]>([]);
  const [hasMore,setHasMore]=useState(true);
  const [ready,setReady]=useState("");
  const feed=useRef<HTMLDivElement>(null);
  const feedInner=useRef<HTMLDivElement>(null);
  const [awayFrom,setAwayFrom]=useState<number|null>(null);
  const spaceRef=useRef<Workspace|null>(null);
  const draftInput=useRef<HTMLTextAreaElement>(null);
  const upload=useRef<HTMLInputElement>(null);
  const gifUpload=useRef<HTMLInputElement>(null);
  const cursor=useRef(0);
  const lastTyping=useRef(0);
  const stick=useRef(true);
  const rowHandlers=useRef<Omit<RowActions,"menu">>(null as unknown as Omit<RowActions,"menu">);
  const [rowActions]=useState<RowActions>(()=>({
    action:(kind,m,extra)=>rowHandlers.current.action(kind,m,extra),
    reply:m=>rowHandlers.current.reply(m),
    pick:m=>rowHandlers.current.pick(m),
    edit:m=>rowHandlers.current.edit(m),
    menu:id=>setMenu(id),
    jump:id=>rowHandlers.current.jump(id),
    remove:m=>rowHandlers.current.remove(m),
    report:m=>rowHandlers.current.report(m),
  }));
  const person=auth?.user;
  const channel=space?.channels.find(c=>c.id===selected);
  const mainStage=stage||channel?.kind==="voice";
  const voiceRoom=space?.channels.find(c=>c.id===(call?.channel??selected)&&c.kind==="voice");
  const sidechatOpen=!!(mainStage&&voiceRoom&&sidechat===voiceRoom.id);
  const chatChannel=mainStage?(sidechatOpen?voiceRoom:undefined):channel;
  const chatId=chatChannel?.id??"";
  const draft=drafts[chatId]??"";
  const gif=gifDraft?.channel===chatId?gifDraft.file:null;
  const files=staged.filter(s=>s.channel===chatId);
  const setDraft=(text:string)=>setDrafts(previous=>({...previous,[chatId]:text}));
  const prefs={...defaults,...space?.prefs};
  const limit=Number(space?.settings.find(v=>v.key==="bitrate")?.value??0);
  const report=useCallback((message:string)=>{
    const text=friendlyError(message);
    if(text!==message)setErrors(list=>[...list.slice(-19),{time:Date.now(),text:message}]);
    setToast(text);
  },[]);
  const [voice]=useState(()=>new VoiceSession(setCall,()=>refreshCall(n=>n+1),report));
  const refreshAuth=useCallback(()=>request<Auth>("session").then(setAuth).catch(e=>setToast(e.message)),[]);
  const refresh=useCallback(()=>request<Workspace>("workspace").then(setSpace),[]);
  useEffect(()=>{void refreshAuth();},[refreshAuth]);
  useEffect(()=>{
    if(!auth?.active){voice.disconnect();return;}
    void refresh().catch(e=>report(e.message));
    const timer=setInterval(()=>void refresh().catch(()=>void refreshAuth()),10000);
    return ()=>clearInterval(timer);
  },[auth?.active,refresh,report,refreshAuth,voice]);
  useEffect(()=>{
    if(!space)return;
    if(space.channels.some(c=>c.id===selected))return;
    const first=space.channels.find(c=>c.server===server&&c.kind==="text")??space.channels.find(c=>c.kind==="text");
    if(first){setServer(first.server??server);setSelected(first.id);}
  },[space,selected,server]);
  const load=useCallback(async(id:string,search:string,pins:boolean)=>{
    const params=new URLSearchParams({channel:id});
    if(search)params.set("search",search);
    if(pins)params.set("pinned","1");
    return request<History>("history?"+params);
  },[]);
  useEffect(()=>{
    setReady("");setMessages([]);setReply(null);setEdit(null);setTyping([]);stick.current=true;lastTyping.current=0;
    if(!chatId)return;
    let active=true;
    const timer=setTimeout(()=>void load(chatId,find,pinned).then(data=>{
      if(!active)return;
      // Remember where unread messages started, so the divider stays after they're marked read.
      const unread=!find&&!pinned?spaceRef.current?.channels.find(c=>c.id===chatId)?.unread??0:0;
      setUnreadFrom(unread>0&&unread<data.messages.length?{channel:chatId,id:data.messages[data.messages.length-unread].id}:null);
      cursor.current=data.cursor;setMessages(data.messages);setHasMore(data.messages.length===50 && !find && !pinned);setReady(chatId);
    }).catch(e=>report(e.message)),find?220:0);
    return ()=>{active=false;clearTimeout(timer);};
  },[chatId,find,pinned,load,report]);
  useEffect(()=>{setPicker(null);},[chatId]);
  useEffect(()=>{
    if(!auth?.active)return;
    let active=true,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      const params=new URLSearchParams();
      const liveCall=voice.call;
      if(ready===chatId&&chatId&&!find&&!pinned){params.set("channel",chatId);params.set("after",String(cursor.current));}
      if(liveCall){params.set("peer",liveCall.peer);params.set("signal",String(liveCall.signal));}
      const wantRooms=Date.now()-roomsAt.current>1400;
      if(wantRooms){params.set("rooms","1");roomsAt.current=Date.now();}
      const began=performance.now();
      try{
        const result=await request<Update>("poll?"+params);
        if(!active)return;
        // Only Diagnostics shows latency, so other polls skip the re-render.
        if(modalRef.current==="diagnostics")setLatency(performance.now()-began);
        const nextRooms=result.rooms;
        if(nextRooms)setRooms(previous=>JSON.stringify(previous)===JSON.stringify(nextRooms)?previous:nextRooms);
        if(params.has("channel")){
          cursor.current=result.cursor??cursor.current;
          {const names=result.typing?.map(t=>t.name)??[];setTyping(previous=>previous.join("\n")===names.join("\n")?previous:names);}
          if(result.messages?.length){
            const changed=result.messages;
            setMessages(previous=>{
              const rows=new Map(previous.map(m=>[m.id,m]));
              for(const message of changed){
                if(message.deleted)rows.delete(message.id);
                else if(rows.has(message.id)||message.id>(previous.at(-1)?.id??0))rows.set(message.id,message);
              }
              return [...rows.values()].sort((a,b)=>a.id-b.id).slice(-350);
            });
            if(prefs.notifications&&document.hidden&&typeof Notification!=="undefined"&&Notification.permission==="granted"){
              for(const m of changed)if(!m.deleted&&!m.edited&&m.uid!==person?.id&&m.body.includes("@"+person?.username))new Notification(chatChannel?.name??"RaRRcord",{body:m.name+" mentioned you",tag:"ra-"+m.id});
            }
          }
        }
        if(liveCall&&voice.call===liveCall){
          if(result.voice===null){voice.ended(liveCall);report("Your voice room connection ended.");}
          else if(result.voice)await liveCall.update(result.voice,result.signals??[]);
        }
      }catch{
        if(active)void refreshAuth();
      }finally{if(active)timer=setTimeout(poll,voice.call?750:document.hidden?4500:1500);}
    };
    void poll();
    return ()=>{active=false;clearTimeout(timer);};
  },[auth?.active,ready,chatId,find,pinned,chatChannel?.name,prefs.notifications,person?.id,person?.username,refreshAuth,report,call,voice]);
  useEffect(()=>()=>voice.disconnect(),[voice]);
  const callUids=call?[...new Set(call.participants.map(p=>p.uid))].sort().join(","):"";
  useEffect(()=>{
    const state=cueState.current;
    const output=prefs.output,enabled=prefs.voiceSounds!==false;
    if(call!==state.call){
      // You joined, switched rooms or left.
      if(enabled&&(call||state.call))playVoiceCue(call?"join":"leave",output);
      cueState.current={call,uids:null};
      return;
    }
    if(!call||!callUids)return;
    const now=new Set(callUids.split(","));
    if(state.uids&&enabled&&!call.deaf){
      const me=person?.id;
      const joined=[...now].some(u=>u!==me&&!state.uids!.has(u));
      const left=[...state.uids].some(u=>u!==me&&!now.has(u));
      if(joined)playVoiceCue("join",output);
      else if(left)playVoiceCue("leave",output);
    }
    state.uids=now;
  },[call,callUids,person?.id,prefs.output,prefs.voiceSounds]);
  useEffect(()=>{spaceRef.current=space;},[space]);
  useEffect(()=>{
    // Keep the newest message in view when content grows after render, such as images and fonts loading.
    const inner=feedInner.current;
    if(!inner||typeof ResizeObserver==="undefined")return;
    const observer=new ResizeObserver(()=>{if(stick.current&&feed.current)feed.current.scrollTop=feed.current.scrollHeight;});
    observer.observe(inner);
    if(feed.current)observer.observe(feed.current);
    return ()=>observer.disconnect();
  },[chatId,mainStage,sidechatOpen]);
  useEffect(()=>{
    if(stick.current && feed.current)feed.current.scrollTop=feed.current.scrollHeight;
    const last=messages.at(-1);
    if(last && chatId && ready===chatId && !find && !pinned && !document.hidden)void request("read",{channel:chatId,id:last.id}).catch(()=>{});
  },[messages,chatId,ready,find,pinned]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(""),6500);return ()=>clearTimeout(timer);},[toast]);
  useEffect(()=>{
    if(menu===null)return;
    const away=(event:PointerEvent)=>{if(!(event.target as HTMLElement).closest(".message-menu,.message-tools"))setMenu(null);};
    const key=(event:KeyboardEvent)=>{if(event.key==="Escape")setMenu(null);};
    document.addEventListener("pointerdown",away);document.addEventListener("keydown",key);
    return ()=>{document.removeEventListener("pointerdown",away);document.removeEventListener("keydown",key);};
  },[menu]);
  useEffect(()=>{
    const key=(event:KeyboardEvent)=>{
      if((event.ctrlKey||event.metaKey)&&event.key.toLowerCase()==="k"){event.preventDefault();setModal(m=>m==="switch"?"":"switch");}
      else if(event.key==="Escape"&&!document.querySelector("dialog[open]")){setMobile(false);setMembersSheet(false);}
    };
    document.addEventListener("keydown",key);
    return ()=>document.removeEventListener("keydown",key);
  },[]);
  function choose(c:Channel){
    setMobile(false);setFind("");setPinned(false);setSelected(c.id);
    if(c.kind==="voice"){setStage(true);void join(c);}
    else setStage(false);
  }
  const join=(c:Channel)=>voice.join(c.id,prefs,limit);
  async function logout(){
    try{const {signOut}=await request<{signOut?:string}>("logout",{});voice.disconnect();location.assign(signOut??"/signout-with-chatgpt?return_to=%2F");}
    catch(e){report((e as Error).message);}
  }
  async function enroll(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    const data=new FormData(event.currentTarget);
    try{
      const result=await request<Auth>("enroll",Object.fromEntries(data.entries()));
      setAuth(result);
    }catch(e){report((e as Error).message);}
  }
  async function send(event:FormEvent){
    event.preventDefault();
    const text=draft.trim();
    if((!text&&!gif&&!files.length)||!chatChannel||sending)return;
    setSending(true);
    try{
      if(files.length&&!edit){
        // Files go first, each with a progress bar, then the text as its own message.
        for(const item of files){
          const data=new FormData();data.set("channel",chatId);data.set("file",item.file);
          setProgress({name:item.file.name,fraction:0});
          await uploadWithProgress(data,fraction=>setProgress({name:item.file.name,fraction}));
          setStaged(list=>list.filter(s=>s.key!==item.key));
        }
        setProgress(null);
        if(text)await request("message",{channel:chatId,text,action:"send",reply:reply?.id});
      }else if(gif&&!edit){
        const data=new FormData();
        data.set("channel",chatId);data.set("file",gif);data.set("gif","1");data.set("text",text);
        if(reply)data.set("reply",String(reply.id));
        await request("upload",data);
        setGifDraft(previous=>previous?.file===gif?null:previous);
      }else await request("message",{channel:chatId,text,action:edit?"edit":"send",id:edit?.id,reply:reply?.id});
      setDrafts(previous=>previous[chatId]===draft?{...previous,[chatId]:""}:previous);
      if(feed.current?.dataset.channel===chatId){
        stick.current=true;setEdit(null);setReply(null);draftInput.current?.focus();
        if(find||pinned){setFind("");setPinned(false);}
      }
    }catch(e){setProgress(null);report((e as Error).message);}
    finally{setSending(false);}
  }
  function stageFiles(list:File[]){
    if(edit){report("Finish editing before attaching files.");return;}
    const gifs=list.filter(f=>f.type==="image/gif"||/\.gif$/i.test(f.name));
    const rest=list.filter(f=>!gifs.includes(f));
    if(gifs[0]&&!rest.length&&list.length===1){selectGif(gifs[0]);return;}
    setStaged(previous=>[...previous,...list.map(file=>({channel:chatId,file,key:file.name+file.size+Math.random()}))].slice(-10));
    draftInput.current?.focus();
  }
  async function action(kind:string,m:Message,extra:object={}){
    try{await request("message",{channel:chatId,action:kind,id:m.id,...extra});}
    catch(e){report((e as Error).message);}
  }
  // Message rows get one stable set of handlers that call the latest ones, so unchanged rows skip re-rendering.
  useLayoutEffect(()=>{
    rowHandlers.current={
      action,
      reply:m=>{setReply(m);draftInput.current?.focus();},
      pick:m=>setPicker(m),
      edit:m=>{setPicker(null);setReply(null);setEdit(m);setDraft(m.body);draftInput.current?.focus();},
      jump:id=>{
        const target=document.getElementById("msg-"+id);
        if(!target){report("That message is further back than what's loaded. Use Load earlier messages to find it.");return;}
        target.scrollIntoView({block:"center",behavior:matchMedia("(prefers-reduced-motion: reduce)").matches?"auto":"smooth"});
        target.classList.remove("flash");void target.offsetWidth;target.classList.add("flash");
      },
      remove:async m=>{
        const answer=await confirmAction({title:"Delete message",body:"This removes the message for everyone. It can't be undone.",action:"Delete message",danger:true});
        if(answer.ok)void action("delete",m);
      },
      report:async m=>{
        const answer=await confirmAction({title:"Report message",body:"Administrators will see this message and your reason.",action:"Send report",reason:"Why are you reporting it?"});
        if(answer.ok&&answer.reason)void action("report",m,{reason:answer.reason});
      },
    };
  });
  function changeDraft(text:string){
    setDraft(text);
    if(Date.now()-lastTyping.current>3000){
      lastTyping.current=Date.now();
      void request("typing",{channel:chatId}).catch(()=>{});
    }
  }
  function insertEmoji(emoji:string){
    const input=draftInput.current;
    const start=input?.selectionStart??draft.length;
    const end=input?.selectionEnd??start;
    const text=draft.slice(0,start)+emoji+draft.slice(end);
    setPicker(null);
    if(text.length>8000){report("This message is already at the character limit.");return;}
    changeDraft(text);
    requestAnimationFrame(()=>{
      if(input&&input===draftInput.current){input.focus();input.setSelectionRange(start+emoji.length,start+emoji.length);}
    });
  }
  function selectGif(file:File){
    if(edit){report("Finish editing before adding a GIF.");return;}
    setGifDraft({channel:chatId,file});setPicker(null);draftInput.current?.focus();
  }
  function pasteGif(event:ClipboardEvent<HTMLElement>){
    const list=Array.from(event.clipboardData.files);
    if(!list.length)return;
    event.preventDefault();
    if(picker==="gif"){const file=list.find(file=>file.type==="image/gif"||/\.gif$/i.test(file.name));if(file)selectGif(file);return;}
    stageFiles(list);
  }
  async function earlier(){
    if(!messages[0])return;
    const current=chatId;
    const old=feed.current?.scrollHeight??0;
    try{
      const page=await request<History>("history?channel="+encodeURIComponent(current)+"&before="+messages[0].id);
      if(feed.current?.dataset.channel!==current)return;
      stick.current=false;
      setMessages(rows=>[...page.messages.filter(m=>!rows.some(x=>x.id===m.id)),...rows].slice(0,350));
      setHasMore(page.messages.length===50);
      requestAnimationFrame(()=>{if(feed.current)feed.current.scrollTop=feed.current.scrollHeight-old;});
    }catch(e){report((e as Error).message);}
  }
  if(!auth?.active){
    return <main className="entry"><section className="entry-card"><span className="brand-mark">R</span><h1>RaRRcord</h1>
      {!auth?<p>{toast||"Checking your ChatGPT session…"}</p>:!person?
        <><p>Set up your profile to request access to the community.</p><form className="settings-form" onSubmit={enroll}><label>Username<input name="username" required minLength={3} maxLength={24} pattern="[A-Za-z0-9_]+" autoComplete="username"/></label><label>Display name<input name="name" required maxLength={40}/></label><label>Invitation code (optional)<input name="invite" maxLength={64} autoComplete="off"/></label><button className="primary">Continue</button></form></>:
        person.state==="approved"?<><p>Continue to your RaRRcord session.</p><form onSubmit={enroll}><button className="primary">Continue</button></form></>:
        <><h2>{person.state==="pending"?"Approval pending":"Account unavailable"}</h2><p>{person.state==="pending"?"A community administrator needs to approve your request.":"Contact your community administrator to check your access."}</p><button onClick={refreshAuth}>Check status</button></>}
      {toast&&auth&&<div role="status" className="form-error">{toast}</div>}
      <div className="inline"><a href="/privacy">Privacy</a>{auth&&<button onClick={logout}>Sign out</button>}</div>
    </section></main>;
  }
  const channels=space?.channels.filter(c=>c.server===server || c.kind==="dm")??[];
  const groups=[...new Set(channels.map(c=>c.category||"Channels"))];
  const avatars=new Map(space?.people.map(p=>[p.id,!!p.avatar])??[]);
  const membersOf=(id:string):VoiceMember[]=>{
    // Your own room comes from the live call roster, which is fresher and knows who is speaking.
    if(call?.channel===id){
      const seen=new Set<string>();
      return call.participants.filter(p=>!seen.has(p.uid)&&seen.add(p.uid)).map(p=>({uid:p.uid,name:p.name,avatar:avatars.get(p.uid)??false,live:!!p.screen,cam:!!p.cam,speaking:call.speaking(p.peer)})).sort((a,b)=>a.name.localeCompare(b.name));
    }
    return rooms.filter(r=>r.channel===id).map(r=>({uid:r.uid,name:r.name,avatar:!!r.has_avatar,live:!!r.screen,cam:!!r.cam,speaking:false}));
  };
  const currentServer=space?.servers.find(s=>s.id===server);
  const callTitle=space?.channels.find(c=>c.id===call?.channel)?.name;
  const feeds=call?.feeds.filter(f=>f.kind!=="voice")??[];
  const screens=feeds.filter(f=>f.kind==="screen");
  // Focus view puts whoever is talking first, so they get the large tile when nobody is sharing.
  const stagePeople=call?(speaker?[...call.participants].sort((a,b)=>Number(call.speaking(b.peer))-Number(call.speaking(a.peer))):call.participants):[];
  const ownCam=call?.local.get("cam");
  const ownScreen=screenPreview?call?.local.get("screen"):undefined;
  // Volumes are saved per user, so a peer (one join of a call) is looked up to its user first.
  const uidOf=(peer:string)=>call?.participants.find(p=>p.peer===peer)?.uid??peer;
  const voiceVolume=(peer:string)=>volumes[uidOf(peer)]??1;
  const streamVolume=(peer:string)=>volumes[streamVolumeKey(uidOf(peer))]??1;
  const bounded=ready===chatId?messages.slice(-350):[];
  const byId=new Map(bounded.map(m=>[m.id,m]));
  const unseen=awayFrom===null?0:bounded.filter(m=>m.id>awayFrom&&m.uid!==person?.id).length;
  const sheetOpen=mobile||(!wide&&membersSheet);
  return <div className={"assembly "+(members?"with-members ":"")+(mobile?"mobile-nav ":"")+(prefs.compact?"compact":"")}>
    <nav className="rail" aria-label="Servers">
      <button className="mark" aria-label="RaRRcord home" onClick={()=>{const home=space?.servers[0]?.id??"community";setServer(home);setSelected(space?.channels.find(c=>c.server===home&&c.kind==="text")?.id??"");setStage(false);}}>R</button>
      <hr/>
      {space?.servers.map(s=><button className={"server-pill "+(s.id===server?"selected":"")} key={s.id} title={s.name} aria-label={s.name} onClick={()=>{
        setServer(s.id);setSelected(space.channels.find(c=>c.server===s.id&&c.kind==="text")?.id??"");setStage(false);
      }}>{s.icon||initials(s.name)}</button>)}
      {person?.role==="admin"&&<button className="server-pill add" aria-label="Manage servers" title="Manage servers" onClick={()=>setModal("admin")}><Plus size={20}/></button>}
      <div className="rail-bottom"><IconButton label="Diagnostics" onClick={()=>setModal("diagnostics")}><AudioLines size={19}/></IconButton><IconButton label="Help" onClick={()=>setModal("help")}><CircleHelp size={19}/></IconButton></div>
    </nav>
    <aside className="sidebar">
      <header className="community-header"><span className="community-tag">RARRCORD</span><h2>{currentServer?.name??"Community"}</h2></header>
      <div className="channel-list">
        {!space&&<div className="skeleton-list" aria-label="Loading channels">{[60,75,50,0,55,70].map((w,i)=>w?<span key={i} className="skeleton" style={{width:w+"%"}}/>:<br key={i}/>)}</div>}
        {groups.map(group=><details key={group} open><summary><ChevronDown size={14}/>{group}</summary>{channels.filter(c=>(c.category||"Channels")===group).map(c=><Fragment key={c.id}><button className={"channel "+(selected===c.id?"selected":"")} onClick={()=>choose(c)}>
          {c.kind==="voice"?<AudioLines size={17}/>:c.kind==="private"?<LockKeyhole size={15}/>:<Hash size={17}/>}<span>{c.name}</span>{c.unread>0&&chatId!==c.id&&<b className="badge">{c.unread>99?"99+":c.unread}</b>}{call?.channel===c.id&&<i className="voice-dot"/>}
        </button>{c.kind==="voice"&&<VoiceMembers members={membersOf(c.id)}/>}</Fragment>)}</details>)}
        <button className="channel dm-button" onClick={()=>{setDmUsers([]);setModal("dm");}}><Plus size={16}/><span>New direct message</span></button>
      </div>
      {call&&<div className="voice-status"><div><b><i className="voice-dot"/> Voice connected</b><span>{callTitle}</span></div>
        <span className="voice-actions">
          <IconButton label={call.local.has("screen")?"Stop sharing your screen":"Share your screen"} active={call.local.has("screen")} onClick={()=>void call.toggle("screen")}>{call.local.has("screen")?<MonitorOff size={18}/>:<MonitorUp size={18}/>}</IconButton>
          <IconButton label="Disconnect" onClick={()=>voice.disconnect()}><LogOut size={18}/></IconButton>
        </span></div>}
      <footer className="profile">
        {person&&<Avatar name={person.name} uid={person.id} has={person.avatar} status={person.status}/>}
        <div><b>{person?.name}</b><small>@{person?.username}</small></div>
        <IconButton label={!call?"Join a voice room to use your microphone":call.microphonePending?"Starting microphone":call.microphoneActive?"Mute microphone":call.local.has("voice")?"Unmute microphone":"Enable microphone"} active={!!call&&!call.microphoneActive} danger={!!call&&!call.microphoneActive} disabled={!call||call.microphonePending||call.deaf} onClick={()=>void call?.toggleMicrophone()}>{!call||call.microphoneActive?<Mic size={16}/>:<MicOff size={16}/>}</IconButton>
        <IconButton label={!call?"Join a voice room to deafen":call.deaf?"Undeafen":"Deafen"} active={!!call?.deaf} danger={!!call?.deaf} disabled={!call} onClick={()=>{if(call)call.setDeaf(!call.deaf);}}>{call?.deaf?<HeadphoneOff size={16}/>:<Headphones size={16}/>}</IconButton>
        <IconButton label="User settings" onClick={()=>setModal("settings")}><Settings size={18}/></IconButton>
      </footer>
    </aside>
    <main className="conversation">
      <header className="topbar">
        <span className="mobile-toggle"><IconButton label="Toggle navigation" active={mobile} onClick={()=>{setMembersSheet(false);setMobile(!mobile);}}><Menu size={20}/></IconButton></span>
        <div className="location-title">{mainStage?<AudioLines size={21}/>:<Hash size={22}/>}<h1>{mainStage?callTitle??channel?.name??"Voice room":channel?.name??"Community"}</h1></div>
        <span className="channel-description">{channel?.description}</span>
        <div className="top-actions">
          {call&&!mainStage&&<button className="subtle" onClick={()=>{setFind("");setPinned(false);setStage(true);}}>View call</button>}
          {mainStage&&voiceRoom&&<button type="button" className={"sidechat-toggle"+(sidechatOpen?" active":"")} aria-expanded={sidechatOpen} aria-controls={sidechatOpen?"voice-sidechat":undefined} onClick={()=>setSidechat(sidechatOpen?"":voiceRoom.id)}><MessageSquare size={17}/><span>Sidechat</span>{!sidechatOpen&&voiceRoom.unread>0&&<b className="badge">{Math.min(voiceRoom.unread,99)}{voiceRoom.unread>99?"+":""}</b>}</button>}
          {!mainStage&&<><label className="search"><Search size={16}/><input aria-label="Search messages" value={find} placeholder="Search messages" onChange={e=>setFind(e.target.value)}/></label><IconButton label="Pinned messages" active={pinned} onClick={()=>setPinned(!pinned)}><Pin size={19}/></IconButton></>}
          <IconButton label="Toggle member list" active={members} onClick={()=>{if(wide)setMembersPref(!membersPref);else{setMobile(false);setMembersSheet(!membersSheet);}}}><Users size={20}/></IconButton>
          {person?.role==="admin"&&<IconButton label="Administration" onClick={()=>setModal("admin")}><Shield size={19}/></IconButton>}
        </div>
      </header>
      <div className={"conversation-body"+(sidechatOpen?" with-sidechat":"")}>
      {mainStage&&<div className="stage">
        {call?<><div className="stage-head"><div><h2>{callTitle}</h2><p>{call.participants.length===1?"Just you so far":call.participants.length+" connected"}</p></div>
          {(screens.length>0||call.participants.length>2)&&<button type="button" className="view-toggle" aria-pressed={speaker} onClick={()=>setSpeaker(!speaker)}>{speaker?<><LayoutGrid size={16}/>Grid view</>:<><Maximize2 size={16}/>Focus view</>}</button>}</div>
          <div className={"stage-grid"+(speaker?" speaker":"")} data-count={Math.min(screens.length+(ownScreen?1:0)+call.participants.length,5)}>
            {ownScreen&&<StageTile key="own-screen" name="Your screen" uid={call.peer+"-screen"} screen live stream={ownScreen} deaf output={prefs.output} volume={0}
              actions={<button type="button" onClick={()=>previewScreen(false)}><EyeOff size={15}/>Hide preview</button>}/>}
            {screens.map(f=>{const who=call.participants.find(p=>p.peer===f.peer);return <StageTile key={f.key} name={(who?.name??"Someone")+"’s screen"} uid={who?.uid??f.peer} screen
              stream={f.stream} deaf={call.deaf} output={prefs.output} volume={streamVolume(f.peer)}
              actions={<><VolumeControl label={"Stream volume for "+(who?.name??"this screen")} value={streamVolume(f.peer)} output={prefs.output} change={v=>changeVolume(streamVolumeKey(uidOf(f.peer)),v)}/>
                <button type="button" onClick={()=>call.watch(f.peer,"screen",false)}><MonitorOff size={15}/>Stop watching</button></>}/>;})}
            {stagePeople.map(participant=>{
              const you=participant.peer===call.peer;
              const cam=you?ownCam:feeds.find(f=>f.peer===participant.peer&&f.kind==="cam")?.stream;
              return <StageTile key={participant.peer} name={participant.name+(you?" (you)":"")} uid={participant.uid} avatar={avatars.get(participant.uid)??false}
                speaking={call.speaking(participant.peer)} stream={cam} mirror={you} deaf={you||call.deaf} output={prefs.output} volume={voiceVolume(participant.peer)}
                live={!!participant.screen}
                actions={you?(participant.screen&&call.local.has("screen")&&!screenPreview?<button type="button" onClick={()=>previewScreen(true)}><Eye size={15}/>Show my screen</button>:null):<>
                  {participant.cam?<button type="button" onClick={()=>call.watch(participant.peer,"cam",!call.watching(participant.peer,"cam"))}>{call.watching(participant.peer,"cam")?<><VideoOff size={15}/>Hide camera</>:<><Video size={15}/>Show camera</>}</button>:null}
                  {participant.screen&&!call.watching(participant.peer,"screen")?<button type="button" onClick={()=>call.watch(participant.peer,"screen",true)}><MonitorUp size={15}/>Show screen</button>:null}
                  <VolumeControl label={"Volume for "+participant.name} value={voiceVolume(participant.peer)} output={prefs.output} change={v=>changeVolume(participant.uid,v)}/>
                </>}/>;
            })}
          </div>
          <div className="call-bar" role="toolbar" aria-label="Call controls">
            <button type="button" className={"call-button"+(call.microphoneActive?"":" off")} aria-label={call.microphonePending?"Starting microphone":call.microphoneActive?"Mute microphone":call.local.has("voice")?"Unmute microphone":"Turn on microphone"} title={call.microphoneActive?"Mute":"Unmute"} aria-pressed={!call.microphoneActive} disabled={call.microphonePending||(call.deaf&&!call.local.has("voice"))} onClick={()=>void call.toggle("voice")}>{call.microphoneActive?<Mic size={20}/>:<MicOff size={20}/>}</button>
            <button type="button" className={"call-button"+(call.deaf?" off":"")} aria-label={call.deaf?"Undeafen":"Deafen"} title={call.deaf?"Undeafen":"Deafen"} aria-pressed={call.deaf} onClick={()=>call.setDeaf(!call.deaf)}>{call.deaf?<HeadphoneOff size={20}/>:<Headphones size={20}/>}</button>
            <button type="button" className={"call-button"+(call.local.has("cam")?" on":"")} aria-label={call.local.has("cam")?"Turn off camera":"Turn on camera"} title={call.local.has("cam")?"Turn off camera":"Turn on camera"} aria-pressed={call.local.has("cam")} onClick={()=>void call.toggle("cam")}>{call.local.has("cam")?<Video size={20}/>:<VideoOff size={20}/>}</button>
            <button type="button" className={"call-button"+(call.local.has("screen")?" on":"")} aria-label={call.local.has("screen")?"Stop sharing your screen":"Share your screen"} title={call.local.has("screen")?"Stop sharing":"Share screen"} aria-pressed={call.local.has("screen")} onClick={()=>void call.toggle("screen")}>{call.local.has("screen")?<MonitorOff size={20}/>:<MonitorUp size={20}/>}</button>
            <button type="button" className="call-button" aria-label="Connection diagnostics" title="Diagnostics" onClick={()=>setModal("diagnostics")}><AudioLines size={20}/></button>
            <button type="button" className="call-button leave" aria-label="Leave call" title="Leave call" onClick={()=>voice.disconnect()}><PhoneOff size={20}/></button>
          </div>
        </>:<div className="blank"><span className="empty-icon"><AudioLines size={28}/></span><h2>{voiceRoom?.name??"Voice room"}</h2><p>{voiceRoom&&membersOf(voiceRoom.id).length?new Intl.ListFormat(undefined,{type:"conjunction"}).format(membersOf(voiceRoom.id).map(m=>m.name))+" "+(membersOf(voiceRoom.id).length===1?"is":"are")+" here.":"No one is here yet."}</p>{voiceRoom&&<button className="primary" onClick={()=>void join(voiceRoom)}>Join voice room</button>}</div>}
      </div>}
      {(!mainStage||sidechatOpen)&&<section className={"chat-pane"+(sidechatOpen?" voice-sidechat":"")} id={sidechatOpen?"voice-sidechat":undefined} aria-label={sidechatOpen?"Voice channel sidechat":"Channel chat"}
        onDragEnter={e=>{if(chatChannel&&e.dataTransfer.types.includes("Files")){e.preventDefault();setDragging(true);}}}
        onDragOver={e=>{if(chatChannel&&e.dataTransfer.types.includes("Files"))e.preventDefault();}}
        onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDragging(false);}}
        onDrop={e=>{setDragging(false);const list=Array.from(e.dataTransfer.files);if(chatChannel&&list.length){e.preventDefault();stageFiles(list);}}}>
        {dragging&&<div className="drop-zone" aria-hidden="true"><Paperclip size={28}/><b>Drop to attach to #{chatChannel?.name}</b></div>}
        {sidechatOpen&&<header className="sidechat-header"><h2>{voiceRoom?.name} sidechat</h2><IconButton label="Close sidechat" onClick={()=>setSidechat("")}><X size={17}/></IconButton></header>}
        <div className="message-feed" data-channel={chatId} ref={feed} onScroll={e=>{
          const el=e.currentTarget;const bottom=el.scrollHeight-el.scrollTop-el.clientHeight<100;stick.current=bottom;
          if(bottom&&awayFrom!==null)setAwayFrom(null);else if(!bottom&&awayFrom===null)setAwayFrom(bounded.at(-1)?.id??0);
        }}><div className="feed-inner" ref={feedInner}>
          {hasMore&&bounded.length>=50&&<button className="older" onClick={earlier}>Load earlier messages</button>}
          {!bounded.length&&chatId&&ready!==chatId&&<div className="skeleton-feed" aria-label="Loading messages">{[72,48,90,60,36].map((w,i)=><div key={i} className="skeleton-message"><span className="skeleton avatar-skel"/><div><span className="skeleton" style={{width:"18%"}}/><span className="skeleton" style={{width:w+"%"}}/></div></div>)}</div>}
          {!bounded.length&&!(chatId&&ready!==chatId)&&<div className="blank"><span className="empty-icon">{sidechatOpen?<MessageSquare size={26}/>:<Hash size={26}/>}</span><h2>{find?"No matching messages":pinned?"No pinned messages":chatChannel?.name??"Welcome to RaRRcord"}</h2>{(!chatId||ready===chatId)&&<p>{find?"Try another search.":pinned?"Pinned messages will appear here.":chatChannel?"Start the conversation.":"Choose a channel to get started."}</p>}</div>}
          {bounded.map((m,i)=><MessageRow key={m.id} m={m} previous={bounded[i-1]} replyTo={m.reply?byId.get(m.reply):undefined}
            me={person?.id} admin={person?.role==="admin"} menuOpen={menu===m.id} unreadStart={unreadFrom?.channel===chatId&&unreadFrom.id===m.id} actions={rowActions}/>)}
        </div></div>
        {unseen>0&&<button type="button" className="jump-present" onClick={()=>{if(feed.current){stick.current=true;feed.current.scrollTop=feed.current.scrollHeight;}setAwayFrom(null);}}>{unseen===1?"1 new message":unseen+" new messages"}<ArrowDown size={15}/></button>}
        {chatChannel&&<div className="compose-area">
          {picker==="emoji"&&<EmojiPicker label="Insert emoji" select={insertEmoji} close={()=>{setPicker(null);draftInput.current?.focus();}}/>}
          {picker&&typeof picker==="object"&&<EmojiPicker key={picker.id} label="Add reaction" close={()=>{setPicker(null);draftInput.current?.focus();}} select={emoji=>{
            const mine=picker.my_reactions?JSON.parse(picker.my_reactions) as string[]:[];
            if(!mine.includes(emoji))void action("react",picker,{emoji});
            setPicker(null);draftInput.current?.focus();
          }}/>}
          {picker==="gif"&&<div className="chat-picker gif-picker" role="dialog" aria-label="Add GIF" onKeyDown={event=>{if(event.key==="Escape"){setPicker(null);draftInput.current?.focus();}}} onPaste={pasteGif}>
            <div className="picker-heading"><b>Add a GIF</b><IconButton label="Close GIF picker" onClick={()=>{setPicker(null);draftInput.current?.focus();}}><X size={16}/></IconButton></div>
            <p>Choose a GIF file or paste one from your clipboard.</p>
            <button autoFocus type="button" className="primary" onClick={()=>gifUpload.current?.click()}>Choose GIF</button>
          </div>}
          {(edit||reply)&&<div className="compose-state">{edit?"Editing message":"Replying to "+reply?.name}<IconButton label="Cancel" onClick={()=>{if(edit)setDraft("");setReply(null);setEdit(null);}}><X size={14}/></IconButton></div>}
          {gif&&!edit&&<GifPreview file={gif} remove={()=>setGifDraft(null)}/>}
          {files.length>0&&!edit&&<ul className="staged" aria-label="Files to send">{files.map(item=><StagedFile key={item.key} file={item.file} uploading={progress?.name===item.file.name?progress.fraction:undefined} remove={()=>setStaged(list=>list.filter(s=>s.key!==item.key))}/>)}</ul>}
          <form className="compose" onSubmit={send}>
            <input ref={upload} hidden multiple type="file" onChange={e=>{
              const list=Array.from(e.currentTarget.files??[]);e.currentTarget.value="";if(list.length)stageFiles(list);
            }}/>
            <input ref={gifUpload} hidden type="file" accept="image/gif,.gif" onChange={event=>{
              const file=event.currentTarget.files?.[0];event.currentTarget.value="";if(file)selectGif(file);
            }}/>
            <IconButton label="Attach file" onClick={()=>upload.current?.click()}><Paperclip size={20}/></IconButton>
            <textarea ref={draftInput} rows={1} maxLength={8000} value={draft} placeholder={"Message "+chatChannel.name} aria-label={"Message "+chatChannel.name} onChange={event=>changeDraft(event.target.value)} onPaste={pasteGif} onKeyDown={e=>{
              if(e.nativeEvent.isComposing)return;
              if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();e.currentTarget.form?.requestSubmit();}
              else if(e.key==="Escape"&&(edit||reply)&&!picker){e.preventDefault();if(edit)setDraft("");setEdit(null);setReply(null);}
              else if(e.key==="ArrowUp"&&!draft&&!edit){const last=[...bounded].reverse().find(m=>m.uid===person?.id&&m.body);if(last){e.preventDefault();rowHandlers.current.edit(last);}}
            }}/>
            <IconButton label="Insert emoji" active={picker==="emoji"} onClick={()=>setPicker(picker==="emoji"?null:"emoji")}><Smile size={20}/></IconButton>
            <button type="button" className={"icon-button gif-button"+(picker==="gif"?" active":"")} aria-label="Add GIF" aria-expanded={picker==="gif"} disabled={!!edit} onClick={()=>setPicker(picker==="gif"?null:"gif")}>GIF</button>
            <button className="send" aria-label="Send message" disabled={sending||(!draft.trim()&&((!gif&&!files.length)||!!edit))}><Send size={17}/></button>
          </form>
          <div className="typing" aria-live="polite">{typing.length>0&&<><span className="typing-dots" aria-hidden="true"><i/><i/><i/></span>{typingText(typing)}…</>}</div>
        </div>}
      </section>}
      </div>
      {call?.feeds.filter(f=>f.kind==="voice").map(f=><Media key={f.key} feed={f} deaf={call.deaf} output={prefs.output} video={false} volume={voiceVolume(f.peer)}/>)}
    </main>
    {members&&<aside className="members-pane"><div className="members-title"><h2>Members</h2><span>{space?.people.length??""}</span></div>
      {!space&&<div className="skeleton-list members-skel" aria-label="Loading members">{[55,70,45,60].map((w,i)=><div key={i}><span className="skeleton avatar-skel"/><span className="skeleton" style={{width:w+"%"}}/></div>)}</div>}
      {["online","offline"].map(group=><section key={group}><h3>{group==="online"?"Available":"Offline"}</h3>{space?.people.filter(p=>group==="offline"?p.status==="offline":p.status!=="offline").map(p=><details className="member" key={p.id}><summary><Avatar name={p.name} uid={p.id} has={p.avatar} status={p.status}/><span><b>{p.name}</b><small>@{p.username}{p.role==="admin"?" · Admin":""}</small></span></summary>
        {p.id!==person?.id&&<div className="member-menu"><button onClick={()=>{setDmUsers([p.id]);setModal("dm");}}>Message</button><button onClick={async()=>{try{await request("block",{users:[p.id]});report("Member blocked.");}catch(e){report((e as Error).message);}}}>Block</button><button onClick={()=>void request("block",{users:[p.id],remove:true}).then(()=>report("Member unblocked.")).catch(e=>report(e.message))}>Unblock</button></div>}
      </details>)}</section>)}
    </aside>}
    {sheetOpen&&<div className="scrim" aria-hidden="true" onClick={()=>{setMobile(false);setMembersSheet(false);}}/>}
    <div className="toast-region" role="status" aria-live="polite">{toast&&<div className="toast">{toast}<IconButton label="Dismiss" onClick={()=>setToast("")}><X size={16}/></IconButton></div>}</div>
    <ConfirmHost/>
    {modal&&<Modal key={modal} wide={modal==="admin"} className={modal==="switch"?"switch-dialog":""} onClose={()=>setModal("")} title={({admin:"Administration",settings:"User settings",diagnostics:"Connection diagnostics",dm:"Direct message",help:"RaRRcord help",switch:"Jump to"} as Record<string,string>)[modal]}>
      {modal==="settings"&&person&&<><UserSettings person={person} prefs={prefs} limit={limit} save={()=>{void refresh();void refreshAuth();setModal("");report(call?"Settings saved. Rejoin the call to apply media changes.":"Settings saved.");}} report={report} signOut={logout}/></>}
      {modal==="diagnostics"&&<Diagnostics call={call} latency={latency} errors={errors}/>}
      {modal==="admin"&&space&&<Admin space={space} server={server} report={report} refresh={refresh}/>}
      {modal==="dm"&&<form className="settings-form" onSubmit={async e=>{e.preventDefault();try{const result=await request<{id:string}>("dm",{users:dmUsers});await refresh();setSelected(result.id);setStage(false);setModal("");}catch(e){report((e as Error).message);}}}>
        {space?.people.filter(p=>p.id!==person?.id).map(p=><label className="inline" key={p.id}><input type="checkbox" checked={dmUsers.includes(p.id)} onChange={e=>setDmUsers(prev=>e.target.checked?[...prev,p.id]:prev.filter(id=>id!==p.id))}/>{p.name}</label>)}
        <button className="primary" disabled={!dmUsers.length}>Open conversation</button>
      </form>}
      {modal==="help"&&<div className="settings-form"><p>Select a text channel to send messages or a voice room to connect. Joining a voice room starts your microphone with your browser’s permission. Use the call controls for your microphone, camera and screen.</p><p>Use Shift + Enter for a new line. Open User settings to configure capture and push to talk.</p>
        <dl className="shortcuts"><dt><kbd>Ctrl</kbd> <kbd>K</kbd></dt><dd>Jump to a channel or person</dd><dt><kbd>↑</kbd></dt><dd>Edit your last message (empty message box)</dd><dt><kbd>Esc</kbd></dt><dd>Cancel a reply or edit, close menus and dialogs</dd><dt>Right-click or long-press</dt><dd>Message actions</dd></dl>
        <a href="/privacy">Privacy</a></div>}
      {modal==="switch"&&space&&<QuickSwitcher channels={space.channels} servers={space.servers} people={space.people} me={person?.id}
        openChannel={c=>{setModal("");if(c.server)setServer(c.server);choose(c);}}
        openPerson={async p=>{setModal("");try{const result=await request<{id:string}>("dm",{users:[p.id]});await refresh();setSelected(result.id);setStage(false);}catch(e){report((e as Error).message);}}}/>}
    </Modal>}
  </div>;
}
function GifPreview({file,remove}:{file:File;remove:()=>void}){
  const [url,setUrl]=useState("");
  useEffect(()=>{
    const preview=URL.createObjectURL(file);
    setUrl(preview);
    return ()=>URL.revokeObjectURL(preview);
  },[file]);
  return <div className="gif-preview">{url&&<img src={url} alt="GIF preview"/>}<span>{file.name}</span><IconButton label="Remove GIF" onClick={remove}><X size={16}/></IconButton></div>;
}
function StagedFile({file,uploading,remove}:{file:File;uploading?:number;remove:()=>void}){
  const size=file.size<1048576?Math.max(1,Math.round(file.size/1024))+" KB":(file.size/1048576).toFixed(1)+" MB";
  return <li className="staged-file">
    {isImage(file.name)?<img alt="" ref={img=>{if(!img)return;const preview=URL.createObjectURL(file);img.src=preview;return ()=>URL.revokeObjectURL(preview);}}/>:<span className="file-icon"><FileText size={22}/></span>}
    <span><b>{file.name}</b><small>{uploading===undefined?size:"Uploading "+Math.round(uploading*100)+"%"}</small></span>
    {uploading===undefined?<IconButton label={"Remove "+file.name} onClick={remove}><X size={15}/></IconButton>:null}
    {uploading!==undefined&&<progress max={1} value={uploading} aria-label={"Uploading "+file.name}/>}
  </li>;
}
function Attachment({message:m}:{message:Message}){
  const url="/api/ra/attachment?key="+encodeURIComponent(m.attachment??"");
  const [failed,setFailed]=useState(false);
  const [open,setOpen]=useState(false);
  const image=!failed&&isImage(m.filename??"");
  return <div className="attachment">
    {image?<button type="button" className="attachment-image" aria-label={"Open "+m.filename} onClick={()=>setOpen(true)}><img loading="lazy" src={url} alt={m.filename} onError={()=>setFailed(true)}/></button>:
      <a className="attachment-file" href={url+"&download=1"}><FileText size={22}/><span>{m.filename??"Attachment"}</span><Download size={16}/></a>}
    {open&&<Modal title={m.filename??"Image"} className="lightbox" onClose={()=>setOpen(false)}>
      <img src={url} alt={m.filename}/>
      <a className="primary" href={url+"&download=1"}><Download size={16}/>Download</a>
    </Modal>}
  </div>;
}

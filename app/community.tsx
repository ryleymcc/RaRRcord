"use client";
import { useCallback,useEffect,useRef,useState, type FormEvent, type ReactNode } from "react";
import { AudioLines, Bell, Camera, ChevronDown, CircleHelp, Headphones, Hash, LockKeyhole, LogOut, Menu, Mic, MicOff, MonitorUp, Paperclip, Plus, Search, Send, Settings, Shield, Users, X } from "lucide-react";
import { Call, codecs, type Feed, type Metrics, type Participant, type Signal } from "./rtc";
import { request, defaults, qualities, type Channel, type Message, type Person, type Preferences, type Server } from "./ra-client";
import Admin from "./ra-admin";

type Workspace={servers:Server[]; channels:Channel[]; people:Person[]; settings:{key:string;value:string}[];prefs:Partial<Preferences>};
type Auth={user:Person|null;active:boolean;ownerConfigured?:boolean};
type History={messages:Message[];cursor:number};
type Update={messages?:Message[];cursor?:number;typing?:{name:string}[];voice?:Participant[]|null;signals?:Signal[]};
const day=(v:number)=>new Date(v).toLocaleDateString(undefined,{weekday:"long",month:"long",day:"numeric"});
const clock=(v:number)=>new Date(v).toLocaleTimeString(undefined,{hour:"numeric",minute:"2-digit"});
const initials=(s:string)=>s.trim().split(/\s+/).slice(0,2).map(x=>x[0]).join("").toUpperCase();
const avatarUrl=(id:string)=>"/api/ra/avatar?key="+encodeURIComponent(id);
function Avatar({name,uid,has,status}:{name:string;uid:string;has?:boolean;status?:string}){
  const color=[...uid].reduce((sum,c)=>sum+c.charCodeAt(0),0)%6;
  return <span className={"avatar hue-"+color}>{has?<img src={avatarUrl(uid)} alt=""/>:initials(name)}{status&&<i className={"presence "+status} title={status}/>}</span>;
}
function IconButton({label,children,onClick,active=false}:{label:string;children:ReactNode;onClick:()=>void;active?:boolean}){
  return <button type="button" className={"icon-button"+(active?" active":"")} title={label} aria-label={label} aria-pressed={active} onClick={onClick}>{children}</button>;
}
function inline(text:string) {
  return text.split(/(\*\*[^*\n]+\*\*|_[^_\n]+_|\x60[^\x60\n]+\x60|@[a-z0-9_]+)/gi).map((s,i)=>s.startsWith("**")?<strong key={i}>{s.slice(2,-2)}</strong>:s.startsWith("_")&&s.endsWith("_")?<em key={i}>{s.slice(1,-1)}</em>:s.startsWith("\x60")?<code key={i}>{s.slice(1,-1)}</code>:s.startsWith("@")?<span key={i} className="mention">{s}</span>:s);
}
function markdown(text:string){
  return text.split(/\x60\x60\x60/).map((part,i)=>{
    if(i%2===0)return <span key={i}>{inline(part)}</span>;
    const start=part.indexOf("\n");
    const body=start<0?part:part.slice(start+1);
    return <pre key={i}><code>{body.split(/(".*?"|'.*?'|\/\/[^\n]*|\b(?:const|let|function|return|if|else|class|import|export|async|await|true|false|null|def|print)\b|\b\d+\b)/g).map((s,j)=>j%2?<span className="syntax" key={j}>{s}</span>:s)}</code></pre>;
  });
}
function Media({feed,deaf,output,volume,video}:{feed:Feed;deaf:boolean;output:string;volume:number;video:boolean}){
  const element=useRef<HTMLMediaElement|null>(null);
  useEffect(()=>{
    const el=element.current;
    if(!el)return;
    el.srcObject=feed.stream; el.volume=volume;
    if(output && "setSinkId" in el)void (el as HTMLMediaElement & {setSinkId(id:string):Promise<void>}).setSinkId(output).catch(()=>{});
    void el.play().catch(()=>{});
  },[feed.stream,output,volume]);
  return video?<video autoPlay playsInline controls muted={deaf} ref={node=>{element.current=node;}}/>:<audio autoPlay muted={deaf} ref={node=>{element.current=node;}}/>;
}
function Diagnostics({call,latency}:{call:Call|null;latency:number|null}){
  const [records,setRecords]=useState<Metrics[]>([]);
  const [samples,setSamples]=useState<number[][]>([[],[],[],[]]);
  const [probe,setProbe]=useState("Unchecked");
  const [devices,setDevices]=useState<MediaDeviceInfo[]>([]);
  useEffect(()=>{
    let live=true;
    const sample=async()=>{
      if(!call)return;
      try{
        const next=await call.metrics();
        if(!live)return;
        setRecords(next);
        const media=next.find(r=>r.fps!==undefined)??next[0];
        const current=[media?.bitrate,media?.rtt,media?.loss,media?.fps];
        setSamples(prev=>prev.map((row,i)=>current[i]===undefined?row:[...row.slice(-39),current[i]!]));
      }catch{}
    };
    void sample();
    const timer=setInterval(sample,1000);
    void navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(()=>{});
    return ()=>{live=false;clearInterval(timer);};
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
    <p>Screen capture {typeof navigator.mediaDevices?.getDisplayMedia==="function"?"available":"unavailable"} · Microphone {devices.some(d=>d.kind==="audioinput")?"detected":"unavailable"} · Camera {devices.some(d=>d.kind==="videoinput")?"detected":"unavailable"}</p>
    <p>Local codecs {typeof RTCRtpSender==="undefined"?"Unavailable":codecs().join(", ")||"Unavailable"}</p>
    <p>Screen capture {capture?.width&&capture.height?capture.width+" × "+capture.height+" · "+value(capture.frameRate," FPS"):"Unavailable"}</p>
    <div className="graphs">{["Bitrate · Kbps","Round trip · ms","Packet loss · %","Frame rate · FPS"].map((title,i)=>{
      const points=samples[i], top=Math.max(1,...points);
      return <div key={title}><span>{title}</span>{points.length?<svg aria-label={title+" samples"} viewBox="0 0 160 44" preserveAspectRatio="none"><polyline points={points.map((n,j)=>j*160/Math.max(1,points.length-1)+","+(43-(n/top)*41)).join(" ")} /></svg>:<p>Unavailable</p>}</div>;
    })}</div>
    {!records.length&&<p>Join a voice room with another participant to measure a peer connection.</p>}
    {records.map((r,i)=><div className="metric-card" key={r.name+"-"+i}><h3>{r.name} · {r.direction}</h3><dl>{[
      ["Connection",r.connection],["ICE",r.ice],["ICE gathering",r.gathering],["Path",r.route??"Unavailable"],["Codec",r.codec??"Unavailable"],
      ["Resolution",r.resolution??"Unavailable"],["Rate",value(r.fps," FPS")],["Bitrate",value(r.bitrate," Kbps")],["Round trip",value(r.rtt," ms")],
      ["Packet loss",value(r.loss,"%")],["Jitter",value(r.jitter," ms")],["Frames dropped",value(r.dropped)],["Frames encoded",value(r.encoded)],["Frames decoded",value(r.decoded)],
      ["Encode time per frame",value(r.encodeMs," ms")],["Decode time per frame",value(r.decodeMs," ms")],["Available outgoing",value(r.available," Kbps")],["Quality limit",r.limited??"Unavailable"],
    ].map(([label,n])=><div key={label}><dt>{label}</dt><dd>{n}</dd></div>)}</dl></div>)}
    <p>A relay requires configured TURN credentials. If peers stay disconnected, try a different network or ask an administrator to check relay configuration.</p>
  </div>;
}
function UserSettings({person,prefs,limit,save,report}:{person:Person;prefs:Preferences;limit:number;save:()=>void;report:(x:string)=>void}){
  const [devices,setDevices]=useState<MediaDeviceInfo[]>([]);
  const [name,setName]=useState(person.name);
  const [status,setStatus]=useState(person.status);
  const [form,setForm]=useState(prefs);
  const [test,setTest]=useState("");
  const meterTimer=useRef<number|undefined>(undefined);
  const testing=useRef(false);
  const testResource=useRef<{stream:MediaStream;context:AudioContext}|null>(null);
  const list=()=>navigator.mediaDevices?.enumerateDevices().then(setDevices).catch(()=>{});
  useEffect(()=>{void list(); return ()=>{testing.current=false;window.clearInterval(meterTimer.current);testResource.current?.stream.getTracks().forEach(t=>t.stop());void testResource.current?.context.close().catch(()=>{});};},[]);
  const change=<K extends keyof Preferences>(key:K,value:Preferences[K])=>setForm(f=>({...f,[key]:value}));
  const device=(label:string,key:"input"|"output"|"camera",kind:MediaDeviceKind)=><label>{label}<select value={form[key]} onChange={e=>change(key,e.target.value)}><option value="">System default</option>{devices.filter(d=>d.kind===kind&&d.deviceId).map((d,i)=><option key={d.deviceId} value={d.deviceId}>{d.label||label+" "+(i+1)}</option>)}</select></label>;
  async function testMic(){
    if(testing.current)return;
    testing.current=true;
    try{
      const stream=await navigator.mediaDevices.getUserMedia({audio:{deviceId:form.input?{exact:form.input}:undefined,noiseSuppression:form.noise,echoCancellation:form.echo,autoGainControl:form.gain}});
      if(!testing.current){stream.getTracks().forEach(t=>t.stop());return;}
      const context=new AudioContext();
      testResource.current={stream,context};
      const analyser=context.createAnalyser();
      context.createMediaStreamSource(stream).connect(analyser);
      const data=new Uint8Array(analyser.fftSize);
      const started=Date.now();
      meterTimer.current=window.setInterval(()=>{
        analyser.getByteTimeDomainData(data);
        const amplitude=Math.max(...data.map(n=>Math.abs(n-128)));
        setTest("Microphone level "+Math.round(100*amplitude/128)+"%");
        if(Date.now()-started>5000){window.clearInterval(meterTimer.current);stream.getTracks().forEach(t=>t.stop());void context.close();testResource.current=null;testing.current=false;}
      },150);
      void list();
    }catch(e){testing.current=false;report((e as Error).message);}
  }
  return <form className="settings-form" onSubmit={async(e)=>{
    e.preventDefault();
    try{await request("profile",{name,status,prefs:form});save();}catch(e){report((e as Error).message);}
  }}>
    <fieldset><legend>Profile</legend><label>Display name<input required maxLength={40} value={name} onChange={e=>setName(e.target.value)}/></label>
      <label>Status<select value={status} onChange={e=>setStatus(e.target.value)}>{["online","idle","dnd","offline"].map(s=><option value={s} key={s}>{s==="dnd"?"Do not disturb":s}</option>)}</select></label>
      <label>Profile picture<input type="file" accept="image/png,image/jpeg,image/webp,image/gif" onChange={async(e)=>{
        const file=e.target.files?.[0];if(!file)return;const body=new FormData();body.set("file",file);
        try{await request("avatar",body);report("Profile picture updated.");}catch(e){report((e as Error).message);}
      }}/></label>
    </fieldset>
    <fieldset><legend>Audio and camera</legend>{device("Microphone","input","audioinput")}{device("Speaker","output","audiooutput")}{device("Camera","camera","videoinput")}
      <label>Speaking sensitivity<input type="range" min={1} max={30} value={form.sensitivity} onChange={e=>change("sensitivity",+e.target.value)}/></label>
      <div className="toggle-grid">{([["noise","Noise suppression"],["echo","Echo cancellation"],["gain","Automatic gain"],["ptt","Push to talk"]] as const).map(([k,label])=><label key={k}><input type="checkbox" checked={form[k]} onChange={e=>change(k,e.target.checked)}/>{label}</label>)}</div>
      {form.ptt&&<label>Push-to-talk key<input value={form.key} readOnly onKeyDown={e=>{if(e.code!=="Tab"){e.preventDefault();change("key",e.code);}}}/></label>}
      <div className="inline"><button type="button" onClick={testMic}>Test microphone</button><span>{test}</span></div>
    </fieldset>
    <fieldset><legend>Screen sharing</legend><label>Target resolution and frame rate<select value={form.resolution} onChange={e=>change("resolution",e.target.value)}>{qualities.map(q=><option key={q} value={q}>{q.replace("2160","4K").replace("x"," · ")+" FPS"}</option>)}</select></label>
      <label>Target bitrate (Kbps)<input type="number" min={500} max={limit} value={form.bitrate} onChange={e=>change("bitrate",+e.target.value)}/></label>
      <label>Codec preference<select value={form.codec} onChange={e=>change("codec",e.target.value)}><option value="auto">Automatic</option>{typeof RTCRtpSender!=="undefined"&&codecs().map(c=><option key={c}>{c}</option>)}</select></label>
      <label>Streaming mode<select value={form.mode} onChange={e=>change("mode",e.target.value)}><option value="motion">Gaming · motion clarity</option><option value="detail">Desktop · text clarity</option></select></label>
    </fieldset>
    <fieldset><legend>Appearance and notifications</legend><label className="inline"><input type="checkbox" checked={form.compact} onChange={e=>change("compact",e.target.checked)}/>Compact messages</label>
      <label className="inline"><input type="checkbox" checked={form.notifications} onChange={async e=>{const want=e.target.checked;change("notifications",want&&"Notification" in window&&(await Notification.requestPermission())==="granted");}}/>Browser mention notifications</label>
    </fieldset>
    <div className="inline"><button className="primary">Save settings</button><a href="/privacy">Privacy</a></div>
  </form>;
}
export default function Community(){
  const [auth,setAuth]=useState<Auth|null>(null);
  const [space,setSpace]=useState<Workspace|null>(null);
  const [server,setServer]=useState("community");
  const [selected,setSelected]=useState("");
  const [messages,setMessages]=useState<Message[]>([]);
  const [typing,setTyping]=useState("");
  const [draft,setDraft]=useState("");
  const [edit,setEdit]=useState<Message|null>(null);
  const [reply,setReply]=useState<Message|null>(null);
  const [find,setFind]=useState("");
  const [pinned,setPinned]=useState(false);
  const [modal,setModal]=useState("");
  const [toast,setToast]=useState("");
  const [members,setMembers]=useState(true);
  const [mobile,setMobile]=useState(false);
  const [call,setCall]=useState<Call|null>(null);
  const [latency,setLatency]=useState<number|null>(null);
  const [,refreshCall]=useState(0);
  const [volumes,setVolumes]=useState<Record<string,number>>({});
  const [stage,setStage]=useState(false);
  const [speaker,setSpeaker]=useState(false);
  const [dmUsers,setDmUsers]=useState<string[]>([]);
  const [hasMore,setHasMore]=useState(true);
  const [ready,setReady]=useState("");
  const feed=useRef<HTMLDivElement>(null);
  const draftInput=useRef<HTMLTextAreaElement>(null);
  const upload=useRef<HTMLInputElement>(null);
  const cursor=useRef(0);
  const lastTyping=useRef(0);
  const currentCall=useRef<Call|null>(null);
  const stick=useRef(true);
  const person=auth?.user;
  const channel=space?.channels.find(c=>c.id===selected);
  const prefs={...defaults,...space?.prefs};
  const limit=Number(space?.settings.find(v=>v.key==="bitrate")?.value??50000);
  const report=useCallback((message:string)=>setToast(message),[]);
  const refreshAuth=useCallback(()=>request<Auth>("session").then(setAuth).catch(e=>setToast(e.message)),[]);
  const refresh=useCallback(()=>request<Workspace>("workspace").then(setSpace),[]);
  useEffect(()=>{void refreshAuth();},[refreshAuth]);
  useEffect(()=>{
    if(!auth?.active){currentCall.current?.close();currentCall.current=null;setCall(null);return;}
    void refresh().catch(e=>report(e.message));
    const timer=setInterval(()=>void refresh().catch(()=>void refreshAuth()),10000);
    return ()=>clearInterval(timer);
  },[auth?.active,refresh,report,refreshAuth]);
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
    setReady("");setMessages([]);setReply(null);setEdit(null);setTyping("");stick.current=true;
    if(!selected || channel?.kind==="voice")return;
    let active=true;
    const timer=setTimeout(()=>void load(selected,find,pinned).then(data=>{
      if(!active)return;
      cursor.current=data.cursor;setMessages(data.messages);setHasMore(data.messages.length===50 && !find && !pinned);setReady(selected);
    }).catch(e=>report(e.message)),find?220:0);
    return ()=>{active=false;clearTimeout(timer);};
  },[selected,find,pinned,channel?.kind,load,report]);
  useEffect(()=>{
    if(!auth?.active)return;
    let active=true,timer:ReturnType<typeof setTimeout>;
    const poll=async()=>{
      const params=new URLSearchParams();
      const liveCall=currentCall.current;
      if(ready===selected&&selected&&!find&&!pinned&&channel?.kind!=="voice"){params.set("channel",selected);params.set("after",String(cursor.current));}
      if(liveCall){params.set("peer",liveCall.peer);params.set("signal",String(liveCall.signal));}
      const began=performance.now();
      try{
        const result=await request<Update>("poll?"+params);
        if(!active)return;
        setLatency(performance.now()-began);
        if(params.has("channel")){
          cursor.current=result.cursor??cursor.current;
          setTyping(result.typing?.map(t=>t.name).join(", ")??"");
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
              for(const m of changed)if(!m.deleted&&!m.edited&&m.uid!==person?.id&&m.body.includes("@"+person?.username))new Notification(channel?.name??"RaRRcord",{body:m.name+" mentioned you",tag:"ra-"+m.id});
            }
          }
        }
        if(liveCall&&currentCall.current===liveCall){
          if(result.voice===null){liveCall.close();currentCall.current=null;setCall(null);report("Your voice room connection ended.");}
          else if(result.voice)await liveCall.update(result.voice,result.signals??[]);
        }
      }catch{
        if(active)void refreshAuth();
      }finally{if(active)timer=setTimeout(poll,currentCall.current?750:document.hidden?4500:1500);}
    };
    void poll();
    return ()=>{active=false;clearTimeout(timer);};
  },[auth?.active,ready,selected,find,pinned,channel?.kind,channel?.name,prefs.notifications,person?.id,person?.username,refreshAuth,report,call]);
  useEffect(()=>()=>{
    currentCall.current?.close();
    currentCall.current=null;
  },[]);
  useEffect(()=>{
    if(stick.current && feed.current)feed.current.scrollTop=feed.current.scrollHeight;
    const last=messages.at(-1);
    if(last && selected && !find && !pinned && !document.hidden)void request("read",{channel:selected,id:last.id}).catch(()=>{});
  },[messages,selected,find,pinned]);
  useEffect(()=>{if(!toast)return;const timer=setTimeout(()=>setToast(""),6500);return ()=>clearTimeout(timer);},[toast]);
  function choose(c:Channel){
    setMobile(false);setFind("");setPinned(false);setSelected(c.id);
    if(c.kind==="voice"){setStage(true);void join(c);}
    else setStage(false);
  }
  async function join(c:Channel){
    if(currentCall.current?.channel===c.id)return;
    if(typeof RTCPeerConnection==="undefined"){report("WebRTC is unavailable in this browser.");return;}
    try{
      const ice=await request<{servers:RTCIceServer[]}>("ice");
      currentCall.current?.close();
      const linked=new Call(c.id,{...prefs,bitrate:Math.min(limit,prefs.bitrate)},ice.servers,()=>refreshCall(n=>n+1),report);
      try{await request("voice",{action:"join",channel:c.id,peer:linked.peer});}
      catch(error){linked.close();throw error;}
      currentCall.current=linked;setCall(linked);
    }catch(e){report((e as Error).message);}
  }
  async function logout(){
    try{await request("logout",{});currentCall.current?.close();location.assign("/signout-with-chatgpt?return_to=%2F");}
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
    if(!text||!channel)return;
    try{
      await request("message",{channel:selected,text,action:edit?"edit":"send",id:edit?.id,reply:reply?.id});
      stick.current=true;setDraft("");setEdit(null);setReply(null);draftInput.current?.focus();
      if(find||pinned){setFind("");setPinned(false);}
    }catch(e){report((e as Error).message);}
  }
  async function action(kind:string,m:Message,extra:object={}){
    try{await request("message",{channel:selected,action:kind,id:m.id,...extra});}
    catch(e){report((e as Error).message);}
  }
  async function earlier(){
    if(!messages[0])return;
    const current=selected;
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
  const currentServer=space?.servers.find(s=>s.id===server);
  const callTitle=space?.channels.find(c=>c.id===call?.channel)?.name;
  const mainStage=stage||channel?.kind==="voice";
  const feeds=call?.feeds.filter(f=>f.kind!=="voice")??[];
  const orderedFeeds=speaker?[...feeds].sort((a,b)=>Number(call?.speaking(b.peer))-Number(call?.speaking(a.peer))):feeds;
  const ownVoice=call?.local.get("cam");
  const bounded=messages.slice(-350);
  return <div className={"assembly "+(members?"with-members ":"")+(mobile?"mobile-nav ":"")+(prefs.compact?"compact":"")}>
    <nav className="rail" aria-label="Servers">
      <button className="mark" aria-label="RaRRcord home" onClick={()=>{setServer("community");setSelected("general");setStage(false);}}>R</button>
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
        {groups.map(group=><details key={group} open><summary><ChevronDown size={14}/>{group}</summary>{channels.filter(c=>(c.category||"Channels")===group).map(c=><button key={c.id} className={"channel "+(selected===c.id?"selected":"")} onClick={()=>choose(c)}>
          {c.kind==="voice"?<AudioLines size={17}/>:c.kind==="private"?<LockKeyhole size={15}/>:<Hash size={17}/>}<span>{c.name}</span>{c.unread>0&&selected!==c.id&&<b className="badge">{c.unread>99?"99+":c.unread}</b>}{call?.channel===c.id&&<i className="voice-dot"/>}
        </button>)}</details>)}
        <button className="channel dm-button" onClick={()=>{setDmUsers([]);setModal("dm");}}><Plus size={16}/>New direct message</button>
      </div>
      {call&&<div className="voice-status"><div><b><i className="voice-dot"/> Voice connected</b><span>{callTitle}</span></div><IconButton label="Disconnect" onClick={()=>{call.close();currentCall.current=null;setCall(null);}}><LogOut size={18}/></IconButton></div>}
      <footer className="profile">
        {person&&<Avatar name={person.name} uid={person.id} has={person.avatar} status={person.status}/>}
        <div><b>{person?.name}</b><small>@{person?.username}</small></div>
        {call&&<IconButton label="Mute microphone" active={call.muted} onClick={()=>call.setMuted(!call.muted)}>{call.muted?<MicOff size={16}/>:<Mic size={16}/>}</IconButton>}
        <IconButton label="User settings" onClick={()=>setModal("settings")}><Settings size={18}/></IconButton>
      </footer>
    </aside>
    <main className="conversation">
      <header className="topbar">
        <span className="mobile-toggle"><IconButton label="Toggle navigation" onClick={()=>setMobile(!mobile)}><Menu size={20}/></IconButton></span>
        <div className="location-title">{mainStage?<AudioLines size={21}/>:<Hash size={22}/>}<h1>{mainStage?callTitle??channel?.name??"Voice room":channel?.name??"Community"}</h1></div>
        <span className="channel-description">{channel?.description}</span>
        <div className="top-actions">
          {call&&!mainStage&&<button className="subtle" onClick={()=>setStage(true)}>View call</button>}
          {!mainStage&&<><label className="search"><Search size={16}/><input aria-label="Search messages" value={find} placeholder="Search messages" onChange={e=>setFind(e.target.value)}/></label><IconButton label="Pinned messages" active={pinned} onClick={()=>setPinned(!pinned)}><Bell size={19}/></IconButton></>}
          <IconButton label="Toggle member list" active={members} onClick={()=>setMembers(!members)}><Users size={20}/></IconButton>
          {person?.role==="admin"&&<IconButton label="Administration" onClick={()=>setModal("admin")}><Shield size={19}/></IconButton>}
        </div>
      </header>
      {mainStage?<div className="stage">
        {call?<><div className="stage-head"><div><h2>{callTitle}</h2><p>{call.participants.length} connected</p></div><button onClick={()=>setSpeaker(!speaker)}>{speaker?"Grid view":"Active speaker view"}</button></div>
          <div className={"stage-grid"+(speaker?" speaker":"")}>{call.participants.map(participant=><div key={participant.peer} className={"participant "+(call.speaking(participant.peer)?"speaking":"")}><Avatar name={participant.name} uid={participant.uid}/><b>{participant.name}{participant.peer===call.peer?" (you)":""}</b>
            {participant.peer!==call.peer&&<div className="inline">{(["cam","screen"] as const).filter(k=>participant[k]).map(k=><button key={k} onClick={()=>call.watch(participant.peer,k,!call.watching(participant.peer,k))}>{call.watching(participant.peer,k)?"Stop "+(k==="cam"?"camera":"watching"):k==="cam"?"Watch camera":"Watch screen"}</button>)}</div>}
            {participant.peer!==call.peer&&<label className="volume">Volume<input type="range" min={0} max={1} step={0.05} value={volumes[participant.peer]??1} onChange={e=>setVolumes(v=>({...v,[participant.peer]:+e.target.value}))}/></label>}
          </div>)}
          {ownVoice&&<div className="video-card"><Media feed={{key:"preview",peer:call.peer,kind:"cam",stream:ownVoice}} deaf output="" video volume={0}/><span>Your camera preview</span></div>}
          {orderedFeeds.map(f=><div className="video-card" key={f.key}><Media feed={f} deaf={call.deaf} output={prefs.output} video volume={volumes[f.peer]??1}/><span>{call.participants.find(p=>p.peer===f.peer)?.name} · {f.kind==="cam"?"Camera":"Screen"}</span></div>)}</div>
          <div className="call-controls">
            <button className={call.local.has("voice")?"live-control":""} onClick={()=>void call.toggle("voice")}><Mic size={18}/>{call.local.has("voice")?"Turn off microphone":"Enable microphone"}</button>
            <button onClick={()=>call.setDeaf(!call.deaf)}><Headphones size={18}/>{call.deaf?"Undeafen":"Deafen"}</button>
            <button className={call.local.has("cam")?"live-control":""} onClick={()=>void call.toggle("cam")}><Camera size={18}/>{call.local.has("cam")?"Stop camera":"Camera"}</button>
            <button className={call.local.has("screen")?"live-control":""} onClick={()=>void call.toggle("screen")}><MonitorUp size={18}/>{call.local.has("screen")?"Stop sharing":"Share screen"}</button>
            <button onClick={()=>setModal("diagnostics")}><AudioLines size={18}/>Diagnostics</button>
          </div>
        </>:<div className="blank"><AudioLines size={32}/><h2>{channel?.name??"Voice room"}</h2>{channel&&<button className="primary" onClick={()=>void join(channel)}>Join voice room</button>}</div>}
      </div>:<>
        <div className="message-feed" data-channel={selected} ref={feed} onScroll={e=>{const el=e.currentTarget;stick.current=el.scrollHeight-el.scrollTop-el.clientHeight<100;}}>
          {hasMore&&bounded.length>=50&&<button className="older" onClick={earlier}>Load earlier messages</button>}
          {!bounded.length&&<div className="blank"><span className="empty-icon"><Hash size={26}/></span><h2>{find?"No matching messages":pinned?"No pinned messages":channel?.name??"Welcome to RaRRcord"}</h2><p>{find?"Try another search.":pinned?"Pinned messages will appear here.":channel?"Start the conversation.":"Choose a channel to get started."}</p></div>}
          {bounded.map((m,i)=>{
            const newDay=i===0||day(bounded[i-1].created)!==day(m.created);
            const joined=i>0&&!newDay&&bounded[i-1].uid===m.uid&&m.created-bounded[i-1].created<240000;
            const reacts=Object.entries(m.reactions?JSON.parse(m.reactions) as Record<string,number>:{});
            return <div key={m.id} style={{contentVisibility:"auto",containIntrinsicSize:joined?"auto 28px":"auto 72px"}}>
              {newDay&&<div className="date-divider"><span>{day(m.created)}</span></div>}
              <article className={"message "+(joined?"joined":"")} aria-label={"Message by "+m.name}>
                {!joined&&<Avatar name={m.name} uid={m.uid} has={m.has_avatar}/>}
                <div className="message-content">
                  {m.reply&&<span className="reply-label">Replying to {bounded.find(x=>x.id===m.reply)?.name??"an earlier message"}</span>}
                  {!joined&&<div className="byline"><strong>{m.name}</strong><time dateTime={new Date(m.created).toISOString()}>{clock(m.created)}</time>{!!m.pinned&&<span className="tag">Pinned</span>}</div>}
                  {m.body&&<div className="text-body">{markdown(m.body)}{m.edited&&<small> (edited)</small>}</div>}
                  {m.attachment&&<Attachment message={m}/>}
                  {reacts.length>0&&<div className="reaction-row">{reacts.map(([emoji,count])=><button key={emoji} onClick={()=>void action("react",m,{emoji})}>{emoji} {count}</button>)}</div>}
                </div>
                <details className="message-menu"><summary aria-label="Message actions">•••</summary><div>
                  <button onClick={()=>{setReply(m);draftInput.current?.focus();}}>Reply</button>
                  <button onClick={()=>void action("react",m,{emoji:"👍"})}>React 👍</button>
                  <button onClick={()=>void action("react",m,{emoji:"👍",remove:true})}>Remove 👍</button>
                  {person?.id===m.uid&&<button onClick={()=>{setEdit(m);setDraft(m.body);draftInput.current?.focus();}}>Edit</button>}
                  {(person?.id===m.uid||person?.role==="admin")&&<><button onClick={()=>void action("pin",m)}>{m.pinned?"Unpin":"Pin"}</button><button className="danger" onClick={()=>{if(confirm("Delete this message?"))void action("delete",m);}}>Delete</button></>}
                  {person?.id!==m.uid&&<button onClick={()=>{const reason=prompt("Why are you reporting this message?");if(reason)void action("report",m,{reason});}}>Report</button>}
                </div></details>
              </article>
            </div>;
          })}
        </div>
        {channel&&<div className="compose-area">
          {(edit||reply)&&<div className="compose-state">{edit?"Editing message":"Replying to "+reply?.name}<IconButton label="Cancel" onClick={()=>{if(edit)setDraft("");setReply(null);setEdit(null);}}><X size={14}/></IconButton></div>}
          <form className="compose" onSubmit={send}>
            <input ref={upload} hidden type="file" onChange={async e=>{
              const f=e.currentTarget.files?.[0];e.currentTarget.value="";if(!f)return;
              const data=new FormData();data.set("channel",selected);data.set("file",f);
              try{await request("upload",data);stick.current=true;}catch(e){report((e as Error).message);}
            }}/>
            <IconButton label="Attach file" onClick={()=>upload.current?.click()}><Paperclip size={20}/></IconButton>
            <textarea ref={draftInput} rows={1} maxLength={8000} value={draft} placeholder={"Message "+channel.name} aria-label={"Message "+channel.name} onChange={e=>{
              setDraft(e.target.value);if(Date.now()-lastTyping.current>3000){lastTyping.current=Date.now();void request("typing",{channel:selected}).catch(()=>{});}
            }} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();e.currentTarget.form?.requestSubmit();}}}/>
            <button className="send" aria-label="Send message" disabled={!draft.trim()}><Send size={17}/></button>
          </form>
          <div className="typing" aria-live="polite">{typing?typing+" typing…":""}</div>
        </div>}
      </>}
      {call?.feeds.filter(f=>f.kind==="voice").map(f=><Media key={f.key} feed={f} deaf={call.deaf} output={prefs.output} video={false} volume={volumes[f.peer]??1}/>)}
    </main>
    {members&&<aside className="members-pane"><div className="members-title"><h2>Members</h2><span>{space?.people.length??0}</span></div>
      {["online","offline"].map(group=><section key={group}><h3>{group==="online"?"Available":"Offline"}</h3>{space?.people.filter(p=>group==="offline"?p.status==="offline":p.status!=="offline").map(p=><details className="member" key={p.id}><summary><Avatar name={p.name} uid={p.id} has={p.avatar} status={p.status}/><span><b>{p.name}</b><small>{p.role==="admin"?"Administrator":"@"+p.username}</small></span></summary>
        {p.id!==person?.id&&<div className="member-menu"><button onClick={()=>{setDmUsers([p.id]);setModal("dm");}}>Message</button><button onClick={async()=>{try{await request("block",{users:[p.id]});report("Member blocked.");}catch(e){report((e as Error).message);}}}>Block</button><button onClick={()=>void request("block",{users:[p.id],remove:true}).then(()=>report("Member unblocked.")).catch(e=>report(e.message))}>Unblock</button></div>}
      </details>)}</section>)}
    </aside>}
    {toast&&<div role="status" className="toast">{toast}<IconButton label="Dismiss" onClick={()=>setToast("")}><X size={16}/></IconButton></div>}
    {modal&&<div className="overlay" onClick={e=>{if(e.target===e.currentTarget)setModal("");}}><section role="dialog" aria-modal="true" aria-labelledby="modal-title" className={"dialog "+(modal==="admin"?"wide":"")}><header><h2 id="modal-title">{{admin:"Administration",settings:"User settings",diagnostics:"Connection diagnostics",dm:"Direct message",help:"RaRRcord help"}[modal]}</h2><IconButton label="Close dialog" onClick={()=>setModal("")}><X size={20}/></IconButton></header>
      {modal==="settings"&&person&&<><UserSettings person={person} prefs={prefs} limit={limit} save={()=>{void refresh();void refreshAuth();setModal("");report(call?"Settings saved. Rejoin the call to apply media changes.":"Settings saved.");}} report={report}/><button className="signout" onClick={logout}>Sign out</button></>}
      {modal==="diagnostics"&&<Diagnostics call={call} latency={latency}/>}
      {modal==="admin"&&space&&<Admin space={space} server={server} report={report} refresh={refresh}/>}
      {modal==="dm"&&<form className="settings-form" onSubmit={async e=>{e.preventDefault();try{const result=await request<{id:string}>("dm",{users:dmUsers});await refresh();setSelected(result.id);setStage(false);setModal("");}catch(e){report((e as Error).message);}}}>
        {space?.people.filter(p=>p.id!==person?.id).map(p=><label className="inline" key={p.id}><input type="checkbox" checked={dmUsers.includes(p.id)} onChange={e=>setDmUsers(prev=>e.target.checked?[...prev,p.id]:prev.filter(id=>id!==p.id))}/>{p.name}</label>)}
        <button className="primary" disabled={!dmUsers.length}>Open conversation</button>
      </form>}
      {modal==="help"&&<div className="settings-form"><p>Select a text channel to send messages or a voice room to connect. Enable your microphone, camera or screen from the call controls.</p><p>Use Shift + Enter for a new line. Open User settings to configure capture and push to talk.</p><a href="/privacy">Privacy</a></div>}
    </section></div>}
  </div>;
}
function Attachment({message:m}:{message:Message}){
  const url="/api/ra/attachment?key="+encodeURIComponent(m.attachment??"");
  const [failed,setFailed]=useState(false);
  return <div className="attachment">{!failed&&/\.(png|gif|jpe?g|webp)$/i.test(m.filename??"")&&<img loading="lazy" src={url} alt={m.filename} onError={()=>setFailed(true)}/>}<a href={url+"&download=1"}>{m.filename??"Download attachment"}</a></div>;
}

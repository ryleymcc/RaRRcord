import { request, type Preferences } from "./ra-client";
import { microphoneConstraints, processVoice, type VoiceProcessor } from "./noise-suppression";
import { meter, prepareMeters, type SpeakingMeter } from "./speaking";
import { displayMediaOptions, encoderFrameRate, governFrameRate, previewTrack, probeEncoders, screenShareSettings, startGovernor, applyNativeCapture, videoCodecPreferences, type Governor } from "./screen-share";
export type Participant={uid:string;peer:string;name:string;cam:number;screen:number};
type Medium="voice"|"cam"|"screen";
type Wire={type:"description";value:RTCSessionDescriptionInit}|{type:"ice";value:RTCIceCandidateInit}|{type:"candidates";values:RTCIceCandidateInit[]}|{type:"subscribe";medium:Medium;active:boolean}|{type:"tracks";labels:Record<string,Medium>}|{type:"speaking";active:boolean};
export type Signal={id:number;sender:string;data:string};
export type Feed={key:string;peer:string;kind:Medium;stream:MediaStream};
type Link={
  remote:Participant;pc:RTCPeerConnection;making:boolean;ignoring:boolean;answering:boolean;
  outgoing:Promise<void>; localCandidates:RTCIceCandidateInit[]|null; trickle:RTCIceCandidateInit[]; trickleTimer?:number;
  candidates:RTCIceCandidateInit[]; senders:Map<Medium,RTCRtpSender[]>; wanted:Set<Medium>;
  watching:Set<Medium>; declined:Set<Medium>; incoming:Map<string,MediaStream>; labels:Record<string,Medium>;
  speaking:boolean; previous:Map<string,Record<string,number>>; retry:number;
};
export type Metrics={peer:string; stream?:string; name:string; connection:string; ice:string; gathering:string; direction:string; codec?:string; resolution?:string; fps?:number; bitrate?:number; targetBitrate?:number; rtt?:number; loss?:number; jitter?:number; dropped?:number; encoded?:number; decoded?:number; encodeMs?:number; decodeMs?:number; captureFps?:number; encoder?:string; decoder?:string; available?:number; limited?:string; route?:string};

export function codecs() {
  return [...new Set(RTCRtpSender.getCapabilities?.("video")?.codecs.map(c=>c.mimeType.split("/")[1]).filter(c=>["H264","VP8","VP9","AV1"].includes(c))??[])];
}
export class Call {
  private static microphoneCapture=Promise.resolve();
  channel:string;
  peer=crypto.randomUUID();
  signal=0;
  local=new Map<Medium,MediaStream>();
  links=new Map<string,Link>();
  participants:Participant[]=[];
  feeds:Feed[]=[];
  localSpeaking=false;
  // The last other person who spoke. Focus view keeps them in the large tile until someone else talks.
  focus:string|null=null;
  muted=false;
  deaf=false;
  context?:AudioContext;
  private localMeter?:SpeakingMeter;
  // What the meter hears on the outgoing voice; shown only while the mic is actually sending.
  private voiceHeard=false;
  // Mic → denoiser → voice gate. local.get("voice") holds its output; the device stream is kept here.
  private voice?:{raw:MediaStream;processor:VoiceProcessor};
  pressed=false;
  private closed=false;
  // Remote speaking is measured from each peer's incoming voice audio, so it needs no signaling.
  private ears?:AudioContext;
  private hearing=new Map<string,{stream:MediaStream;source:MediaStreamAudioSourceNode;meter?:SpeakingMeter;closed:boolean}>();
  private feedKeys="";
  private roster="";
  private starting=new Set<Medium>();
  // Which codecs this browser encodes smoothly (and in hardware) at the screen profile, probed before the share is published.
  private encoders:Awaited<ReturnType<typeof probeEncoders>>=[];
  // Until this time, polls run fast: a negotiation is under way and its answer is a poll away.
  private busyUntil=0;
  /** Called when a negotiation starts, so the page can poll right away instead of on its slow timer. */
  busy?:()=>void;
  // Lowers the share's frame rate when the encoder runs short of CPU, so the game on the same PC keeps its own.
  governor?:Governor;
  private governorTimer?:number;
  private encodeTotals=new Map<string,{time:number;frames:number}>();
  // A low-rate copy of your own screen for the self preview (see previewTrack).
  screenPreview?:MediaStream;
  constructor(channel:string,public prefs:Preferences,private screenBitrateLimit:number,public ice:RTCIceServer[],private changed:()=>void,private error:(message:string)=>void) {
    this.channel=channel;
    window.addEventListener("keydown",this.keydown);
    window.addEventListener("keyup",this.keyup);
    window.addEventListener("blur",this.release);
  }
  private keydown=(e:KeyboardEvent)=>{
    if (e.code===this.prefs.key && this.prefs.ptt && !(e.target instanceof HTMLElement && e.target.closest("input,textarea,select,[contenteditable]"))) {
      e.preventDefault(); this.pressed=true; this.micState();
    }
  };
  private keyup=(e:KeyboardEvent)=>{ if(e.code===this.prefs.key)this.release(); };
  private release=()=>{this.pressed=false;this.micState();};
  /** How long to wait before the next poll: fast while media is being negotiated, otherwise the normal in-call rate. */
  pollInterval(){return performance.now()<this.busyUntil?150:750;}
  private hurry(){
    const idle=performance.now()>=this.busyUntil;
    this.busyUntil=performance.now()+4000;
    if(idle)this.busy?.();
  }
  private send(target:string,data:Wire) {
    if(this.closed) return Promise.resolve();
    if(data.type==="description"||data.type==="candidates"||data.type==="subscribe")this.hurry();
    return request("signal",{channel:this.channel,peer:this.peer,target,data}).then(()=>{},e=>{
      if (data.type==="description") this.error(e.message);
    });
  }
  private sendNegotiation(link:Link,data:Extract<Wire,{type:"description"|"candidates"}>) {
    link.outgoing=link.outgoing.then(()=>this.send(link.remote.peer,data));
  }
  private async describe(link:Link) {
    const candidates:RTCIceCandidateInit[]=[];
    link.localCandidates=candidates;
    try {
      await link.pc.setLocalDescription();
      if(!link.pc.localDescription)return;
      this.sendNegotiation(link,{type:"description",value:link.pc.localDescription.toJSON()});
      if(candidates.length)this.sendNegotiation(link,{type:"candidates",values:candidates});
    } finally {
      link.localCandidates=null;
    }
  }
  async update(participants:Participant[], signals:Signal[]) {
    if(this.closed)return;
    const roster=JSON.stringify(participants);
    const rosterChanged=roster!==this.roster;
    this.roster=roster;
    this.participants=participants;
    const present=new Set(participants.map(p=>p.peer));
    for(const [id,link] of this.links) if(!present.has(id)) {link.pc.close();this.links.delete(id);}
    for(const remote of participants) {
      if(remote.peer===this.peer || this.links.has(remote.peer)) continue;
      this.create(remote);
    }
    if(signals.length)this.hurry();
    for(const event of signals) {
      this.signal=Math.max(this.signal,event.id);
      const link=this.links.get(event.sender);
      if(!link)continue;
      try {await this.receive(link,JSON.parse(event.data) as Wire);}
      catch {this.error("A peer could not negotiate media. Check the connection diagnostics.");}
    }
    for(const participant of participants){
      const link=this.links.get(participant.peer);
      if(!link)continue;
      // Cameras and screen shares open on their own. "Stop watching" holds until that share ends.
      // A share counts as on once its tracks arrive, even if this roster is older than the share.
      for(const medium of ["cam","screen"] as const){
        if(participant[medium] || this.receiving(link,medium)){
          if(!link.watching.has(medium) && !link.declined.has(medium)) this.watch(participant.peer,medium,true,false);
        }else{
          if(link.watching.has(medium)) this.watch(participant.peer,medium,false,false);
          link.declined.delete(medium);
        }
      }
      link.remote=participant;
    }
    // Most polls bring nothing new; only re-render the page when the roster or feeds changed.
    this.refresh(rosterChanged || signals.length>0);
  }
  private create(remote:Participant) {
    const pc=new RTCPeerConnection({iceServers:this.ice,iceTransportPolicy:this.prefs.hideIp?"relay":"all"});
    const link:Link={pc,remote,making:false,ignoring:false,answering:false,outgoing:Promise.resolve(),localCandidates:null,trickle:[],candidates:[],senders:new Map(),wanted:new Set(["voice","cam","screen"]),watching:new Set(["voice"]),declined:new Set(),incoming:new Map(),labels:{},speaking:false,previous:new Map(),retry:0};
    this.links.set(remote.peer,link);
    this.hurry();
    pc.onnegotiationneeded=async()=>{
      try {
        link.making=true;
        await this.describe(link);
      } catch { if(!this.closed) this.error("Media negotiation failed."); }
      finally {link.making=false;}
    };
    pc.onicecandidate=({candidate})=>{
      if(!candidate)return;
      const value=candidate.toJSON();
      if(link.localCandidates){link.localCandidates.push(value);return;}
      // Candidates come in bursts; send each burst as one request instead of one per candidate.
      link.trickle.push(value);
      if(link.trickleTimer===undefined)link.trickleTimer=window.setTimeout(()=>{
        link.trickleTimer=undefined;
        const values=link.trickle.splice(0);
        if(values.length && !this.closed)this.sendNegotiation(link,{type:"candidates",values});
      },25);
    };
    pc.oniceconnectionstatechange=()=>{
      if(pc.iceConnectionState==="failed" && link.retry++<3)pc.restartIce();
      if(pc.iceConnectionState==="connected"||pc.iceConnectionState==="completed"){
        link.retry=0;this.applyEncoding(link);
      }
      this.changed();
    };
    pc.onsignalingstatechange=()=>{if(pc.signalingState==="stable")this.applyEncoding(link);};
    pc.ontrack=event=>{
      for(const stream of event.streams)link.incoming.set(stream.id,stream);
      event.track.addEventListener("ended",()=>this.refresh());
      this.refresh();
    };
    this.publish(link,"voice");
  }
  private voiceStream(link:Link){
    return [...link.incoming].find(([id,stream])=>link.labels[id]==="voice"&&stream.getAudioTracks().some(t=>t.readyState==="live"))?.[1];
  }
  // Starts a speaking meter for each voice we receive and stops the ones that went away.
  private hear(){
    if(this.closed || typeof AudioContext==="undefined")return;
    if(!this.ears){
      try{this.ears=new AudioContext();prepareMeters(this.ears);}catch{return;}
    }
    const ears=this.ears;
    // Created outside a click, the context starts suspended; every poll tries again until the page has been used.
    if(ears.state==="suspended")void ears.resume().catch(()=>{});
    for(const [peer,ear] of this.hearing){
      const link=this.links.get(peer);
      if(link && this.voiceStream(link)===ear.stream)continue;
      this.deafen(peer);
      if(link?.speaking){link.speaking=false;this.changed();}
    }
    for(const [peer,link] of this.links){
      const stream=this.voiceStream(link);
      if(!stream || this.hearing.has(peer))continue;
      let source:MediaStreamAudioSourceNode;
      try{source=ears.createMediaStreamSource(stream);}catch{continue;}
      const ear:{stream:MediaStream;source:MediaStreamAudioSourceNode;meter?:SpeakingMeter;closed:boolean}={stream,source,closed:false};
      this.hearing.set(peer,ear);
      void meter(ears,source,this.prefs.sensitivity,speaking=>{
        if(ear.closed || link.speaking===speaking)return;
        link.speaking=speaking;
        if(speaking)this.focus=peer;
        this.changed();
      }).then(m=>{if(ear.closed)m.close();else ear.meter=m;},()=>{});
    }
  }
  private deafen(peer:string){
    const ear=this.hearing.get(peer);
    if(!ear)return;
    ear.closed=true;
    ear.meter?.close();
    try{ear.source.disconnect();}catch{/* already gone */}
    this.hearing.delete(peer);
  }
  private async receive(link:Link, data:Wire) {
    const pc=link.pc;
    if(data.type==="description"){
      const collision=data.value.type==="offer" && (link.making || (pc.signalingState!=="stable" && !link.answering));
      link.ignoring=this.peer<link.remote.peer && collision;
      if(link.ignoring){link.candidates=[];return;}
      link.answering=data.value.type==="answer";
      try{await pc.setRemoteDescription(data.value);}finally{link.answering=false;}
      for(const candidate of link.candidates.splice(0))await pc.addIceCandidate(candidate).catch(()=>{});
      if(data.value.type==="offer")await this.describe(link);
    }else if(data.type==="ice"||data.type==="candidates"){
      if(link.ignoring)return;
      for(const value of data.type==="ice"?[data.value]:Array.isArray(data.values)?data.values:[]){
        if(pc.remoteDescription) await pc.addIceCandidate(value).catch(()=>{});
        else link.candidates.push(value);
      }
    }else if(data.type==="subscribe"){
      if(!["cam","screen"].includes(data.medium))return;
      if(data.active)link.wanted.add(data.medium);
      else link.wanted.delete(data.medium);
      this.publish(link,data.medium);
    }else if(data.type==="tracks"){
      link.labels=data.labels;
      // A camera or screen arriving before the roster says it is on still opens straight away.
      for(const kind of Object.values(data.labels))if((kind==="cam"||kind==="screen")&&!link.declined.has(kind))link.watching.add(kind);
    }
    // "speaking" signals from older tabs are ignored: speaking is measured locally now.
  }
  private receiving(link:Link,medium:Medium){
    return [...link.incoming].some(([id,stream])=>link.labels[id]===medium&&stream.getTracks().some(t=>t.readyState==="live"));
  }
  private publish(link:Link, medium:Medium) {
    const current=link.senders.get(medium)??[];
    const tracks=link.wanted.has(medium)?this.local.get(medium)?.getTracks()??[]:[];
    // Already sending exactly this: a repeat subscribe must not cost a renegotiation.
    if(current.length===tracks.length && current.every((sender,i)=>sender.track===tracks[i]))return;
    for(const sender of link.senders.get(medium)??[])link.pc.removeTrack(sender);
    link.senders.delete(medium);
    const stream=this.local.get(medium);
    if(stream && link.wanted.has(medium)){
      const senders=stream.getTracks().map(track=>{
        const sender=link.pc.addTrack(track,stream);
        if(track.kind==="video"){
          const transceiver=link.pc.getTransceivers().find(t=>t.sender===sender);
          const supported=RTCRtpSender.getCapabilities?.("video")?.codecs??[];
          const selected=medium==="screen"?screenShareSettings(this.prefs,this.screenBitrateLimit).codec:this.prefs.codec;
          if(transceiver?.setCodecPreferences && selected!=="auto"){
            try{transceiver.setCodecPreferences(videoCodecPreferences(supported,selected,medium==="screen"?this.encoders:[]));}catch{}
          }
        }
        return sender;
      });
      link.senders.set(medium,senders);
    }
    // A mesh call runs one screen encoder per viewer, so a viewer joining or leaving changes every link's share.
    if(medium==="screen")for(const other of this.links.values())this.applyEncoding(other);
    else this.applyEncoding(link);
    const labels:Record<string,Medium>={};
    for(const [kind,source] of this.local) if(link.wanted.has(kind))labels[source.id]=kind;
    void this.send(link.remote.peer,{type:"tracks",labels});
  }
  private applyEncoding(link:Link){
    const screen=screenShareSettings(this.prefs,this.screenBitrateLimit);
    const viewers=[...this.links.values()].filter(l=>l.senders.get("screen")?.some(s=>s.track?.kind==="video")).length;
    for(const [medium,senders] of link.senders)for(const sender of senders){
      const track=sender.track;
      if(!track || medium==="voice")continue;
      const params=sender.getParameters();
      const encoding=params.encodings?.[0];
      if(!encoding)continue;
      if(track.kind==="audio"){
        // Shared game or video sound: give it music-grade Opus instead of the ~32 Kbps voice default.
        encoding.maxBitrate=128000;
      }else if(medium==="screen"){
        // Always set an explicit ceiling: with none, WebRTC's default for 1080p is a few Mbps,
        // which turns a 144 FPS share into a blurry low-resolution one.
        encoding.maxBitrate=screen.bitrateCap;
        encoding.maxFramerate=encoderFrameRate(screen,track.getSettings().frameRate,viewers,screen.adaptive?this.governor?.fps:undefined);
        encoding.priority="high";
        encoding.networkPriority="high";
        params.degradationPreference=screen.degradation;
      }else{
        encoding.maxBitrate=Math.min(this.screenBitrateLimit||Infinity,this.prefs.bitrate||8000)*1000;
        encoding.maxFramerate=30;
        params.degradationPreference=this.prefs.mode==="motion"?"maintain-framerate":"maintain-resolution";
      }
      void sender.setParameters(params).catch(()=>{});
    }
  }
  private refresh(force=true){
    this.hear();
    const feeds:Feed[]=[];
    for(const [peer,link] of this.links) for(const [id,stream] of link.incoming){
      const kind=link.labels[id];
      if(kind && link.watching.has(kind) && stream.getTracks().some(t=>t.readyState==="live"))feeds.push({key:id,kind,peer,stream});
    }
    const keys=feeds.map(f=>f.key+":"+f.kind+":"+f.peer).join(",");
    if(!force && keys===this.feedKeys)return;
    this.feedKeys=keys;
    this.feeds=feeds;
    this.changed();
  }
  watch(peer:string,medium:"screen"|"cam",active:boolean,chosen=true){
    const link=this.links.get(peer);
    if(!link)return;
    if(active)link.watching.add(medium);
    else link.watching.delete(medium);
    if(chosen){
      if(active)link.declined.delete(medium);
      else link.declined.add(medium);
    }
    // Everyone is sent every share up front, so only a choice to hide one (or show it again) goes back to the sender.
    // A share that simply ended needs no message: the sender stopped it.
    if(chosen||active)void this.send(peer,{type:"subscribe",medium,active});
    this.refresh();
  }
  watching(peer:string,medium:Medium){return !!this.links.get(peer)?.watching.has(medium);}
  speaking(peer:string){return peer===this.peer?this.localSpeaking:!!this.links.get(peer)?.speaking;}
  get microphonePending(){return this.starting.has("voice");}
  get microphoneActive(){return !this.muted&&!this.deaf&&(this.local.get("voice")?.getAudioTracks().some(track=>track.readyState==="live")??false);}
  setMuted(value:boolean){this.muted=value;this.micState();this.changed();}
  setDeaf(value:boolean){this.deaf=value;this.micState();this.changed();}
  private micState(){
    const sending=!this.muted&&!this.deaf&&(!this.prefs.ptt||this.pressed);
    for(const track of this.local.get("voice")?.getTracks()??[])track.enabled=sending;
    this.showLocalSpeaking();
  }
  private showLocalSpeaking(){
    const speaking=this.voiceHeard && !!this.local.get("voice")?.getAudioTracks().some(track=>track.enabled&&track.readyState==="live");
    if(speaking===this.localSpeaking)return;
    this.localSpeaking=speaking;
    this.changed();
  }
  startMicrophone(){
    if(this.closed || this.microphonePending || this.local.has("voice"))return Promise.resolve();
    this.starting.add("voice");
    // A browser permission prompt can outlive the call that opened it.
    const capture=Call.microphoneCapture.then(()=>this.capture("voice"));
    Call.microphoneCapture=capture.catch(()=>{});
    return capture;
  }
  async toggleMicrophone(){
    if(this.deaf || this.microphonePending || this.closed)return;
    this.setMuted(this.microphoneActive);
    if(!this.muted)await this.startMicrophone();
  }
  async toggle(kind:Medium) {
    if(this.starting.has(kind) || this.closed)return;
    if(this.local.has(kind)){await this.stop(kind);return;}
    if(kind==="voice"){await this.toggleMicrophone();return;}
    this.starting.add(kind);
    await this.capture(kind);
  }
  private async capture(kind:Medium) {
    try{
      if(this.closed)return;
      const prefs=this.prefs;
      const screen=screenShareSettings(prefs,this.screenBitrateLimit);
      const capture=navigator.mediaDevices;
      if(!capture || (kind==="screen" && !capture.getDisplayMedia))throw new Error("This browser or window does not support the requested capture. Open the Site in a regular browser tab.");
      // The probe runs alongside the picker: awaiting it first could cost the click's user activation.
      const offered=kind==="screen"?[...new Set(RTCRtpSender.getCapabilities?.("video")?.codecs.map(c=>c.mimeType).filter(m=>/\/(av1|vp9|h264|vp8)$/i.test(m))??[])]:[];
      const encoders=kind==="screen"?probeEncoders(screen.width,screen.height,screen.fps,screen.bitrateCap/1000,offered):undefined;
      let stream=kind==="screen"?await capture.getDisplayMedia(displayMediaOptions(screen)):
        await capture.getUserMedia(kind==="cam"?{video:{deviceId:prefs.camera?{exact:prefs.camera}:undefined,height:{ideal:720},frameRate:{ideal:30}}}:microphoneConstraints(prefs));
      const screenTrack=kind==="screen"?stream.getVideoTracks()[0]:undefined;
      if(screenTrack && screen.maximum)await applyNativeCapture(screenTrack,screen.fps).catch(()=>{});
      if(encoders)this.encoders=await encoders;
      if(this.closed){stream.getTracks().forEach(track=>track.stop());return;}
      if(kind==="voice" && !stream.getAudioTracks().some(track=>track.readyState==="live")){
        stream.getTracks().forEach(track=>track.stop());
        throw new Error("No working microphone was found. Check your input device in User settings.");
      }
      if(kind==="voice"){
        const raw=stream, processor=await processVoice(raw,prefs,prepareMeters);
        if(this.closed){processor.close();raw.getTracks().forEach(track=>track.stop());return;}
        this.voice={raw,processor};
        stream=processor.stream;
        if(processor.fallback)this.error(processor.fallback);
      }
      this.local.set(kind,stream);
      for(const track of stream.getTracks()) {
        if(track.kind==="video")track.contentHint=kind==="screen"?screen.hint:"motion";
        else if(kind==="screen")track.contentHint="music";
        track.addEventListener("ended",()=>{if(this.local.get(kind)===stream && (track.kind==="video"||kind==="voice"))void this.stop(kind);});
      }
      if(kind==="screen" && screenTrack){
        this.governor=screen.adaptive?startGovernor(screen.fps,this.encoders):undefined;
        if(this.governor && this.governor.fps<screen.fps)await this.limitCapture(screenTrack,this.governor.fps);
        if(this.governor)this.governorTimer=window.setInterval(()=>void this.govern(),2000);
        const preview=await previewTrack(screenTrack).catch(()=>undefined);
        this.screenPreview=preview?new MediaStream([preview]):undefined;
      }
      this.micState();
      if(kind==="voice")this.meterVoice(stream);
      for(const link of this.links.values())this.publish(link,kind);
      if(kind!=="voice")await this.announce();
    }catch(error){
      if(this.closed)return;
      if(kind==="voice" && this.local.has(kind))await this.stop(kind);
      else if(kind==="voice")this.releaseVoice();
      const name=error instanceof DOMException?error.name:"";
      if(name==="NotAllowedError")this.error("Capture permission was declined or blocked. Check your browser’s site permissions.");
      else if(kind==="voice" && (name==="NotFoundError" || name==="OverconstrainedError"))this.error("The selected microphone is unavailable. Check your input device in User settings.");
      else this.error(error instanceof Error?error.message:"Could not start capture.");
    }finally{this.starting.delete(kind);if(!this.closed)this.changed();}
  }
  private async stop(kind:Medium) {
    const stream=this.local.get(kind);
    this.local.delete(kind);
    stream?.getTracks().forEach(track=>track.stop());
    if(kind==="voice"){this.stopMeter();this.releaseVoice();}
    if(kind==="screen")this.stopScreenExtras();
    for(const link of this.links.values()){
      this.publish(link,kind);
      // Someone who hid this share sees the next one again, as on their side.
      link.wanted.add(kind);
    }
    if(kind!=="voice")await this.announce();
    this.changed();
  }
  private stopScreenExtras(){
    window.clearInterval(this.governorTimer);
    this.governorTimer=undefined;
    this.governor=undefined;
    this.encodeTotals.clear();
    this.screenPreview?.getTracks().forEach(track=>track.stop());
    this.screenPreview=undefined;
  }
  private async limitCapture(track:MediaStreamTrack,fps:number){
    // Asking the capturer itself for fewer frames saves the copy and scale work too, not only the encode.
    await track.applyConstraints({...track.getConstraints(),frameRate:{ideal:fps,max:fps}}).catch(()=>{});
  }
  private async govern(){
    const track=this.local.get("screen")?.getVideoTracks()[0];
    const state=this.governor;
    if(!track || !state || this.closed)return;
    let cpuLimited=false, software=false, worst:number|undefined, measured=false;
    for(const link of this.links.values())for(const sender of link.senders.get("screen")??[]){
      if(sender.track?.kind!=="video")continue;
      const stats=await sender.getStats().catch(()=>undefined);
      stats?.forEach((s:Record<string,unknown>)=>{
        if(s.type!=="outbound-rtp")return;
        measured=true;
        if(s.qualityLimitationReason==="cpu")cpuLimited=true;
        if(s.powerEfficientEncoder===false)software=true;
        const time=Number(s.totalEncodeTime), frames=Number(s.framesEncoded), id=String(s.id);
        const before=this.encodeTotals.get(id);
        this.encodeTotals.set(id,{time,frames});
        if(before && frames>before.frames)worst=Math.max(worst??0,1000*(time-before.time)/(frames-before.frames));
      });
    }
    // No one is watching: nothing is encoded, so there is nothing to judge.
    if(!measured || this.governor!==state)return;
    const next=governFrameRate(state,{cpuLimited,software,encodeMs:worst},Date.now());
    this.governor=next;
    if(next.fps===state.fps)return;
    await this.limitCapture(track,next.fps);
    for(const link of this.links.values())this.applyEncoding(link);
    this.changed();
  }
  private announce(){return request("voice",{action:"media",channel:this.channel,peer:this.peer,cam:this.local.has("cam"),screen:this.local.has("screen")}).catch(e=>this.error(e.message));}
  private releaseVoice(){
    if(!this.voice)return;
    this.voice.processor.close();
    this.voice.raw.getTracks().forEach(track=>track.stop());
    this.voice=undefined;
  }
  private meterVoice(stream:MediaStream){
    // Measure what is actually sent (after the denoiser and voice gate), so typing the gate removes does not light the ring.
    const processor=this.voice?.processor;
    let context:AudioContext, source:AudioNode;
    try{
      if(processor?.context && processor.output){context=processor.context;source=processor.output;}
      else{context=this.context=new AudioContext();source=context.createMediaStreamSource(stream);}
      void context.resume().catch(()=>{});
    }catch{return;}
    void meter(context,source,this.prefs.sensitivity,speaking=>{
      if(this.local.get("voice")!==stream)return;
      this.voiceHeard=speaking;
      this.showLocalSpeaking();
    }).then(m=>{if(this.local.get("voice")===stream && !this.closed)this.localMeter=m;else m.close();},()=>{});
  }
  private stopMeter(){
    this.localMeter?.close();
    this.localMeter=undefined;
    if(this.context)void this.context.close().catch(()=>{});
    this.context=undefined;
    this.voiceHeard=false;
    this.localSpeaking=false;
  }
  async metrics():Promise<Metrics[]>{
    const result:Metrics[]=[];
    for(const link of this.links.values()){
      const stats=await link.pc.getStats();
      const rows:Record<string,any>[]=[];
      stats.forEach(s=>rows.push(s));
      const transport=rows.find(s=>s.type==="transport");
      const pair=rows.find(s=>s.id===transport?.selectedCandidatePairId)??rows.find(s=>s.type==="candidate-pair"&&s.nominated&&s.state==="succeeded");
      const route=[pair?.localCandidateId,pair?.remoteCandidateId].map(id=>rows.find(s=>s.id===id)?.candidateType);
      const base={peer:link.remote.peer,name:link.remote.name,connection:link.pc.connectionState,ice:link.pc.iceConnectionState,gathering:link.pc.iceGatheringState,
        route:pair?(route.includes("relay")?"Relayed":"Direct"):undefined,rtt:pair?.currentRoundTripTime===undefined?undefined:pair.currentRoundTripTime*1000,available:pair?.availableOutgoingBitrate===undefined?undefined:pair.availableOutgoingBitrate/1000};
      const streams=rows.filter(s=>s.type==="outbound-rtp"||s.type==="inbound-rtp");
      if(!streams.length)result.push({...base,direction:"Waiting for media"});
      for(const s of streams){
        const out=s.type==="outbound-rtp";
        const at=s.timestamp, bytes=s.bytesSent??s.bytesReceived, frames=s.framesEncoded??s.framesDecoded, lost=s.packetsLost;
        const before=link.previous.get(s.id);
        const elapsed=before?(at-before.at)/1000:0;
        const delta=(value:number, previous:number)=>elapsed>0 && Number.isFinite(value) && Number.isFinite(previous) && value>=previous?value-previous:undefined;
        const frameDelta=before?delta(frames,before.frames):undefined;
        const byteDelta=before?delta(bytes,before.bytes):undefined;
        const lostDelta=before?delta(lost,before.lost):undefined;
        const packetsDelta=before?delta(s.packetsReceived,before.packets):undefined;
        const time=s.totalEncodeTime??s.totalDecodeTime;
        const timeDelta=before?delta(time,before.time):undefined;
        link.previous.set(s.id,{at,bytes,frames,lost,time,packets:s.packetsReceived});
        result.push({...base,stream:s.id,direction:(out?"Sending ":"Receiving ")+(s.kind??"media"),
          codec:rows.find(x=>x.id===s.codecId)?.mimeType,resolution:s.frameWidth&&s.frameHeight?s.frameWidth+"×"+s.frameHeight:undefined,
          fps:frameDelta===undefined?undefined:frameDelta/elapsed,bitrate:byteDelta===undefined?undefined:8*byteDelta/elapsed/1000,
          targetBitrate:typeof s.targetBitrate==="number"?s.targetBitrate/1000:undefined,
          jitter:s.jitter===undefined?undefined:s.jitter*1000,loss:lostDelta===undefined||packetsDelta===undefined||packetsDelta+lostDelta===0?undefined:lostDelta*100/(packetsDelta+lostDelta),
          dropped:s.framesDropped,encoded:s.framesEncoded,decoded:s.framesDecoded,limited:s.qualityLimitationReason,
          encodeMs:out&&timeDelta!==undefined&&frameDelta?1000*timeDelta/frameDelta:undefined,
          decodeMs:!out&&timeDelta!==undefined&&frameDelta?1000*timeDelta/frameDelta:undefined,
          captureFps:out&&s.kind==="video"?rows.find(x=>x.id===s.mediaSourceId)?.framesPerSecond:undefined,
          encoder:out&&s.encoderImplementation?s.encoderImplementation+(s.powerEfficientEncoder===true?" · hardware":s.powerEfficientEncoder===false?" · software":""):undefined,
          decoder:!out&&s.decoderImplementation?s.decoderImplementation+(s.powerEfficientDecoder===true?" · hardware":s.powerEfficientDecoder===false?" · software":""):undefined});
      }
    }
    return result;
  }
  close(){
    if(this.closed)return;
    this.closed=true;
    window.removeEventListener("keydown",this.keydown);
    window.removeEventListener("keyup",this.keyup);
    window.removeEventListener("blur",this.release);
    this.stopMeter();
    this.releaseVoice();
    for(const peer of [...this.hearing.keys()])this.deafen(peer);
    if(this.ears)void this.ears.close().catch(()=>{});
    this.ears=undefined;
    this.stopScreenExtras();
    for(const stream of this.local.values())stream.getTracks().forEach(track=>track.stop());
    for(const link of this.links.values())link.pc.close();
    this.links.clear();this.local.clear();
    void request("voice",{action:"leave",channel:this.channel,peer:this.peer}).catch(()=>{});
  }
}

export class VoiceSession {
  call:Call|null=null;
  private target:{channel:string}|null=null;
  private joining=Promise.resolve();
  constructor(private changed:(call:Call|null)=>void,private updated:()=>void,private error:(message:string)=>void){}

  private onBusy?:()=>void;
  /** Sets what runs when a call starts negotiating media, so the page can poll at once. */
  whenBusy(handler:()=>void){this.onBusy=handler;}
  join(channel:string,prefs:Preferences,limit:number){
    if(this.target?.channel===channel)return this.joining;
    if(this.call?.channel===channel){this.target=null;return this.joining;}
    if(typeof RTCPeerConnection==="undefined"){this.error("WebRTC is unavailable in this browser.");return Promise.resolve();}
    const target={channel};
    this.target=target;
    // The server stores one room per user, so join requests must arrive in order.
    this.joining=this.joining.then(async()=>{
      let call:Call|undefined;
      try{
        if(this.target!==target)return;
        const ice=iceServers();
        if(prefs.hideIp && !(await ice).relay)throw new Error("Hide my IP needs a TURN relay, and this server has none. Ask an admin to set one up, or turn the setting off in User settings.");
        if(this.target!==target)return;
        this.closeCall();
        call=new Call(channel,prefs,limit,[],this.updated,this.error);
        // ICE servers were usually fetched when the app loaded, so this is one round trip: the join itself.
        // The microphone opens only once the room accepts you, so a refused or superseded join never turns it on.
        const [servers]=await Promise.all([ice,request("voice",{action:"join",channel,peer:call.peer})]);
        if(this.target!==target){call.close();return;}
        call.ice=servers.servers;
        const live=call;
        call.busy=()=>{if(this.call===live)this.onBusy?.();};
        this.call=call;
        this.changed(call);
        void call.startMicrophone();
      }catch(error){
        call?.close();
        if(this.target===target)this.error(error instanceof Error?error.message:"Could not join the voice room.");
      }finally{if(this.target===target)this.target=null;}
    });
    return this.joining;
  }

  disconnect(){this.target=null;this.closeCall();}

  ended(call:Call){if(this.call===call)this.closeCall();}

  private closeCall(){
    if(!this.call)return;
    this.call.close();
    this.call=null;
    this.changed(null);
  }
}

// ICE servers (STUN, plus TURN credentials when the server has a relay). Fetching TURN credentials costs the
// server a call to Cloudflare, so the answer is fetched once ahead of time and reused for a few minutes.
type IceAnswer={servers:RTCIceServer[];relay?:boolean};
let iceCache:{at:number;value:Promise<IceAnswer>}|undefined;
export function iceServers(){
  if(!iceCache||performance.now()-iceCache.at>5*60_000){
    const value=request<IceAnswer>("ice");
    const entry={at:performance.now(),value};
    iceCache=entry;
    value.catch(()=>{if(iceCache===entry)iceCache=undefined;});
  }
  return iceCache.value;
}

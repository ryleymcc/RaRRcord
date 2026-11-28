import { request, type Preferences } from "./ra-client";
import { microphoneConstraints, processVoice, type VoiceProcessor } from "./noise-suppression";
import { screenShareSettings, useNativeCapture, videoCodecPreferences } from "./screen-share";
export type Participant={uid:string;peer:string;name:string;cam:number;screen:number};
type Medium="voice"|"cam"|"screen";
type Wire={type:"description";value:RTCSessionDescriptionInit}|{type:"ice";value:RTCIceCandidateInit}|{type:"subscribe";medium:Medium;active:boolean}|{type:"tracks";labels:Record<string,Medium>}|{type:"speaking";active:boolean};
export type Signal={id:number;sender:string;data:string};
export type Feed={key:string;peer:string;kind:Medium;stream:MediaStream};
type Link={
  remote:Participant;pc:RTCPeerConnection;making:boolean;ignoring:boolean;answering:boolean;
  outgoing:Promise<void>; localCandidates:RTCIceCandidateInit[]|null;
  candidates:RTCIceCandidateInit[]; senders:Map<Medium,RTCRtpSender[]>; wanted:Set<Medium>;
  watching:Set<Medium>; declined:Set<Medium>; incoming:Map<string,MediaStream>; labels:Record<string,Medium>;
  speaking:boolean; previous:Map<string,Record<string,number>>; retry:number;
};
export type Metrics={peer:string; stream?:string; name:string; connection:string; ice:string; gathering:string; direction:string; codec?:string; resolution?:string; fps?:number; bitrate?:number; targetBitrate?:number; rtt?:number; loss?:number; jitter?:number; dropped?:number; encoded?:number; decoded?:number; encodeMs?:number; decodeMs?:number; available?:number; limited?:string; route?:string};

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
  muted=false;
  deaf=false;
  context?:AudioContext;
  meter?:number;
  // Mic → denoiser → voice gate. local.get("voice") holds its output; the device stream is kept here.
  private voice?:{raw:MediaStream;processor:VoiceProcessor};
  pressed=false;
  private closed=false;
  // Remote speaking is measured from each peer's incoming voice audio, so it needs no signaling.
  private ears?:AudioContext;
  private earTimer?:number;
  private hearing=new Map<string,{stream:MediaStream;analyser:AnalyserNode;source:MediaStreamAudioSourceNode;silent:number}>();
  private feedKeys="";
  private roster="";
  private starting=new Set<Medium>();
  constructor(channel:string,public prefs:Preferences,private screenBitrateLimit:number,private ice:RTCIceServer[],private changed:()=>void,private error:(message:string)=>void) {
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
  private send(target:string,data:Wire) {
    if(this.closed) return Promise.resolve();
    return request("signal",{channel:this.channel,peer:this.peer,target,data}).then(()=>{},e=>{
      if (data.type==="description") this.error(e.message);
    });
  }
  private sendNegotiation(link:Link,data:Extract<Wire,{type:"description"|"ice"}>) {
    link.outgoing=link.outgoing.then(()=>this.send(link.remote.peer,data));
  }
  private async describe(link:Link) {
    const candidates:RTCIceCandidateInit[]=[];
    link.localCandidates=candidates;
    try {
      await link.pc.setLocalDescription();
      if(!link.pc.localDescription)return;
      this.sendNegotiation(link,{type:"description",value:link.pc.localDescription.toJSON()});
      for(const value of candidates)this.sendNegotiation(link,{type:"ice",value});
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
      for(const medium of ["cam","screen"] as const){
        if(participant[medium]){
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
    const pc=new RTCPeerConnection({iceServers:this.ice});
    const link:Link={pc,remote,making:false,ignoring:false,answering:false,outgoing:Promise.resolve(),localCandidates:null,candidates:[],senders:new Map(),wanted:new Set(["voice"]),watching:new Set(["voice"]),declined:new Set(),incoming:new Map(),labels:{},speaking:false,previous:new Map(),retry:0};
    this.links.set(remote.peer,link);
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
      if(link.localCandidates)link.localCandidates.push(value);
      else this.sendNegotiation(link,{type:"ice",value});
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
    this.listen();
  }
  private listen(){
    if(this.earTimer!==undefined || this.closed || typeof AudioContext==="undefined")return;
    try{this.ears=new AudioContext();void this.ears.resume();}catch{return;}
    const samples=new Uint8Array(512);
    this.earTimer=window.setInterval(()=>{
      const ears=this.ears;
      if(!ears)return;
      if(ears.state==="suspended")void ears.resume().catch(()=>{});
      let changed=false;
      for(const [peer,ear] of this.hearing)if(!this.links.has(peer)){ear.source.disconnect();this.hearing.delete(peer);}
      for(const [peer,link] of this.links){
        const stream=[...link.incoming].find(([id,s])=>link.labels[id]==="voice"&&s.getAudioTracks().length>0)?.[1];
        let ear=this.hearing.get(peer);
        if(ear && ear.stream!==stream){ear.source.disconnect();this.hearing.delete(peer);ear=undefined;}
        if(!ear && stream){
          try{
            const analyser=ears.createAnalyser();
            analyser.fftSize=samples.length;
            const source=ears.createMediaStreamSource(stream);
            source.connect(analyser);
            ear={stream,analyser,source,silent:0};
            this.hearing.set(peer,ear);
          }catch{continue;}
        }
        let talking=false;
        if(ear){
          ear.analyser.getByteTimeDomainData(samples);
          const rms=Math.sqrt(samples.reduce((sum,n)=>sum+((n-128)/128)**2,0)/samples.length);
          talking=rms>this.prefs.sensitivity/100;
          if(talking)ear.silent=0;else ear.silent++;
          if(!talking&&ear.silent<3)continue;
        }
        if(talking!==link.speaking){link.speaking=talking;changed=true;}
      }
      if(changed)this.changed();
    },200);
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
    }else if(data.type==="ice"){
      if(link.ignoring)return;
      if(pc.remoteDescription) await pc.addIceCandidate(data.value);
      else link.candidates.push(data.value);
    }else if(data.type==="subscribe"){
      if(!["cam","screen"].includes(data.medium))return;
      if(data.active)link.wanted.add(data.medium);
      else link.wanted.delete(data.medium);
      this.publish(link,data.medium);
    }else if(data.type==="tracks"){
      link.labels=data.labels;
    }
    // "speaking" signals from older tabs are ignored: speaking is measured locally now.
  }
  private publish(link:Link, medium:Medium) {
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
            try{transceiver.setCodecPreferences(videoCodecPreferences(supported,selected));}catch{}
          }
        }
        return sender;
      });
      link.senders.set(medium,senders);
    }
    const labels:Record<string,Medium>={};
    for(const [kind,source] of this.local) if(link.wanted.has(kind))labels[source.id]=kind;
    void this.send(link.remote.peer,{type:"tracks",labels});
  }
  private applyEncoding(link:Link){
    const screen=screenShareSettings(this.prefs,this.screenBitrateLimit);
    for(const [medium,senders] of link.senders)for(const sender of senders){
      if(sender.track?.kind!=="video")continue;
      const params=sender.getParameters();
      const encoding=params.encodings?.[0];
      if(!encoding)continue;
      if(medium==="screen"){
        if(screen.bitrateCap===undefined)delete encoding.maxBitrate;
        else encoding.maxBitrate=screen.bitrateCap;
        if(screen.frameRateCap===undefined)delete encoding.maxFramerate;
        else encoding.maxFramerate=screen.frameRateCap;
        params.degradationPreference=screen.hint==="detail"?"maintain-resolution":"maintain-framerate";
      }else{
        encoding.maxBitrate=Math.min(this.screenBitrateLimit||Infinity,this.prefs.bitrate||8000)*1000;
        encoding.maxFramerate=30;
        params.degradationPreference=this.prefs.mode==="motion"?"maintain-framerate":"maintain-resolution";
      }
      void sender.setParameters(params).catch(()=>{});
    }
  }
  private refresh(force=true){
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
    void this.send(peer,{type:"subscribe",medium,active});
    this.refresh();
  }
  watching(peer:string,medium:Medium){return !!this.links.get(peer)?.watching.has(medium);}
  speaking(peer:string){return peer===this.peer?this.localSpeaking:!!this.links.get(peer)?.speaking;}
  get microphonePending(){return this.starting.has("voice");}
  get microphoneActive(){return !this.muted&&!this.deaf&&(this.local.get("voice")?.getAudioTracks().some(track=>track.readyState==="live")??false);}
  setMuted(value:boolean){this.muted=value;this.micState();this.changed();}
  setDeaf(value:boolean){this.deaf=value;this.micState();this.changed();}
  private micState(){for(const track of this.local.get("voice")?.getTracks()??[])track.enabled=!this.muted&&!this.deaf&&(!this.prefs.ptt||this.pressed);}
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
      let stream=kind==="screen"?await capture.getDisplayMedia({video:screen.capture,audio:true}):
        await capture.getUserMedia(kind==="cam"?{video:{deviceId:prefs.camera?{exact:prefs.camera}:undefined,height:{ideal:720},frameRate:{ideal:30}}}:microphoneConstraints(prefs));
      const screenTrack=kind==="screen"?stream.getVideoTracks()[0]:undefined;
      if(screenTrack && screen.maximum)await useNativeCapture(screenTrack).catch(()=>{});
      if(this.closed){stream.getTracks().forEach(track=>track.stop());return;}
      if(kind==="voice" && !stream.getAudioTracks().some(track=>track.readyState==="live")){
        stream.getTracks().forEach(track=>track.stop());
        throw new Error("No working microphone was found. Check your input device in User settings.");
      }
      if(kind==="voice"){
        const raw=stream, processor=await processVoice(raw,prefs);
        if(this.closed){processor.close();raw.getTracks().forEach(track=>track.stop());return;}
        this.voice={raw,processor};
        stream=processor.stream;
        if(processor.fallback)this.error(processor.fallback);
      }
      this.local.set(kind,stream);
      for(const track of stream.getTracks()) {
        if(track.kind==="video")track.contentHint=kind==="screen"?screen.hint:"motion";
        track.addEventListener("ended",()=>{if(this.local.get(kind)===stream && (track.kind==="video"||kind==="voice"))void this.stop(kind);});
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
    for(const link of this.links.values())this.publish(link,kind);
    if(kind!=="voice")await this.announce();
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
    try{
      // Measure what is actually sent, so typing that the gate removes does not light up the speaking ring.
      const processor=this.voice?.processor;
      const shared=processor?.context && processor.output;
      const context=shared?processor.context!:(this.context=new AudioContext());
      void context.resume();
      const analyser=context.createAnalyser();
      analyser.fftSize=512;
      if(shared)processor.output!.connect(analyser);
      else context.createMediaStreamSource(stream).connect(analyser);
      const samples=new Uint8Array(analyser.fftSize);
      let silent=0;
      this.meter=window.setInterval(()=>{
        analyser.getByteTimeDomainData(samples);
        const rms=Math.sqrt(samples.reduce((sum,n)=>sum+((n-128)/128)**2,0)/samples.length);
        const talking=rms>this.prefs.sensitivity/100 && !!stream.getAudioTracks()[0]?.enabled;
        if(talking)silent=0;else silent++;
        if((talking||silent>=3)&&talking!==this.localSpeaking){
          this.localSpeaking=talking;
          this.changed();
        }
      },200);
    }catch{}
  }
  private stopMeter(){
    window.clearInterval(this.meter);
    if(this.context)void this.context.close().catch(()=>{});
    this.context=undefined;
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
          decodeMs:!out&&timeDelta!==undefined&&frameDelta?1000*timeDelta/frameDelta:undefined});
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
    window.clearInterval(this.earTimer);
    for(const ear of this.hearing.values())ear.source.disconnect();
    this.hearing.clear();
    if(this.ears)void this.ears.close().catch(()=>{});
    this.ears=undefined;
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

  join(channel:string,prefs:Preferences,limit:number){
    if(this.target?.channel===channel)return this.joining;
    if(this.call?.channel===channel){this.target=null;return this.joining;}
    if(typeof RTCPeerConnection==="undefined"){this.error("WebRTC is unavailable in this browser.");return Promise.resolve();}
    const target={channel};
    this.target=target;
    // The server stores one room per user, so join requests must arrive in order.
    this.joining=this.joining.then(async()=>{
      try{
        if(this.target!==target)return;
        const ice=await request<{servers:RTCIceServer[]}>("ice");
        if(this.target!==target)return;
        this.closeCall();
        const call=new Call(channel,prefs,limit,ice.servers,this.updated,this.error);
        try{
          await request("voice",{action:"join",channel,peer:call.peer});
          if(this.target!==target){call.close();return;}
        }catch(error){call.close();throw error;}
        this.call=call;
        this.changed(call);
        void call.startMicrophone();
      }catch(error){
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

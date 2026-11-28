// Talking indicators. One meter per voice, run on the audio thread by public/voice/speaking-meter-worklet.js,
// so the ring lights within about 30 ms of a word and the page is only told when the state changes.

// The "Speaking sensitivity" slider (1-30): higher needs a louder voice. 3, the default, is about -55 dB in the speech band,
// low enough for a quiet talker. A voice also has to rise 12 dB above its own background noise, which the meter tracks.
export function sensitivityDb(sensitivity:number){
  const value=Number.isFinite(sensitivity)?Math.min(30,Math.max(1,sensitivity)):3;
  return -58+(value-1)*1.4;
}

export type SpeakingMeter={setSensitivity(sensitivity:number):void;close():void};

const moduleUrl="/voice/speaking-meter-worklet.js";
const modules=new WeakMap<BaseAudioContext,Promise<void>>();
function load(context:BaseAudioContext){
  let pending=modules.get(context);
  if(!pending){
    pending=context.audioWorklet.addModule(moduleUrl);
    pending.catch(()=>modules.delete(context));
    modules.set(context,pending);
  }
  return pending;
}
/** Starts loading the meter into a context ahead of time, so the first meter starts at once. */
export function prepareMeters(context:BaseAudioContext){
  if(typeof AudioWorkletNode!=="undefined")void load(context).catch(()=>{});
}

/** Measures `source` and calls `changed` each time talking starts or stops. */
export async function meter(context:BaseAudioContext,source:AudioNode,sensitivity:number,changed:(speaking:boolean)=>void):Promise<SpeakingMeter>{
  if(typeof AudioWorkletNode!=="undefined"){
    try{
      await load(context);
      const node=new AudioWorkletNode(context,"rarrcord-speaking-meter",{numberOfInputs:1,numberOfOutputs:0,channelCount:1,channelCountMode:"explicit",processorOptions:{minDb:sensitivityDb(sensitivity)}});
      node.port.onmessage=event=>{if(typeof event.data?.speaking==="boolean")changed(event.data.speaking);};
      source.connect(node);
      return {
        setSensitivity(value){node.port.postMessage({minDb:sensitivityDb(value)});},
        close(){try{source.disconnect(node);}catch{/* already gone */}node.port.onmessage=null;},
      };
    }catch{/* fall back to the main-thread meter */}
  }
  return analyserMeter(context,source,sensitivity,changed);
}

// Older browsers without AudioWorklet: a 43 ms float window read every 50 ms.
function analyserMeter(context:BaseAudioContext,source:AudioNode,sensitivity:number,changed:(speaking:boolean)=>void):SpeakingMeter{
  const analyser=context.createAnalyser();
  analyser.fftSize=2048;
  source.connect(analyser);
  const samples=new Float32Array(analyser.fftSize);
  let minDb=sensitivityDb(sensitivity),speaking=false,quiet=0;
  const timer=setInterval(()=>{
    analyser.getFloatTimeDomainData(samples);
    let sum=0;for(const x of samples)sum+=x*x;
    const db=10*Math.log10(sum/samples.length+1e-12);
    if(db>minDb){quiet=0;if(!speaking){speaking=true;changed(true);}}
    else if(speaking&&++quiet>=5){speaking=false;changed(false);}
  },50);
  return {setSensitivity(value){minDb=sensitivityDb(value);},close(){clearInterval(timer);try{source.disconnect(analyser);}catch{/* already gone */}}};
}

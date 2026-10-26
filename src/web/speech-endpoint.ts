export type SpeechEndpointResult = 'end' | 'no-speech';
export type SpeechEndpointOptions = {
 threshold?:number;
 minimumSpeechMs?:number;
 silenceMs?:number;
 noSpeechMs?:number;
 maximumMs?:number;
};

/** RMS-based pause detection only; this does not infer semantic completeness. */
export class SpeechEndpoint {
 private readonly options:Required<SpeechEndpointOptions>;
 private readonly adaptive:boolean;
 private ambient:number|undefined;
 private calibrationMs=0;
 private started=0;
 private previous=0;
 private previousVoiced=false;
 private speechMs=0;
 private lastVoice=0;
 private heardSpeech=false;
 private finished=false;

 constructor(options:SpeechEndpointOptions={}){
  this.adaptive=options.threshold===undefined;
  this.options={threshold:.015,minimumSpeechMs:this.adaptive?160:300,silenceMs:1800,noSpeechMs:20000,maximumMs:90000,...options};
 }

 reset(timeMs=0):void {
  this.started=timeMs;this.previous=timeMs;this.previousVoiced=false;
  this.speechMs=0;this.lastVoice=timeMs;this.heardSpeech=false;this.finished=false;this.ambient=undefined;this.calibrationMs=0;
 }

 update(timeMs:number,rms:number):SpeechEndpointResult|undefined {
  if(this.finished||!Number.isFinite(timeMs)||timeMs<this.previous)return;
  const valid=Number.isFinite(rms)&&rms>=0;
  const gap=timeMs-this.previous;
  // Meter windows arrive every ~20 ms. Never infer voice across missing windows.
  const elapsed=gap<=250?Math.min(gap,50):0;
  if(gap>250)this.previousVoiced=false;
  let threshold=this.options.threshold;
  let calibrated=true;
  if(this.adaptive){
   if(valid){
    if(this.ambient===undefined)this.ambient=rms;
    if(this.calibrationMs<120){
     this.ambient=Math.min(this.ambient,rms);this.calibrationMs+=elapsed;
     calibrated=false;
    }else{
     threshold=Math.max(.0015,this.ambient*2.5+.0005);
     // Follow background slowly, only below the speech boundary. Voice must
     // not raise its own threshold; quiet windows can lower the noise floor.
     if(rms<threshold)this.ambient+=Math.min(1,elapsed/(rms<this.ambient?300:3000))*(rms-this.ambient);
    }
   }else calibrated=false;
  }
  const voiced=valid&&calibrated&&rms>=threshold;
  if(voiced){
   if(timeMs-this.lastVoice>200&&!this.heardSpeech)this.speechMs=0;
   if(this.previousVoiced)this.speechMs+=elapsed;
   this.lastVoice=timeMs;
   if(this.speechMs>=this.options.minimumSpeechMs)this.heardSpeech=true;
  }
  this.previous=timeMs;this.previousVoiced=voiced;
  let result:SpeechEndpointResult|undefined;
  if(this.heardSpeech&&(!voiced&&timeMs-this.lastVoice>=this.options.silenceMs||timeMs-this.started>=this.options.maximumMs))result='end';
  else if(!this.heardSpeech&&timeMs-this.started>=Math.min(this.options.noSpeechMs,this.options.maximumMs))result='no-speech';
  if(result)this.finished=true;
  return result;
 }
}

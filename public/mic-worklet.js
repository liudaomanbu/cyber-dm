class MicrophoneProcessor extends AudioWorkletProcessor {
 constructor(){super();this.buffer=[];this.position=0;}
 process(inputs){
  const input=inputs[0]?.[0];if(!input)return true;
  for(let i=0;i<input.length;i++){
   this.position+=16000;
   if(this.position>=sampleRate){this.position-=sampleRate;this.buffer.push(Math.max(-1,Math.min(1,input[i])));}
  }
  while(this.buffer.length>=320){const pcm=new Int16Array(320);for(let i=0;i<320;i++)pcm[i]=this.buffer[i]*32767;this.buffer.splice(0,320);this.port.postMessage(pcm.buffer,[pcm.buffer]);}
  return true;
 }
}
registerProcessor('microphone',MicrophoneProcessor);

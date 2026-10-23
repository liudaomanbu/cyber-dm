class MicrophoneProcessor extends AudioWorkletProcessor {
  constructor(){
    super();
    this.buffer=[];
    this.phase=0;
  }

  process(inputs){
    const input=inputs[0]?.[0];
    if(!input)return true;
    const step=sampleRate/16000;
    for(let i=0;i<input.length;i++){
      this.phase+=1;
      if(this.phase>=step){
        this.phase-=step;
        const sample=Math.max(-1,Math.min(1,input[i]));
        this.buffer.push(sample);
      }
    }
    while(this.buffer.length>=320){
      const pcm=new Int16Array(320);
      for(let i=0;i<320;i++)pcm[i]=Math.max(-32768,Math.min(32767,Math.round(this.buffer[i]*32767)));
      this.buffer.splice(0,320);
      this.port.postMessage(pcm.buffer,[pcm.buffer]);
    }
    return true;
  }
}
registerProcessor('microphone',MicrophoneProcessor);

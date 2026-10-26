import type {Config} from './store.js';
import {LinxSpeech} from './linx-speech.js';

/** Buffered compatibility/export path. Interactive playback uses LinxSpeech directly. */
export async function synthesizePreview(config:Config,voiceId:string,text:string,signal?:AbortSignal):Promise<Buffer>{
 const speech=new LinxSpeech(config);const frames:Buffer[]=[];let rate=16000;
 try{
  await speech.speak(voiceId,text,{onFormat:r=>{rate=r;},onPcm:pcm=>frames.push(pcm)},signal);
  const pcm=Buffer.concat(frames);const wav=Buffer.alloc(44+pcm.length);
  wav.write('RIFF');wav.writeUInt32LE(pcm.length+36,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);
  wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);
  wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(pcm.length,40);pcm.copy(wav,44);
  return wav;
 }finally{speech.close();}
}

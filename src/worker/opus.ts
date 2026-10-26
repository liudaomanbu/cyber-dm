import {Buffer} from 'node:buffer';
// The asm.js build is synchronous and does not compile WebAssembly at runtime.
// @ts-expect-error opusscript does not publish types for its native build.
import createNative from './vendor/opusscript.cjs';
let native:any;
/** Decoder-only OpusScript facade for the voice server's mono output. */
export default class WorkerOpusScript {
 static Application={VOIP:2048,AUDIO:2049,RESTRICTED_LOWDELAY:2051};
 private handler:any;private input:number;private output:number;private freed=false;
 constructor(rate:number,private channels=1,application=WorkerOpusScript.Application.AUDIO){
  if(![8000,12000,16000,24000,48000].includes(rate)||channels!==1)throw new Error('Unsupported Opus format');
  native??=createNative();
  this.handler=new native.OpusScriptHandler(rate,channels,application);
  this.input=native._malloc(1276*3);this.output=native._malloc(11520*channels);
 }
 decode(packet:Uint8Array){
  if(this.freed||packet.byteLength>1276*3)throw new Error('Invalid Opus packet');
  native.HEAPU8.set(packet,this.input);
  const samples=this.handler._decode(this.input,packet.byteLength,this.output);
  if(samples<0)throw new Error('Opus decode failed');
  // OpusScriptHandler exposes each PCM byte as a uint16 element.
  return Buffer.from(native.HEAPU16.subarray(this.output/2,this.output/2+samples*this.channels*2));
 }
 delete(){if(this.freed)return;this.freed=true;native.OpusScriptHandler.destroy_handler(this.handler);native._free(this.input);native._free(this.output);}
}

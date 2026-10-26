import test from 'node:test';
import assert from 'node:assert/strict';
import {SpeechEndpoint} from '../src/web/speech-endpoint.js';

test('speech ends once after 1800 ms silence, not a natural brief pause',()=>{
 const endpoint=new SpeechEndpoint({threshold:.015});endpoint.reset(1000);
 for(let time=1000;time<=1400;time+=20)assert.equal(endpoint.update(time,.03),undefined);
 assert.equal(endpoint.update(2400,0),undefined);
 assert.equal(endpoint.update(3199,0),undefined);
 assert.equal(endpoint.update(3200,0),'end');
 assert.equal(endpoint.update(3300,0),undefined);
});

test('short isolated noises never establish speech and time out',()=>{
 const endpoint=new SpeechEndpoint({threshold:.015});
 for(let time=0;time<20000;time+=20){
  const rms=time%3000<100?.03:0;
  assert.equal(endpoint.update(time,rms),undefined);
 }
 assert.equal(endpoint.update(20000,0),'no-speech');
 assert.equal(endpoint.update(21000,0),undefined);
});

test('brief gaps within a phrase permit cumulative speech detection',()=>{
 const endpoint=new SpeechEndpoint({threshold:.015});
 for(let time=0;time<=600;time+=20)endpoint.update(time,time===200||time===400?0:.03);
 assert.equal(endpoint.update(2400,0),'end');
});

test('continuous speech ends at the maximum recording duration',()=>{
 const endpoint=new SpeechEndpoint({threshold:.015});
 for(let time=0;time<90000;time+=100)assert.equal(endpoint.update(time,.03),undefined);
 assert.equal(endpoint.update(90000,.03),'end');
});

test('reset permits another recording and uses its own start timestamp',()=>{
 const endpoint=new SpeechEndpoint({threshold:.015});
 assert.equal(endpoint.update(20000,0),'no-speech');
 endpoint.reset(50000);
 for(let time=50000;time<=50400;time+=20)endpoint.update(time,.02);
 assert.equal(endpoint.update(52200,0),'end');
});

test('subthreshold sound and delayed or invalid samples do not establish speech',()=>{
 const endpoint=new SpeechEndpoint({threshold:.015});
 endpoint.update(0,.03);
 endpoint.update(10000,.03);
 endpoint.update(9999,.03);
 endpoint.update(Number.NaN,.03);
 endpoint.update(10020,Number.NaN);
 for(let time=10040;time<20000;time+=20)assert.equal(endpoint.update(time,.014),undefined);
 assert.equal(endpoint.update(20000,0),'no-speech');
});


test('adaptive energy endpoint recognizes a quiet 200 ms phrase after ambient calibration',()=>{
 const endpoint=new SpeechEndpoint();
 for(let time=0;time<1000;time+=20)assert.equal(endpoint.update(time,.0004),undefined);
 for(let time=1000;time<=1200;time+=20)assert.equal(endpoint.update(time,.004),undefined);
 assert.equal(endpoint.update(2999,.0004),undefined);
 assert.equal(endpoint.update(3000,.0004),'end');
});
test('adaptive endpoint does not mistake steady background or isolated clicks for speech',()=>{
 for(const background of [.0004,.006,.02]){
  const endpoint=new SpeechEndpoint();
  for(let time=0;time<20000;time+=20){
   const rms=time>500&&time%1000<40?.12:background*(1+.04*Math.sin(time));
   assert.equal(endpoint.update(time,rms),undefined);
  }
  assert.equal(endpoint.update(20000,background),'no-speech');
 }
});
test('adaptive endpoint does not accumulate absent samples across a clock jump',()=>{
 const endpoint=new SpeechEndpoint();
 for(let time=0;time<1000;time+=20)endpoint.update(time,.0004);
 endpoint.update(1000,.01);endpoint.update(15000,.01);endpoint.update(15020,.0004);
 assert.equal(endpoint.update(20000,.0004),'no-speech');
});
test('maximum duration remains a fallback even when no-speech waiting is extended',()=>{
 const endpoint=new SpeechEndpoint({noSpeechMs:Infinity,maximumMs:1000});
 for(let time=0;time<1000;time+=20)assert.equal(endpoint.update(time,.002),undefined);
 assert.equal(endpoint.update(1000,.002),'no-speech');
});

test('microphone meter aggregates all eight worklet frames, including sound before the final silent frame',async()=>{
 const {readFileSync}=await import('node:fs');const {runInNewContext}=await import('node:vm');
 const messages:any[]=[];let Processor:any;
 runInNewContext(readFileSync('public/mic-worklet.js','utf8'),{sampleRate:48000,AudioWorkletProcessor:class{port={postMessage:(message:unknown)=>messages.push(message)};},registerProcessor:(_name:string,ctor:unknown)=>{Processor=ctor;}});
 const processor=new Processor();
 for(let frame=0;frame<8;frame++)processor.process([[new Float32Array(128).fill(frame===0?.08:0)]]);
 const first=messages.find(m=>m?.type==='level');assert(first);assert(Math.abs(first.value-.08/Math.sqrt(8)*2.5)<1e-7);
 for(let frame=0;frame<8;frame++)processor.process([[new Float32Array(128)]]);
 assert.equal(messages.filter(m=>m?.type==='level').at(-1).value,0);
});

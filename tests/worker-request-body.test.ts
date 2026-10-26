import {test} from 'node:test';
import assert from 'node:assert/strict';
import {BodyTooLargeError,readBoundedBody} from '../src/worker/request-body.js';

function streamed(chunks:number[][],length?:string){
 let cancelled=false,reads=0;
 const stream=new ReadableStream<Uint8Array>({
  pull(controller){const next=chunks[reads++];if(next)controller.enqueue(new Uint8Array(next));else controller.close();},
  cancel(){cancelled=true;},
 },{highWaterMark:0});
 const request=new Request('https://example.test',{method:'POST',body:stream,headers:length===undefined?{}:{'content-length':length},duplex:'half'} as RequestInit);
 return {request,cancelled:()=>cancelled,reads:()=>reads};
}
test('bounded body returns empty for no body and joins chunks exactly up to limit',async()=>{
 assert.deepEqual(await readBoundedBody(new Request('https://example.test'),0),new Uint8Array());
 const {request}=streamed([[0,1],[255],[128,2]],'5');
 assert.deepEqual(await readBoundedBody(request,5),new Uint8Array([0,1,255,128,2]));
});
test('declared oversized body is cancelled without reading any chunk',async()=>{
 const input=streamed([[1],[2]],'100');
 await assert.rejects(()=>readBoundedBody(input.request,2),BodyTooLargeError);
 assert.equal(input.reads(),0);assert.equal(input.cancelled(),true);
});
test('chunked oversized body is cancelled immediately without Content-Length or with an understated length',async()=>{
 for(const length of [undefined,'1','invalid','-1']){
  const input=streamed([[1,2],[3,4],[5,6]],length);
  await assert.rejects(()=>readBoundedBody(input.request,3),BodyTooLargeError);
  assert.equal(input.reads(),2);assert.equal(input.cancelled(),true);
 }
});
test('missing and malformed Content-Length use the actual byte count',async()=>{
 for(const length of [undefined,'invalid','-1']){
  const input=streamed([[1],[2,3]],length);
  assert.deepEqual(await readBoundedBody(input.request,3),new Uint8Array([1,2,3]));
  assert.equal(input.cancelled(),false);
 }
});
test('bounded reader releases its lock after a stream error',async()=>{
 const stream=new ReadableStream<Uint8Array>({pull(controller){controller.error(new Error('Read failed'));}});
 const request=new Request('https://example.test',{method:'POST',body:stream,duplex:'half'} as RequestInit);
 await assert.rejects(()=>readBoundedBody(request,10),/Read failed/);
 assert.equal(stream.locked,false);
});

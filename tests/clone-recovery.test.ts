import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import Fastify from 'fastify';

test('background clone submission returns before PUT completes, persists uncertainty, restores audio, and never automatically repeats training',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'cyber-clone-test-'));process.env.CYBER_DM_DATA_DIR=dir;
 const {defaultConfig,save}=await import('../src/server/store.js');
 const {registerLinxApi}=await import('../src/server/linx-api.js');
 const config=structuredClone(defaultConfig);config.linx.apiKey='test';config.linx.publicBaseUrl='https://example.com';
 const sampleId='12345678-1234-4234-8234-123456789012';
 await save('voice-samples',{[sampleId]:{id:sampleId,token:'a'.repeat(64),expires:Date.now()+3600000,mime:'audio/wav'}});
 let creates=0,trains=0,state='Init',complete:(success:boolean)=>void=()=>{};const original=globalThis.fetch;
 const slot=()=>({id:'clone-1',name:'我的声音',language:'zh',tier:'free',state});
 globalThis.fetch=(async(input,init)=>{
  if(init?.method==='POST'){creates++;return Response.json({code:0,data:slot()});}
  if(init?.method==='PUT'){
   trains++;return await new Promise<Response>((resolve,reject)=>{complete=success=>{if(!success)reject(new Error('timeout'));else{state='Training';resolve(Response.json({code:0,data:slot()}));}};});
  }
  return Response.json({code:0,data:String(input).endsWith('/voice-clones')?{voices:[slot()]}:slot()});
 }) as typeof fetch;
 let app=Fastify();const setup=async()=>registerLinxApi(app,{getConfig:()=>config,setConfig:async()=>{},scripts:()=>({})});
 const waitPhase=async(phase:string)=>{
  for(let i=0;i<100;i++){const voice=(await app.inject('/api/linx/clones')).json().voices[0];if(voice.submissionPhase===phase)return voice;await new Promise(r=>setTimeout(r,5));}
  assert.fail('Expected phase '+phase);
 };
 try{
  await setup();const payload={sampleId,name:'我的声音'};
  const submitting=await app.inject({method:'POST',url:'/api/linx/clones',payload});assert.equal(submitting.statusCode,200);assert.equal(submitting.json().submissionPhase,'submitting');assert.equal(submitting.json().id,'clone-1');
  const duplicate=await app.inject({method:'POST',url:'/api/linx/clones/clone-1/train',payload});assert.match(duplicate.body,/正在提交训练/);assert.equal(trains,1);
  complete(false);const uncertain=await waitPhase('uncertain');assert.match(uncertain.submissionNote,/timeout/);
  // Wait for the background journal write before reloading the server.
  await new Promise(r=>setTimeout(r,30));await app.close();app=Fastify();await setup();
  const list=(await app.inject('/api/linx/clones')).json();assert.match(list.voices[0].submissionNote,/未得到确认/);
  const sample=(await app.inject('/api/linx/samples/latest')).json();assert.equal(sample.sampleId,sampleId);assert.equal(sample.cloneId,'clone-1');assert.equal(sample.token,undefined);
  await app.inject({method:'POST',url:'/api/linx/clones',payload});assert.equal(creates,1);assert.equal(trains,1);
  const retry=await app.inject({method:'POST',url:'/api/linx/clones/clone-1/train',payload});assert.equal(retry.json().submissionPhase,'submitting');assert.equal(trains,2);assert.equal(creates,1);
  complete(true);await waitPhase('accepted');await new Promise(r=>setTimeout(r,30));
  await app.inject({method:'POST',url:'/api/linx/clones/clone-1/train',payload});assert.equal(trains,2,'Training must not be resubmitted');
  state='Success';await app.inject({method:'POST',url:'/api/linx/clones/clone-1/train',payload});assert.equal(trains,2,'Success must not be retrained');
  // Model a killed process's durable submitting record. Startup must not send PUT.
  await app.close();await save('voice-clone-attempts',{'clone-1':{phase:'submitting',sampleId,note:'提交中'}});state='Init';
  app=Fastify();await setup();const interrupted=(await app.inject('/api/linx/clones')).json().voices[0];assert.equal(interrupted.submissionPhase,'uncertain');assert.match(interrupted.submissionNote,/重启/);assert.equal(trains,2);
  state='Success';const reconciled=(await app.inject('/api/linx/clones')).json().voices[0];assert.equal(reconciled.submissionPhase,'accepted');assert.equal(reconciled.submissionNote,undefined);
 }finally{complete(false);globalThis.fetch=original;await app.close();await rm(dir,{recursive:true,force:true});}
});

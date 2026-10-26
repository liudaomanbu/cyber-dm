import {test} from 'node:test';
import assert from 'node:assert/strict';
import createRouter from '../src/worker/router.js';
import {registerAccess} from '../src/server/auth.js';

test('onRequest rejection skips body parsing and route handlers',async()=>{
 const app=createRouter();let called=false;
 app.addHook('onRequest',(_req:any,reply:any)=>reply.code(401).send({error:'denied'}));
 app.post('/protected',()=>{called=true;return {ok:true};});
 const response=await app.inject({method:'POST',url:'/protected',headers:{'content-type':'application/json'},payload:'{invalid'});
 assert.equal(response.statusCode,401);assert.deepEqual(response.json(),{error:'denied'});assert.equal(called,false);
});

test('existing access guards enforce hosts, origins, login cookies, and logout',async()=>{
 const app=createRouter();const code='test-only-access-code';
 await registerAccess(app,{accessCode:code,publicOrigin:'https://dm.example'});
 app.get('/api/private',()=>({ok:true}));
 const headers={host:'dm.example'};
 assert.equal((await app.inject({url:'/api/access/status',headers:{host:'evil.example'}})).statusCode,403);
 assert.equal((await app.inject({url:'/api/access/status',headers:{...headers,origin:'https://evil.example'}})).statusCode,403);
 assert.equal((await app.inject({url:'/api/private',headers})).statusCode,401);
 const login=await app.inject({method:'POST',url:'/api/access/login',headers:{...headers,origin:'https://dm.example'},payload:{code}});
 assert.equal(login.statusCode,200);
 const cookie=login.headers['set-cookie'];assert.match(cookie,/HttpOnly; SameSite=Strict; Path=\/; Max-Age=43200; Secure/);
 const authenticated={...headers,cookie:cookie.split(';')[0]};
 assert.equal((await app.inject({url:'/api/private',headers:authenticated})).statusCode,200);
 assert.equal((await app.inject({url:'/api/private',headers:{...authenticated,origin:'https://evil.example'}})).statusCode,403);
 const logout=await app.inject({method:'POST',url:'/api/access/logout',headers:authenticated});
 assert.match(logout.headers['set-cookie'],/Max-Age=0/);
 assert.equal((await app.inject({url:'/api/private',headers:authenticated})).statusCode,401);
});

test('JSON and size errors remain client errors with the application error handler',async()=>{
 const app=createRouter({bodyLimit:64});let called=0;
 app.setErrorHandler((error:Error,_req:any,reply:any)=>reply.code(500).send({error:error.message}));
 app.post('/json',(req:any)=>{called++;return req.body;});
 assert.equal((await app.inject({method:'POST',url:'/json',headers:{'content-type':'application/json'},payload:'{broken'})).statusCode,400);
 assert.equal((await app.inject({method:'POST',url:'/json',payload:'a'.repeat(65)})).statusCode,413);
 assert.equal(called,0);
 assert.deepEqual((await app.inject({method:'POST',url:'/json',payload:{valid:true}})).json(),{valid:true});
 assert.deepEqual((await app.inject({method:'POST',url:'/json',headers:{'content-type':'application/json; charset=utf-8'},payload:'{"valid":true}'})).json(),{valid:true});
});

async function multipart(files:{name:string;size:number}[]){
 const form=new FormData();form.append('label','sample');
 for(const file of files)form.append('file',new Blob([new Uint8Array(file.size)],{type:'audio/wav'}),file.name);
 const request=new Request('https://upload.invalid',{method:'POST',body:form});
 return {method:'POST',url:'/upload',headers:{'content-type':request.headers.get('content-type')!},payload:Buffer.from(await request.arrayBuffer())};
}
test('multipart accepts exactly 15MiB and rejects extra files, oversized and malformed bodies',async()=>{
 const app=createRouter();
 app.setErrorHandler((error:Error,_req:any,reply:any)=>reply.code(500).send({error:error.message}));
 app.post('/upload',async(req:any)=>{const file=await req.file();return file?{name:file.filename,type:file.mimetype,size:(await file.toBuffer()).length}:null;});
 const accepted=await app.inject(await multipart([{name:'sample.wav',size:15*1024*1024}]));
 assert.equal(accepted.statusCode,200);assert.deepEqual(accepted.json(),{name:'sample.wav',type:'audio/wav',size:15*1024*1024});
 assert.equal((await app.inject(await multipart([{name:'large.wav',size:15*1024*1024+1}]))).statusCode,413);
 assert.equal((await app.inject(await multipart([{name:'a.wav',size:1},{name:'b.wav',size:1}]))).statusCode,413);
 assert.equal((await app.inject({method:'POST',url:'/upload',headers:{'content-type':'multipart/form-data'},payload:'broken'})).statusCode,400);
 assert.equal((await app.inject(await multipart([]))).json(),null);
});

test('route parameters, query strings, binary responses, headers, and 404 are preserved',async()=>{
 const app=createRouter();
 app.get('/items/:id',(req:any)=>({id:req.params.id,query:req.query}));
 const item=await app.inject({url:'/items/%E4%B8%AD%E6%96%87?ticket=a%2Bb&empty='});
 assert.deepEqual(item.json(),{id:'中文',query:{ticket:'a+b',empty:''}});
 app.get('/audio',(_req:any,reply:any)=>reply.header('Cache-Control','no-store').header('Set-Cookie',['a=1','b=2']).type('audio/wav').send(Buffer.from([0,255,128])));
 const audio=await app.inject({url:'/audio'});
 assert.deepEqual(audio.rawPayload,Buffer.from([0,255,128]));assert.equal(audio.headers['content-type'],'audio/wav');
 assert.equal(audio.headers['cache-control'],'no-store');assert.deepEqual(audio.headers['set-cookie'],['a=1','b=2']);
 assert.equal((await app.inject({url:'/unknown'})).statusCode,404);
 assert.equal((await app.inject({method:'POST',url:'/audio'})).statusCode,404);
});

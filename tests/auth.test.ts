import {test} from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import {registerAccess} from '../src/server/auth.js';
test('remote instance requires allowed host, correct code and HttpOnly session',async()=>{
 const app=Fastify();await registerAccess(app,{accessCode:'a-test-code-with-32-characters',publicOrigin:'https://game.example.com'});app.get('/api/private',async()=>({secret:'only after login'}));
 try{
  assert.equal((await app.inject({url:'/api/private',headers:{host:'game.example.com'}})).statusCode,401);
  assert.equal((await app.inject({url:'/api/private',headers:{host:'attacker.example.com'}})).statusCode,403);
  assert.equal((await app.inject({method:'POST',url:'/api/access/login',headers:{host:'game.example.com',origin:'https://evil.example'},payload:{code:'a-test-code-with-32-characters'}})).statusCode,403);
  const login=await app.inject({method:'POST',url:'/api/access/login',headers:{host:'game.example.com'},payload:{code:'a-test-code-with-32-characters'}});
  assert.equal(login.statusCode,200);const cookie=String(login.headers['set-cookie']);assert(cookie.includes('HttpOnly'));assert(cookie.includes('Secure'));
  const headers={host:'game.example.com',cookie:cookie.split(';')[0]};assert.equal((await app.inject({url:'/api/private',headers})).statusCode,200);
  await app.inject({method:'POST',url:'/api/access/logout',headers});assert.equal((await app.inject({url:'/api/private',headers})).statusCode,401);
 }finally{await app.close();}
});

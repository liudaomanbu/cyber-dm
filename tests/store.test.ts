import {test} from 'node:test';
import assert from 'node:assert/strict';
import {defaultConfig,configSchema,mergeSecrets,publicConfig,MASK} from '../src/server/store.js';
test('stale browser settings preserve managed speech setup and never expose speech tokens',()=>{
 const current=structuredClone(defaultConfig);Object.assign(current.linx,{inputMode:'stt',speechDeviceId:'speech-device',speechWsToken:'private-speech-token',speechClientId:'speech-client',speechWsUrl:'wss://speech.example/',apiKey:'private-api-key'});
 const stale=configSchema.parse({...defaultConfig,linx:{...defaultConfig.linx,apiKey:MASK}});
 const saved=mergeSecrets(stale,current);assert.equal(saved.linx.inputMode,'stt');assert.equal(saved.linx.speechDeviceId,'speech-device');assert.equal(saved.linx.speechWsToken,'private-speech-token');assert.equal(saved.linx.apiKey,'private-api-key');assert.equal(publicConfig(saved).linx.speechWsToken,MASK);assert(!JSON.stringify(publicConfig(saved)).includes('private-speech-token'));
});

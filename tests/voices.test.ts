import {test} from 'node:test';
import assert from 'node:assert/strict';
import {chooseVoices,voiceSchema} from '../src/core/voices.js';
test('voice assignment requires distinct voices and prefers role hints',()=>{
 const voices=[
  {id:'f',name:'温柔女声',tags:{languages:['zh'],gender:'female',age:'adult',styles:['wenrou'],scenes:['audiobook']}},
  {id:'m',name:'沉稳男声',tags:{languages:['zh'],gender:'male',age:'middle',styles:['chenwen'],scenes:['audiobook']}},
  {id:'b',name:'明亮男声',tags:{languages:['zh'],gender:'male',age:'young',styles:['kailang'],scenes:['assistant']}}
 ];
 const r=chooseVoices([{id:'dm',name:'主持人',voiceHint:'沉稳、有声书'},{id:'lin',name:'林岚',voiceHint:'温柔成年女声'},{id:'chen',name:'陈墨',voiceHint:'明亮成年男声'}],voices);
 assert.equal(r.lin.id,'f');assert.equal(new Set(Object.values(r).map(v=>v.id)).size,3);
 assert.throws(()=>chooseVoices([{id:'a',name:'a'},{id:'b',name:'b'}],voices.slice(0,1)));
});

test('voice catalog keeps resource id separate from callback voice_type',()=>{
 const voice=voiceSchema.parse({voice_id:'resource-1',name:'示例',provider:'linx',voice_type:'callback-1',language:'zh'});
 assert.equal(voice.id,'resource-1');
 assert.equal(voice.voice_type,'callback-1');
 assert.equal(voice.tags?.languages?.[0],'zh');
 assert.throws(()=>voiceSchema.parse({voice_type:'only-callback',name:'缺少资源 ID'}));
});

test('voice catalog accepts null tag dimensions from Linx',()=>{
 const voice=voiceSchema.parse({
  id:'catalog-1',
  name:'目录音色',
  tags:{languages:null,age:'young',gender:'female',styles:null,scenes:null},
 });
 assert.deepEqual(voice.tags,{age:'young',gender:'female'});
});

test('voice assignment skips clone jobs that are not ready',()=>{
 const voices=[
  {id:'training',name:'训练中',state:'Training',tags:{languages:['zh']}},
  {id:'ready',name:'可用',state:'Success',tags:{languages:['zh']}},
 ];
 const result=chooseVoices([{id:'dm',name:'主持人'}],voices);
 assert.equal(result.dm.id,'ready');
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseScript} from '../src/core/script.js';
import {extractText,verifySources,generateDraft} from '../src/server/compiler.js';
import type {Provider} from '../src/server/store.js';
const script=parseScript(JSON.parse(readFileSync('examples/after-hours.json','utf8')));
test('source checking rejects fabricated quotations without granting semantic approval',()=>{
 const quotes=[...script.facts,...script.utterances].map(x=>x.source.quote).join('\n');
 assert.equal(verifySources(script,quotes).length,0);
 const edited=structuredClone(script);edited.facts[0].source.quote='原文没有出现的保险柜';
 assert(verifySources(edited,quotes).some(x=>x.includes('lin_where')));
});
test('UTF-8 text extraction keeps full document and rejects unsupported content',async()=>{
 const text='角色本\n第一幕：闭馆之后';assert.equal(await extractText('test.md',Buffer.from(text)),text);
 await assert.rejects(extractText('test.exe',Buffer.from(text)));
 await assert.rejects(extractText('test.txt',Buffer.from([0xff,0xfe])));
});

test('generated scripts are reviewable drafts and never treated as uploaded source', async () => {
 const original=globalThis.fetch;
 const script=JSON.parse(readFileSync('examples/after-hours.json','utf8'));
 globalThis.fetch=(async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(script)}}],usage:{prompt_tokens:10,completion_tokens:20}}),{status:200})) as typeof fetch;
 const provider:Provider={id:'p',name:'p',protocol:'chat-completions',baseUrl:'https://example.com/v1',modelId:'m',apiKey:'secret',timeoutMs:1000};
 try{
  const draft=await generateDraft('生成一个闭馆后的三人推理短本',provider);
  assert.equal(draft.sourceMode,'generated');
  assert(draft.warnings.some(w=>w.includes('原创草稿')));
  assert.equal(draft.script.title,'闭馆之后');
 }finally{globalThis.fetch=original;}
});

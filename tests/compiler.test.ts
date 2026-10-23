import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {parseScript} from '../src/core/script.js';
import {extractText,verifySources} from '../src/server/compiler.js';
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

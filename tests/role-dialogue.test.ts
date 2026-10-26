import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateRoleDialogue } from '../src/server/role-dialogue.js';
import type { roleContext } from '../src/core/engine.js';
import type { Provider } from '../src/server/store.js';

const provider: Provider = { id:'p', name:'test', protocol:'chat-completions', baseUrl:'https://example.test', modelId:'m', apiKey:'test', timeoutMs:1000 };
const context = {
  sessionId:'s', version:1, role:{id:'a',name:'甲',description:'只谈自己所知'},
  stage:{id:'intro',title:'开场',kind:'discussion',introduction:'请陈述'},
  facts:[{id:'door',text:'门是开着的。'}],
  heard:[{speaker:'b',kind:'speech',text:'你看到门了吗？'}],
  allowedUtterances:[{id:'line',kind:'statement',text:'门是开着的。'}],
} as ReturnType<typeof roleContext>;
async function mock(responses: unknown[], run:(calls:any[])=>Promise<void>, rawStrings = false) {
  const original = globalThis.fetch;
  const calls:any[]=[];
  globalThis.fetch = (async (_input, init) => {
    calls.push(JSON.parse(String(init?.body)));
    const next = responses.shift();
    assert.notEqual(next, undefined, 'unexpected model call');
    return new Response(JSON.stringify({choices:[{message:{content:rawStrings && typeof next === 'string' ? next : JSON.stringify(next)}}]}));
  }) as typeof fetch;
  try { await run(calls); } finally { globalThis.fetch=original; }
}
const valid = {valid:true,reason:'当前可见事实支持该回应'};
const natural = {text:'看到了，门当时是开着的。你为什么问这个？',factIds:['door']};

test('natural dialogue is retained and both model calls see only role-scoped evidence', async () => {
  const input = {...context, solution:'UNAUTHORIZED_SECRET', otherRole:{secret:'UNAUTHORIZED_SECRET'}};
  await mock([natural,valid], async calls => {
    assert.deepEqual(await generateRoleDialogue(provider,input,{task:'回答乙的问题'}),natural);
    assert.equal(calls.length,2);
    for (const call of calls) {
      assert(!JSON.stringify(call).includes('UNAUTHORIZED_SECRET'));
      assert.deepEqual(JSON.parse(call.messages[1].content).context.facts,context.facts);
      assert.equal(JSON.parse(call.messages[1].content).task,'回答乙的问题');
    }
  });
});

test('unknown citations are rejected before review and retried once', async () => {
  await mock([{text:'我知道秘密。',factIds:['unknown']},natural,valid], async calls => {
    assert.deepEqual(await generateRoleDialogue(provider,context),natural);
    assert.equal(calls.length,3);
    assert(!JSON.stringify(calls[1]).includes('我知道秘密'));
  });
  await mock([{...natural,factIds:['unknown']},{...natural,factIds:['unknown']}], async calls => {
    await assert.rejects(generateRoleDialogue(provider,context),/未知或不可披露/);
    assert.equal(calls.length,2);
  });
});

test('invalid review or invented details never fall back to a scripted utterance', async () => {
  await mock([natural,{valid:'true',reason:'bad'},natural,{valid:false,reason:'无依据的具体细节'}],async calls => {
    await assert.rejects(generateRoleDialogue(provider,context),/对白生成失败/);
    assert.equal(calls.length,4);
  });
});

test('protected facts cannot be cited even when public whitelist includes them',async () => {
  await mock([natural,natural],async () => {
    await assert.rejects(generateRoleDialogue(provider,{...context,disclosure:{publicFactIds:['door'],protectedFactIds:['door']}}),/不可披露/);
  });
});

test('a reviewer rejection triggers fresh generation, never upgrades testimony to facts',async () => {
  const revised={text:'你刚才是在问门的情况吗？门是开着的。',factIds:['door']};
  const before=JSON.stringify(context);
  await mock([natural,{valid:false,reason:'原回复不够切题'},revised,valid], async () => {
    assert.deepEqual(await generateRoleDialogue(provider,context),revised);
    assert.equal(JSON.stringify(context),before);
  });
});

test('full canon reaches only the independent DM reviewer and cannot enter a retry',async () => {
  const dmProvider={...provider,modelId:'dm-reviewer'};
  const script={solution:{explanation:'FULL_CANON_PRIVATE_SENTINEL'}} as import('../src/core/script.js').Script;
  await mock([natural,{valid:false,reason:'FULL_CANON_PRIVATE_SENTINEL'},natural,{valid:true}],async calls => {
    await generateRoleDialogue(provider,context,{reviewer:{provider:dmProvider,script,stageIndex:0}});
    assert.equal(calls.length,4);
    for (const index of [0,2]) {
      assert.equal(calls[index].model,'m');
      assert(!JSON.stringify(calls[index]).includes('FULL_CANON_PRIVATE_SENTINEL'));
    }
    for (const index of [1,3]) {
      assert.equal(calls[index].model,'dm-reviewer');
      assert(JSON.stringify(calls[index]).includes('FULL_CANON_PRIVATE_SENTINEL'));
    }
  });
});

test('known personal information need not already be public to be shared',async () => {
  await mock([natural,valid],async () => {
    assert.deepEqual(await generateRoleDialogue(provider,{...context,disclosure:{publicFactIds:[]}}),natural);
  });
});

test('missing citation field defaults to empty but still requires independent review',async () => {
  await mock([{text:natural.text},valid],async calls=>{
    assert.deepEqual(await generateRoleDialogue(provider,context),{text:natural.text,factIds:[]});
    assert.equal(calls.length,2);
    assert.deepEqual(JSON.parse(calls[1].messages[1].content).candidate.factIds,[]);
  });
  await mock([{text:natural.text,factIds:null},{text:natural.text,factIds:123}],async calls=>{
    await assert.rejects(generateRoleDialogue(provider,context),/格式不正确/);
    assert.equal(calls.length,2);
  });
});

test('JSON-string dialogue remains subject to independent review',async () => {
  await mock([natural.text,valid],async calls=>{
    assert.deepEqual(await generateRoleDialogue(provider,context),{text:natural.text,factIds:[]});
    assert.equal(calls.length,2);
  });
  await mock([natural.text,{valid:false},natural.text,{valid:false}],async calls=>{
    await assert.rejects(generateRoleDialogue(provider,context),/对白生成失败/);
    assert.equal(calls.length,4);
  });
});

test('old statements and fallback templates never anchor generation or review',async()=>{
  const scoped={...context,allowedUtterances:[
    {id:'fallback',kind:'fallback' as const,text:'OLD_FALLBACK_SENTINEL'},
    {id:'statement',kind:'statement' as const,text:'OLD_STATEMENT_SENTINEL'},
    {id:'lie',kind:'scripted_lie' as const,text:'门不是我开的。'},
  ]};
  await mock([natural,valid],async calls=>{
    await generateRoleDialogue(provider,scoped);
    for(const call of calls){
      assert(!JSON.stringify(call).includes('OLD_FALLBACK_SENTINEL'));
      assert(!JSON.stringify(call).includes('OLD_STATEMENT_SENTINEL'));
      assert.deepEqual(JSON.parse(call.messages[1].content).context.allowedUtterances,[scoped.allowedUtterances[2]]);
    }
  });
});

test('DM handoff targets are identical in generation and independent review',async()=>{
  const dm={...context,role:{id:'dm',name:'主持人',description:'主持讨论'}};
  const handoffTo=[{id:'a',name:'甲'}];
  const answer={text:'甲，听了刚才的讨论，你怎么看？',factIds:[]};
  await mock([answer,valid],async calls=>{
    assert.deepEqual(await generateRoleDialogue(provider,dm,{handoffTo}),answer);
    assert.equal(calls.length,2);
    for(const call of calls)assert.deepEqual(JSON.parse(call.messages[1].content).handoffTo,handoffTo);
  });
});

test('non-DM roles cannot set host handoff controls',async()=>{
  await mock([],async calls=>{
    await assert.rejects(generateRoleDialogue(provider,context,{handoffTo:[{id:'b',name:'乙'}]}),/只有主持人/);
    assert.equal(calls.length,0);
  });
});

test('handoff mismatch rejected by review cannot fall through into speech',async()=>{
  const dm={...context,role:{id:'dm',name:'主持人',description:'主持讨论'}};
  const wrong={text:'乙，接下来请你回答。',factIds:[]};
  await mock([wrong,{valid:false,reason:'指定待回应者是甲'},wrong,{valid:false}],async()=>{
    await assert.rejects(generateRoleDialogue(provider,dm,{handoffTo:[{id:'a',name:'甲'}]}),/对白生成失败/);
  });
});


test('raw dialogue is normalized but malformed JSON never becomes spoken text',async()=>{
  await mock([natural.text,valid],async calls=>{
    assert.deepEqual(await generateRoleDialogue(provider,context),{text:natural.text,factIds:[]});
    assert.deepEqual(JSON.parse(calls[1].messages[1].content).candidate,{text:natural.text,factIds:[]});
  },true);
  await mock([natural.text,{valid:false},natural.text,{valid:false}],async calls=>{
    await assert.rejects(generateRoleDialogue(provider,context),/对白生成失败/);
    assert.equal(calls.length,4);
  },true);
  await mock(['{"text":"截断','```json\n{"text":"截断'],async calls=>{
    await assert.rejects(generateRoleDialogue(provider,context),/格式不正确/);
    assert.equal(calls.length,2);
  },true);
});

test('public cast names reach both calls without incidental secret fields',async()=>{
  const cast=[{id:'chen',name:'陈澄',secret:'CAST_PRIVATE_SENTINEL'}];
  await mock([natural,valid],async calls=>{
    await generateRoleDialogue(provider,{...context,cast});
    for(const call of calls){
      assert.deepEqual(JSON.parse(call.messages[1].content).context.cast,[{id:'chen',name:'陈澄'}]);
      assert(!JSON.stringify(call).includes('CAST_PRIVATE_SENTINEL'));
    }
  });
});

test('handoff permits general voting instructions while directing the next reply to the player',async()=>{
  const dm={...context,role:{id:'dm',name:'主持人',description:'主持讨论'}};
  const handoffTo=[{id:'lin',name:'林'}];
  const answer={text:'现在请各位投票，所有人都要投票。林，你准备好就提交选择吧。',factIds:[]};
  await mock([answer,valid],async calls=>{
    assert.deepEqual(await generateRoleDialogue(provider,dm,{handoffTo}),answer);
    for(const call of calls){
      assert.deepEqual(JSON.parse(call.messages[1].content).handoffTo,handoffTo);
      assert.match(call.messages[0].content,/下一位立即回答/);
      assert.match(call.messages[0].content,/请各位投票/);
      assert.match(call.messages[0].content,/最后具体交接应给指定对象/);
    }
  });
});

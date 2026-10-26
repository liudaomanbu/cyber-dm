// Regenerate after an opusscript upgrade: node scripts/build-worker-opus.cjs
// Only the build process executes Emscripten's dynamic glue generator.
const fs=require('node:fs');
const path=require('node:path');
const packageRoot=path.dirname(require.resolve('opusscript/package.json'));
const input=path.join(packageRoot,'build/opusscript_native_nasm.js');
const factories=new Map();const OriginalFunction=global.Function;
try{
 global.Function=new Proxy(OriginalFunction,{apply(target,thisArg,args){factories.set(JSON.stringify(args),args);return Reflect.apply(target,thisArg,args);}});
 const native=require(input)();const handler=new native.OpusScriptHandler(24000,1,2049);native.OpusScriptHandler.destroy_handler(handler);
}finally{global.Function=OriginalFunction;}
let source=fs.readFileSync(input,'utf8');
const start=source.indexOf('function yb(a){');const end=source.indexOf('\n',start);
if(start<0||end<0||!source.slice(start,end).endsWith('return a instanceof Object?a:c}'))throw Error('Upstream glue changed: inspect before regenerating');
const cases=[...factories].map(([key,args])=>`case ${JSON.stringify(key)}: return function(${args.slice(0,-1).join(',')}){${args.at(-1)}};`).join('\n');
source=source.slice(0,start)+`function yb(a){switch(JSON.stringify(a)){${cases}\ndefault:throw new Error('Unsupported precompiled Opus glue');}}`+source.slice(end);
// This embedded asm runtime needs neither filesystem nor process discovery.
source=source.replace('ha="object"==typeof process&&"object"==typeof process.versions&&"string"==typeof process.versions.node','ha=false');
source='// Generated from opusscript 0.1.1 asm.js; see LICENSE.opusscript and scripts/build-worker-opus.cjs.\n'+source;
fs.writeFileSync('src/worker/vendor/opusscript.cjs',source);
fs.copyFileSync(path.join(packageRoot,'LICENSE'),'src/worker/vendor/LICENSE.opusscript');
console.log(`Generated ${factories.size} static glue factories (${source.length} bytes)`);

import {Buffer} from 'node:buffer';

type Handler=(request:any,reply:Reply)=>unknown;
class RequestError extends Error {constructor(readonly statusCode:number,message:string){super(message);}}
class Reply {
 statusCode=200;sent=false;value:unknown;headers:Record<string,string|string[]>={};
 code(value:number){this.statusCode=value;return this;}
 status(value:number){return this.code(value);}
 header(name:string,value:string|string[]){this.headers[name.toLowerCase()]=value;return this;}
 type(value:string){return this.header('content-type',value);}
 send(value:unknown){this.value=value;this.sent=true;return this;}
}
/** Small, interpreted adapter for the route API used by this application.
 * Workers forbid the runtime code generation used by Node's Fastify router.
 * Node builds continue to use Fastify; only the Worker bundle aliases this file. */
export default function createRouter(options:{bodyLimit?:number}={}) {
 const routes:{method:string;path:string;handler:Handler}[]=[];
 const hooks:Handler[]=[];let errorHandler:((e:Error,request:any,reply:Reply)=>unknown)|undefined;
 const app:any={
  log:{error:(message:string)=>console.error(message)},
  addHook(name:string,handler:Handler){if(name!=='onRequest')throw new Error('Unsupported route hook');hooks.push(handler);return app;},
  setErrorHandler(handler:typeof errorHandler){errorHandler=handler;return app;},
  async register(plugin:any,settings:any){await plugin(app,settings);return app;},
  async ready(){},async close(){},
  async inject(input:{method?:string;url:string;headers?:Record<string,string|string[]|undefined>;payload?:Buffer|string|object}) {
   const headers=Object.fromEntries(Object.entries(input.headers??{}).filter(([,v])=>v!==undefined).map(([k,v])=>[k.toLowerCase(),Array.isArray(v)?v.join('; '):v!])) as Record<string,string>;
   const url=new URL(input.url,'https://'+(headers.host??'localhost'));
   headers.host??=url.host;
   if(input.payload!==undefined&&typeof input.payload==='object'&&!Buffer.isBuffer(input.payload)&&!headers['content-type'])headers['content-type']='application/json';
   const reply=new Reply();
   let params:Record<string,string>={};
   const route=routes.find(r=>{
    if(r.method!==(input.method??'GET').toUpperCase())return false;
    const pattern=r.path.split('/'),actual=url.pathname.split('/');if(pattern.length!==actual.length)return false;
    const values:Record<string,string>={};
    for(let i=0;i<pattern.length;i++){
     if(pattern[i].startsWith(':')){try{values[pattern[i].slice(1)]=decodeURIComponent(actual[i]);}catch{return false;}}
     else if(pattern[i]!==actual[i])return false;
    }
    params=values;return true;
   });
   const req:any={url:url.pathname+url.search,method:input.method??'GET',headers,params,query:Object.fromEntries(url.searchParams),ip:headers['cf-connecting-ip']??'127.0.0.1'};
   try{
    // Authenticate before parsing a potentially large body.
    for(const hook of hooks){await hook(req,reply);if(reply.sent)break;}
    if(!reply.sent){
     const raw=input.payload===undefined?Buffer.alloc(0):Buffer.isBuffer(input.payload)?input.payload:Buffer.from(typeof input.payload==='string'?input.payload:JSON.stringify(input.payload));
     if(headers['content-type']?.startsWith('multipart/form-data')){
      if(raw.length>16*1024*1024){reply.code(413).send({error:'上传文件过大'});}
      req.file=async()=>{
       let form:FormData;
       try{form=await new Request('https://upload.invalid',{method:'POST',headers:{'content-type':headers['content-type']},body:new Uint8Array(raw).buffer}).formData();}
       catch{throw new RequestError(400,'无效的 multipart 请求');}
       const files=[...form.values()].filter(v=>typeof v!=='string') as File[];
       if(files.length>1)throw new RequestError(413,'一次只能上传一个文件');
       const file=files[0];if(!file)return undefined;if(file.size>15*1024*1024)throw new RequestError(413,'上传文件超过15MB');
       return {filename:file.name,mimetype:file.type,toBuffer:async()=>Buffer.from(await file.arrayBuffer())};
      };
     }else if(raw.length>(options.bodyLimit??2*1024*1024)){reply.code(413).send({error:'请求内容过大'});}
     else if(raw.length){
      if(headers['content-type']?.split(';')[0].trim().toLowerCase()==='application/json'){
       try{req.body=JSON.parse(raw.toString());}catch{throw new RequestError(400,'无效的 JSON 请求');}
      }
      else req.body=raw.toString();
     }
     if(!reply.sent){
      if(!route)reply.code(404).send({error:'Not found'});
      else{const result=await route.handler(req,reply);if(!reply.sent)reply.send(result);}
     }
    }
   }catch(error){
    if(error instanceof RequestError)reply.code(error.statusCode).send({error:error.message});
    else if(errorHandler)await errorHandler(error as Error,req,reply);
    else reply.code(500).send({error:(error as Error).message});
   }
   const value=reply.value;
   const rawPayload=value===undefined?Buffer.alloc(0):Buffer.isBuffer(value)?value:typeof value==='string'?Buffer.from(value):Buffer.from(JSON.stringify(value));
   if(!reply.headers['content-type'])reply.type(Buffer.isBuffer(value)?'application/octet-stream':typeof value==='string'?'text/plain; charset=utf-8':'application/json; charset=utf-8');
   return {statusCode:reply.statusCode,headers:reply.headers,rawPayload,payload:rawPayload.toString(),json:()=>JSON.parse(rawPayload.toString())};
  },
 };
 for(const method of ['GET','POST','PUT','DELETE'])app[method.toLowerCase()]=(path:string,...args:any[])=>{routes.push({method,path,handler:args.at(-1)});return app;};
 return app;
}

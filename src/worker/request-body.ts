export class BodyTooLargeError extends Error {
 constructor(){super('Request body exceeds the size limit');this.name='BodyTooLargeError';}
}

/** Enforce the limit while reading, even when Content-Length is absent or false. */
export async function readBoundedBody(request:Request,maxBytes:number):Promise<Uint8Array>{
 if(!Number.isSafeInteger(maxBytes)||maxBytes<0)throw new RangeError('maxBytes must be a non-negative safe integer');
 const length=request.headers.get('content-length')?.trim();
 if(length!==undefined&&/^\d+$/.test(length)&&Number(length)>maxBytes){
  // Cancel without reading any data; malformed lengths are checked by actual bytes.
  try{await request.body?.cancel();}catch{}
  throw new BodyTooLargeError();
 }
 if(!request.body)return new Uint8Array();
 const reader=request.body.getReader();const chunks:Uint8Array[]=[];let total=0;
 try{
  while(true){
   const {value,done}=await reader.read();if(done)break;
   if(value.byteLength>maxBytes-total){
    try{await reader.cancel();}catch{}
    throw new BodyTooLargeError();
   }
   total+=value.byteLength;chunks.push(value);
  }
 }finally{reader.releaseLock();}
 const result=new Uint8Array(total);let offset=0;
 for(const chunk of chunks){result.set(chunk,offset);offset+=chunk.byteLength;}
 return result;
}

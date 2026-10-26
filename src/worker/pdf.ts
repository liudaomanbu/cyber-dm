import {getDocumentProxy} from 'unpdf';
/** Preserve compiler page citations with the serverless PDF.js build. */
export class PDFParse {
 private document?:Awaited<ReturnType<typeof getDocumentProxy>>;
 constructor(private options:{data:Uint8Array}){}
 async getText(){
  this.document=await getDocumentProxy(this.options.data,{useSystemFonts:false,disableFontFace:true,maxImageSize:16_777_216});
  if(this.document.numPages>500)throw new Error('PDF超过500页，请先整理完整短本');
  const pages:{num:number;text:string}[]=[];let length=0;
  for(let num=1;num<=this.document.numPages;num++){
   const page=await this.document.getPage(num);const content=await page.getTextContent();
   const text=content.items.map(item=>'str' in item?item.str+(item.hasEOL?'\n':' '):'').join('');
   length+=text.length;if(length>90000)throw new Error('此版本一次支持最多9万字，请整理完整短本');
   pages.push({num,text});page.cleanup();
  }
  return {pages};
 }
 async destroy(){await this.document?.loadingTask.destroy();}
}

import {createHash,randomUUID} from "node:crypto";
import {mkdir,readFile,rename,rm,stat,writeFile} from "node:fs/promises";
import {basename,dirname,join} from "node:path";
import {ConversationShares,ShareError,type ShareGrant} from "./conversation-shares.js";

export const MAX_SHARED_UPLOAD_BYTES=32*1024*1024;
export const MAX_SHARED_ATTACHMENTS=10;
export const uploadIdPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Upload={id:string;shareId:string;threadId:string;name:string;path:string;size:number;kind:"image"|"file";mime:string;digest:string;createdAt:number;retained:boolean};
export const publicUpload=(u:Upload)=>({id:u.id,name:u.name,size:u.size,kind:u.kind,mime:u.mime});

function filename(value:string){
  let name=basename(value.replaceAll("\\","/")).replace(/[\u0000-\u001f\u007f]/g,"_").replace(/^\.+/,"_");
  const chars=Array.from(name);while(Buffer.byteLength(chars.join(""))>200)chars.pop();
  name=chars.join("");
  if(!name.trim())throw new ShareError(400,"Choose a file with a name.");
  return name;
}
function imageMime(data:Buffer):string|null{
  if(data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return "image/png";
  if(data[0]===255&&data[1]===216&&data[2]===255)return "image/jpeg";
  if(["GIF87a","GIF89a"].includes(data.subarray(0,6).toString()))return "image/gif";
  if(data.subarray(0,4).toString()==="RIFF"&&data.subarray(8,12).toString()==="WEBP")return "image/webp";
  return null;
}
function attribute(path:string){return path.replaceAll("&","&amp;").replaceAll('"',"&quot;");}
export class SharedUploads{
  private entries:Upload[]=[];
  private queue:Promise<unknown>=Promise.resolve();
  constructor(private readonly path:string,private readonly root:string,private readonly shares:ConversationShares,readonly localFiles=true){}
  async initialize(){
    try{
      const raw=JSON.parse(await readFile(this.path,"utf8"));
      if(!Array.isArray(raw)||raw.some(u=>!u||!uploadIdPattern.test(u.id)||!uploadIdPattern.test(u.shareId)||
        !uploadIdPattern.test(u.threadId)||typeof u.name!=="string"||u.name!==filename(u.name)||
        u.path!==join(this.root,u.shareId,u.id,u.name)||typeof u.retained!=="boolean"||typeof u.createdAt!=="number"))
        throw Error("Invalid shared upload registry");
      this.entries=raw;
    }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    await this.prune();
  }
  private exclusive<T>(work:()=>Promise<T>):Promise<T>{
    const result=this.queue.then(work);this.queue=result.catch(()=>{});return result;
  }
  private async persist(entries:Upload[]){
    await mkdir(dirname(this.path),{recursive:true,mode:0o700});
    const temp=this.path+"."+randomUUID()+".tmp";
    await writeFile(temp,JSON.stringify(entries),{mode:0o600});
    await rename(temp,this.path);this.entries=entries;
  }
  private find(grant:ShareGrant,id:string){
    const found=this.entries.find(u=>u.id===id&&u.shareId===grant.id&&u.threadId===grant.threadId);
    if(!found)throw new ShareError(404,"Attachment not found. Upload it again.");
    return found;
  }
  async put(grant:ShareGrant,id:string,name:string,data:Buffer){
    if(!this.localFiles)throw new ShareError(400,"File uploads require a local daemon.");
    if(!uploadIdPattern.test(id)||!Buffer.isBuffer(data))throw new ShareError(400,"Invalid upload.");
    if(data.length>MAX_SHARED_UPLOAD_BYTES)throw new ShareError(413,"Each file must be 32 MB or smaller.");
    const safeName=filename(name),digest=createHash("sha256").update(data).digest("hex");id=id.toLowerCase();
    return this.exclusive(async()=>{
      this.shares.active(grant.id);
      const prior=this.entries.find(u=>u.shareId===grant.id&&u.id===id);
      if(prior){
        if(prior.digest!==digest||prior.name!==safeName)throw new ShareError(409,"This upload ID was already used for another file.");
        return publicUpload(prior);
      }
      const parent=join(this.root,grant.id),folder=join(parent,id);
      await mkdir(parent,{recursive:true,mode:0o700});
      await mkdir(folder,{mode:0o700});
      const mime=imageMime(data);
      const entry:Upload={id,shareId:grant.id,threadId:grant.threadId,name:safeName,path:join(folder,safeName),
        size:data.length,kind:mime?"image":"file",mime:mime||"application/octet-stream",digest,createdAt:Date.now(),retained:false};
      try{
        await writeFile(entry.path,data,{flag:"wx",mode:0o600});
        this.shares.active(grant.id);
        await this.persist([...this.entries,entry]);
        return publicUpload(entry);
      }catch(e){await rm(folder,{recursive:true,force:true});throw e;}
    });
  }
  async remove(grant:ShareGrant,id:string){
    return this.exclusive(async()=>{
      this.shares.active(grant.id);
      const entry=this.find(grant,id);
      if(entry.retained)throw new ShareError(409,"Attachments already submitted to a conversation are kept with its history.");
      await this.persist(this.entries.filter(u=>u!==entry));
      await rm(dirname(entry.path),{recursive:true,force:true});
    });
  }
  async input(grant:ShareGrant,ids:string[]):Promise<Record<string,unknown>[]>{
    if(!ids.length)return [];
    return this.exclusive(async()=>{
      this.shares.active(grant.id);
      const entries=ids.map(id=>this.find(grant,id));
      for(const entry of entries){
        const file=await stat(entry.path).catch(()=>null);
        if(!file?.isFile())throw new ShareError(410,"An attachment is no longer available. Upload it again.");
      }
      this.shares.active(grant.id);
      await this.persist(this.entries.map(u=>entries.includes(u)?{...u,retained:true}:u));
      return entries.flatMap(entry=>{
        const parts:Record<string,unknown>[]=[{type:"text",text:':codex-file-citation{path="'+attribute(entry.path)+'" purpose="input"}',text_elements:[]}];
        if(entry.kind==="image")parts.push({type:"localImage",path:entry.path,detail:"auto"});
        return parts;
      });
    });
  }
  async prune(){
    return this.exclusive(async()=>{
      const old=this.entries.filter(u=>!u.retained&&u.createdAt<Date.now()-86400_000);
      if(!old.length)return;
      await this.persist(this.entries.filter(u=>!old.includes(u)));
      for(const entry of old)await rm(dirname(entry.path),{recursive:true,force:true});
    });
  }
}

import {randomBytes,randomUUID,createHash,createHmac,timingSafeEqual} from "node:crypto";
import {mkdir,readFile,writeFile,rename} from "node:fs/promises";
import {dirname} from "node:path";
import {daemonThreadId} from "./scheduled-task-target.js";

export class ShareError extends Error {
  constructor(readonly status:number,message:string){super(message);}
}
export type ShareGrant={id:string;threadId:string;tokenHash:string;createdAt:number;expiresAt:number|null;revokedAt:number|null};
export type ShareReceipt={shareId:string;requestId:string;digest:string;createdAt:number;state:"sending"|"accepted"|"uncertain"|"rejected";submissionId?:string};
type State={version:1;grants:ShareGrant[];receipts:ShareReceipt[]};
const sha=(value:string)=>createHash("sha256").update(value).digest("hex");
export const publicShare=(g:ShareGrant)=>({id:g.id,threadId:g.threadId,createdAt:g.createdAt,expiresAt:g.expiresAt,revokedAt:g.revokedAt});
export class ConversationShares {
  private state:State={version:1,grants:[],receipts:[]};
  private queue:Promise<unknown>=Promise.resolve();
  constructor(private readonly path:string,private readonly now:()=>number=Date.now){}
  async initialize(){
    try{
      const raw=JSON.parse(await readFile(this.path,"utf8"));
      if(raw.version!==1||!Array.isArray(raw.grants)||!Array.isArray(raw.receipts))throw Error("Invalid conversation shares");
      this.state=raw;
      if(this.state.receipts.some(r=>r.state==="sending")){
        await this.mutate(state=>{for(const r of state.receipts)if(r.state==="sending")r.state="uncertain";});
      }
    }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  }
  private mutate<T>(operation:(state:State)=>T):Promise<T>{
    const work=this.queue.then(async()=>{
      const next=structuredClone(this.state);
      const result=operation(next);
      await mkdir(dirname(this.path),{recursive:true,mode:0o700});
      const tmp=this.path+"."+randomUUID()+".tmp";
      await writeFile(tmp,JSON.stringify(next),{mode:0o600});
      await rename(tmp,this.path);
      this.state=next;
      return result;
    });
    this.queue=work.catch(()=>{});
    return work;
  }
  list(threadId:string){return this.state.grants.filter(g=>g.threadId===threadId).map(publicShare);}
  async create(threadId:string,days:unknown=7){
    const id=daemonThreadId(threadId);
    if(days!==null&&![1,7,30].includes(days as number))throw new ShareError(400,"Choose a valid link lifetime.");
    const secret=randomBytes(32).toString("base64url");
    const grant:ShareGrant={id:randomUUID(),threadId:id,tokenHash:sha(secret),createdAt:this.now(),expiresAt:days===null?null:this.now()+Number(days)*86400_000,revokedAt:null};
    await this.mutate(state=>{
      if(state.grants.filter(g=>!g.revokedAt&&(!g.expiresAt||g.expiresAt>this.now())).length>=200)
        throw new ShareError(409,"Too many active sharing links. Revoke unused links first.");
      state.grants.push(grant);
    });
    return {...publicShare(grant),token:grant.id+"."+secret};
  }
  async revoke(id:string){
    await this.mutate(state=>{
      const grant=state.grants.find(g=>g.id===id);
      if(!grant)throw new ShareError(404,"Sharing link not found.");
      grant.revokedAt=this.now();
    });
  }
  active(id:string):ShareGrant{
    const grant=this.state.grants.find(g=>g.id===id);
    if(!grant||grant.revokedAt!==null||(grant.expiresAt!==null&&grant.expiresAt<=this.now()))
      throw new ShareError(401,"This sharing link is invalid, expired, or revoked.");
    return structuredClone(grant);
  }
  authenticate(header:string|undefined):ShareGrant{
    const match=/^Share ([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(header||"");
    if(!match)throw new ShareError(401,"This sharing link is invalid, expired, or revoked.");
    const grant=this.active(match[1]);
    const a=Buffer.from(sha(match[2]),"hex"),b=Buffer.from(grant.tokenHash,"hex");
    if(a.length!==b.length||!timingSafeEqual(a,b))throw new ShareError(401,"This sharing link is invalid, expired, or revoked.");
    return grant;
  }
  cursor(grant:ShareGrant,cursor:string|null):string|null{
    if(!cursor)return null;
    const body=Buffer.from(cursor).toString("base64url");
    return body+"."+createHmac("sha256",grant.tokenHash).update(grant.threadId+":"+body).digest("base64url");
  }
  readCursor(grant:ShareGrant,value:unknown):string|null{
    if(value===undefined)return null;
    if(typeof value!=="string"||value.length>8192)throw new ShareError(400,"Invalid history cursor.");
    const [body,signature,...rest]=value.split(".");
    if(!body||!signature||rest.length)throw new ShareError(400,"Invalid history cursor.");
    const expected=createHmac("sha256",grant.tokenHash).update(grant.threadId+":"+body).digest("base64url");
    const a=Buffer.from(signature),b=Buffer.from(expected);
    if(a.length!==b.length||!timingSafeEqual(a,b))throw new ShareError(400,"Invalid history cursor.");
    return Buffer.from(body,"base64url").toString("utf8");
  }
  async reserve(grant:ShareGrant,requestId:string,text:string):Promise<{fresh:boolean;receipt:ShareReceipt}>{
    return this.mutate(state=>{
      this.active(grant.id);
      const digest=sha(text);
      const existing=state.receipts.find(r=>r.shareId===grant.id&&r.requestId===requestId);
      if(existing){
        if(existing.digest!==digest)throw new ShareError(409,"This message ID was already used for different text.");
        return {fresh:false,receipt:structuredClone(existing)};
      }
      const receipts=state.receipts.filter(r=>r.shareId===grant.id);
      if(receipts.filter(r=>r.createdAt>this.now()-60_000).length>=12)throw new ShareError(429,"Please wait before sending more messages.");
      if(receipts.length>=5000)throw new ShareError(429,"This link has reached its message limit. Ask the owner for a new link.");
      const receipt:ShareReceipt={shareId:grant.id,requestId,digest,createdAt:this.now(),state:"sending"};
      state.receipts.push(receipt);
      return {fresh:true,receipt};
    });
  }
  async finish(shareId:string,requestId:string,state:ShareReceipt["state"],submissionId?:string){
    return this.mutate(data=>{
      const r=data.receipts.find(x=>x.shareId===shareId&&x.requestId===requestId);
      if(!r)throw Error("Missing shared-message receipt");
      r.state=state;r.submissionId=submissionId;
    });
  }
}

import {SharedUploads,MAX_SHARED_ATTACHMENTS,uploadIdPattern} from "./shared-uploads.js";
import {createHash} from "node:crypto";
import {AppServerRpc,AppServerRpcError} from "./app-server-rpc.js";
import {threadWriter,BridgeRpcRejectedError} from "./bridge-owner.js";
import {ConversationShares,ShareError,type ShareGrant,type ShareReceipt} from "./conversation-shares.js";
type Obj=Record<string,any>;
export type SharedRpc={call:<T=Obj>(method:string,params?:Obj)=>Promise<T>;close:()=>void};
export type SharedMessage={id:string;role:"user"|"assistant"|"activity";text:string;content?:Obj[];item?:Obj;startedAtMs:number|null;completedAtMs:number|null};
const obj=(value:unknown):Obj=>value&&typeof value==="object"&&!Array.isArray(value)?value as Obj:{};
const str=(value:unknown)=>typeof value==="string"?value:"";
function unmaterializedHistory(error:unknown):boolean{
  return error instanceof AppServerRpcError&&["thread/items/list","thread/turns/list"].includes(error.method)&&
    error.message.includes("is not materialized yet")&&error.message.includes("before first user message");
}
function inputText(input:unknown):string{
  if(!Array.isArray(input))return "";
  return input.filter(x=>obj(x).type==="text").map(x=>str(x.text)).join("\n").slice(0,200_000);
}
export function sharedMessages(entries:Obj[]):SharedMessage[]{
  const messages:SharedMessage[]=[];
  for(const entry of [...entries].reverse()){
    const item=obj(entry.item);
    const id=str(entry.turnId)+":"+str(item.id);
    const time={
      startedAtMs:typeof entry.startedAtMs==="number"?entry.startedAtMs:null,
      completedAtMs:typeof entry.completedAtMs==="number"?entry.completedAtMs:null,
    };
    if(item.type==="userMessage"){
      const content=Array.isArray(item.content??item.input)?item.content??item.input:[];
      messages.push({id,role:"user",text:inputText(content),content,...time});
    }else if(item.type==="agentMessage"){
      messages.push({id,role:"assistant",text:str(item.text),...time});
    }else if(typeof item.type==="string"){
      // Display the stored activity only; no request IDs or approval actions are exposed as APIs.
      const display={...item};
      if(item.type==="reasoning")delete display.content;
      messages.push({id,role:"activity",text:"",item:display,...time});
    }
  }
  return messages;
}
export function validateSharedMessage(body:unknown):{text:string;requestId:string;attachmentIds:string[]}{
  const data=obj(body),ids=data.attachmentIds??[];
  if(Object.keys(data).some(k=>!["text","requestId","attachmentIds"].includes(k))||typeof data.text!=="string"||data.text.length>8000||
    !Array.isArray(ids)||ids.length>MAX_SHARED_ATTACHMENTS||ids.some(id=>typeof id!=="string"||!uploadIdPattern.test(id))||
    (!data.text.trim()&&!ids.length)||typeof data.requestId!=="string"||!uploadIdPattern.test(data.requestId))
    throw new ShareError(400,"Send message text (up to 8,000 characters), a message ID, and up to 10 uploaded attachment IDs.");
  const attachmentIds=ids.map((id:string)=>id.toLowerCase());
  if(new Set(attachmentIds).size!==attachmentIds.length)throw new ShareError(400,"An attachment can only appear once in a message.");
  return {text:data.text.trim(),requestId:data.requestId.toLowerCase(),attachmentIds};
}
function clientId(shareId:string,requestId:string){
  const h=createHash("sha256").update("shared-message:"+shareId+":"+requestId).digest("hex");
  return h.slice(0,8)+"-"+h.slice(8,12)+"-4"+h.slice(13,16)+"-a"+h.slice(17,20)+"-"+h.slice(20,32);
}
function receiptResponse(receipt:ShareReceipt){
  return {status:receipt.state==="accepted"?"queued":"uncertain",requestId:receipt.requestId};
}
export class SharedConversationGateway {
  private keepers=new Map<string,{rpc:SharedRpc;timer:ReturnType<typeof setInterval>}>();
  private sends=new Set<string>();
  constructor(private readonly shares:ConversationShares,
    private readonly connect:()=>Promise<SharedRpc>=()=>AppServerRpc.connect(),
    private readonly writer:typeof threadWriter=threadWriter,
    private readonly uploads?:SharedUploads){}
  async verify(threadId:string){
    const rpc=await this.connect();
    try{
      const r=await rpc.call("thread/read",{threadId,includeTurns:false});
      if(r.thread?.id!==threadId)throw new ShareError(404,"Conversation unavailable.");
      if(r.thread.ephemeral)throw new ShareError(400,"Only saved conversations can be shared.");
    }finally{rpc.close();}
  }
  async read(grant:ShareGrant,before:unknown){
    const cursor=this.shares.readCursor(grant,before);
    const rpc=await this.connect();
    try{
      const t=await rpc.call("thread/read",{threadId:grant.threadId,includeTurns:false});
      if(t.thread?.id!==grant.threadId)throw new ShareError(404,"Conversation unavailable.");
      let page:Obj;
      try{
        page=await rpc.call("thread/items/list",{threadId:grant.threadId,limit:100,sortDirection:"desc",...(cursor?{cursor}:{})});
      }catch(error){
        let empty=unmaterializedHistory(error);
        // For a saved thread awaiting its first message, some daemon versions
        // report items/list as unsupported. Confirm with turns/list before
        // treating it as empty; never hide an unsupported nonempty history.
        if(!cursor&&error instanceof AppServerRpcError&&error.method==="thread/items/list"&&
          error.message==="thread/items/list is not supported yet"){
          try{await rpc.call("thread/turns/list",{threadId:grant.threadId,limit:1,itemsView:"notLoaded"});}
          catch(probe){if(unmaterializedHistory(probe))empty=true;else throw probe;}
        }
        if(!cursor&&empty)page={data:[],nextCursor:null};
        else throw error;
      }
      let queue:Obj={data:[]};
      if(!cursor)queue=await rpc.call("thread/queue/list",{threadId:grant.threadId,limit:100});
      this.shares.active(grant.id);
      return {
        title:str(t.thread.name)||"Shared conversation",
        cwd:str(t.thread.cwd),
        status:str(t.thread.status?.type)||"idle",
        messages:sharedMessages(Array.isArray(page.data)?page.data:[]),
        queued:(Array.isArray(queue.data)?queue.data:[]).flatMap((q:Obj)=>{
          const text=inputText(q.input);
          return text||q.input?.length?[{id:str(q.id),text,content:q.input}]:[];
        }),
        olderCursor:this.shares.cursor(grant,typeof page.nextCursor==="string"?page.nextCursor:null),
        expiresAt:grant.expiresAt,
      };
    }finally{rpc.close();}
  }
  private retain(threadId:string,rpc:SharedRpc){
    if(this.keepers.has(threadId))return;
    let checking=false;
    const timer=setInterval(()=>{
      if(checking||this.sends.has(threadId))return;
      checking=true;
      void (async()=>{
        const r=await rpc.call("thread/read",{threadId,includeTurns:false});
        const q=await rpc.call("thread/queue/list",{threadId,limit:1});
        if(r.thread?.status?.type!=="active"&&!q.data?.length)this.release(threadId);
      })().catch(()=>this.release(threadId)).finally(()=>{checking=false;});
    },30_000);
    timer.unref();
    this.keepers.set(threadId,{rpc,timer});
  }
  private release(threadId:string){
    const keeper=this.keepers.get(threadId);
    if(keeper){clearInterval(keeper.timer);keeper.rpc.close();this.keepers.delete(threadId);}
  }
  close(){for(const id of this.keepers.keys())this.release(id);}
  async send(grant:ShareGrant,body:unknown){
    const {text,requestId,attachmentIds}=validateSharedMessage(body);
    if(this.sends.has(grant.threadId))throw new ShareError(409,"Another message is being submitted. Try again shortly.");
    this.sends.add(grant.threadId);
    let rpc:SharedRpc|undefined,attempted=false;
    try{
      const reservation=await this.shares.reserve(grant,requestId,attachmentIds.length?JSON.stringify({text,attachmentIds}):text);
      if(!reservation.fresh){
        if(reservation.receipt.state==="rejected")throw new ShareError(409,"This message was rejected. Check the conversation before sending again.");
        return receiptResponse(reservation.receipt);
      }
      try{
        if(attachmentIds.length&&!this.uploads)throw new ShareError(503,"Attachments are unavailable.");
        const input:Obj[]=text?[{type:"text",text,text_elements:[]}]:[];
        if(attachmentIds.length)input.push(...await this.uploads!.input(grant,attachmentIds));
        let owner=this.writer(grant.threadId);
        if(!owner){
          rpc=this.keepers.get(grant.threadId)?.rpc;
          if(!rpc){
            if(this.keepers.size>=32)throw new ShareError(503,"Shared conversations are busy. Please try later.");
            rpc=await this.connect();
            // Bind only this stored thread; preserve all existing settings.
            const resumed=await rpc.call("thread/resume",{threadId:grant.threadId,excludeTurns:true});
            if(resumed.thread?.id!==grant.threadId)throw new ShareError(404,"Conversation unavailable.");
            this.retain(grant.threadId,rpc);
          }
        }
        this.shares.active(grant.id);
        attempted=true;
        const params={threadId:grant.threadId,input,clientUserMessageId:clientId(grant.id,requestId)};
        const result=owner?await owner.call("thread/queue/add",params):await rpc!.call("thread/queue/add",params);
        const submissionId=str(result.queuedSubmission?.id);
        if(!submissionId)throw Error("Missing queue acknowledgement");
        await this.shares.finish(grant.id,requestId,"accepted",submissionId);
        return {status:"queued",requestId};
      }catch(error){
        const definitelyRejected=!attempted||error instanceof BridgeRpcRejectedError||
          (error instanceof AppServerRpcError&&!error.ambiguous);
        await this.shares.finish(grant.id,requestId,definitelyRejected?"rejected":"uncertain");
        if(!definitelyRejected)return {status:"uncertain",requestId};
        if(error instanceof ShareError)throw error;
        throw new ShareError(503,"The conversation could not accept this message. Ask its owner to check the connection.");
      }
    }finally{
      this.sends.delete(grant.threadId);
      if(rpc&&!this.keepers.has(grant.threadId))rpc.close();
    }
  }
}

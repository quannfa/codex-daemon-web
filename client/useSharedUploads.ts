import {useCallback,useEffect,useRef,useState} from "react";
import {clientUUID} from "./client-uuid";
export type SharedUpload={id:string;name:string;size:number;file:File;preview?:string;status:"uploading"|"ready"|"error";error?:string};
type Request=(path:string,init?:RequestInit)=>Promise<any>;
export function useSharedUploads(request:Request,enabled:boolean,onError:(error:string)=>void){
  const [uploads,setUploads]=useState<SharedUpload[]>([]);
  const current=useRef<SharedUpload[]>([]);
  const controllers=useRef(new Map<string,AbortController>());
  const mounted=useRef(true);
  const update=useCallback((next:SharedUpload[])=>{current.current=next;if(mounted.current)setUploads(next);},[]);
  const clear=useCallback(()=>{
    for(const c of controllers.current.values())c.abort();controllers.current.clear();
    for(const u of current.current)if(u.preview)URL.revokeObjectURL(u.preview);
    update([]);
  },[update]);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;clear();};},[clear]);
  const upload=useCallback(async(draft:SharedUpload)=>{
    if(!current.current.some(u=>u.id===draft.id))return;
    const controller=new AbortController();controllers.current.set(draft.id,controller);
    update(current.current.map(u=>u.id===draft.id?{...u,status:"uploading",error:undefined}:u));
    try{
      const result=await request("uploads/"+draft.id,{method:"POST",headers:{"Content-Type":"application/octet-stream","X-File-Name":encodeURIComponent(draft.file.name||"attachment")},body:draft.file,signal:controller.signal});
      if(!controller.signal.aborted)update(current.current.map(u=>u.id===draft.id?{...u,name:result.name,status:"ready"}:u));
    }catch(error){
      if(!controller.signal.aborted)update(current.current.map(u=>u.id===draft.id?{...u,status:"error",error:error instanceof Error?error.message:String(error)}:u));
    }finally{if(controllers.current.get(draft.id)===controller)controllers.current.delete(draft.id);}
  },[request,update]);
  const add=useCallback((files:File[])=>{
    if(!enabled||!files.length)return;
    if(current.current.length+files.length>10){onError("Attach up to 10 files to one message.");return;}
    if(files.some(f=>f.size>32*1024*1024)){onError("Each file must be 32 MB or smaller.");return;}
    const drafts:SharedUpload[]=files.map(file=>({id:clientUUID(),name:file.name||"attachment",size:file.size,file,
      preview:file.type.startsWith("image/")?URL.createObjectURL(file):undefined,status:"uploading"}));
    update([...current.current,...drafts]);
    void (async()=>{for(const draft of drafts)await upload(draft);})();
  },[enabled,onError,update,upload]);
  const remove=useCallback((id:string)=>{
    if(!enabled)return;
    controllers.current.get(id)?.abort();
    const draft=current.current.find(u=>u.id===id);
    if(draft?.preview)URL.revokeObjectURL(draft.preview);
    update(current.current.filter(u=>u.id!==id));
    void request("uploads/"+id,{method:"DELETE"}).catch(()=>{});
  },[enabled,request,update]);
  const retry=(id:string)=>{const draft=current.current.find(u=>u.id===id);if(enabled&&draft?.status==="error")void upload(draft);};
  return {uploads,add,remove,retry,clear};
}

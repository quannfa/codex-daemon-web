import { useEffect, useState } from "react";
export type ResourceInfo = {id:string; path:string; name:string; size:number; kind:string; mime:string; shareToken?:string};
export type ResourceScope = {threadId?:string|null; baseResourceId?:string;shareToken?:string};
export async function registerResource(path:string, scope:ResourceScope = {}, signal?:AbortSignal):Promise<ResourceInfo> {
  const response=await fetch(scope.shareToken?"/api/shared/resources":"/api/resources",{
    method:"POST",credentials:scope.shareToken?"omit":"same-origin",headers:{"Content-Type":"application/json",...(scope.shareToken?{Authorization:"Share "+scope.shareToken}:{})},signal,
    body:JSON.stringify({path,...(!scope.shareToken&&scope.threadId?{threadId:scope.threadId}:{}),...(scope.baseResourceId?{baseResourceId:scope.baseResourceId}:{})}),
  });
  const data=await response.json();
  if(!response.ok)throw Error(data.error || (response.status===401?"Sign in to view this resource.":"Could not open resource."));
  return {...data,...(scope.shareToken?{shareToken:scope.shareToken}:{})};
}
export function resourceUrl(info:ResourceInfo,download=false) {
  return (info.shareToken?"/api/shared/resources/":"/api/resources/")+info.id+"/"+encodeURIComponent(info.name)+(download?"?download=1":"");
}
export function useResource(path:string,scope:ResourceScope={}) {
  const key=JSON.stringify([path,scope.threadId,scope.baseResourceId,scope.shareToken]);
  const [state,setState]=useState<{key:string;info?:ResourceInfo;error?:string}>({key});
  useEffect(()=>{
    const controller=new AbortController();
    setState({key});
    void registerResource(path,scope,controller.signal).then(info=>setState({key,info})).catch(error=>{
      if(!controller.signal.aborted)setState({key,error:error instanceof Error?error.message:String(error)});
    });
    return()=>controller.abort();
  },[key]);
  return state.key===key?state:{key};
}

export async function readResourceText(info:ResourceInfo,signal:AbortSignal,limit=5_000_000):Promise<string> {
  if(info.size>limit)throw Error("Text preview is limited to 5 MB. Download the original file instead.");
  const response=await fetch(resourceUrl(info),{credentials:info.shareToken?"omit":"same-origin",headers:info.shareToken?{Authorization:"Share "+info.shareToken}:{},cache:"no-store",signal});
  if(!response.ok)throw Error("Could not read the original file.");
  const reader=response.body!.getReader();let length=0;const chunks:Uint8Array[]=[];
  while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>limit){await reader.cancel();throw Error("Text preview exceeds 5 MB. Download the original file instead.");}chunks.push(value);}
  const bytes=new Uint8Array(length);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  return new TextDecoder().decode(bytes);
}


// Native image/PDF/download elements cannot attach Authorization. Use an in-memory
// object URL fetched with the share header; never put the bearer in a URL or cookie.
export function useResourceUrl(info?:ResourceInfo, enabled=true):{url?:string;error?:string}{
  const [state,setState]=useState<{key:string;url?:string;error?:string}>({key:""});
  const key=info&&enabled?JSON.stringify([info.id,info.shareToken]):"";
  useEffect(()=>{
    if(!info?.shareToken||!enabled)return;
    const controller=new AbortController();let objectUrl:string|undefined;
    setState({key});
    void fetch(resourceUrl(info),{credentials:"omit",cache:"no-store",headers:{Authorization:"Share "+info.shareToken},signal:controller.signal})
      .then(async response=>{
        if(!response.ok){
          const data=await response.json().catch(()=>({}));
          throw Error(data.error||"Could not read the original file.");
        }
        // Preserve the server's inert MIME types for HTML/SVG source.
        return response.blob();
      }).then(blob=>{
        if(controller.signal.aborted)return;
        objectUrl=URL.createObjectURL(blob);setState({key,url:objectUrl});
      }).catch(error=>{if(!controller.signal.aborted)setState({key,error:error instanceof Error?error.message:String(error)});});
    return()=>{controller.abort();if(objectUrl)URL.revokeObjectURL(objectUrl);};
  },[key]);
  if(!info||!enabled)return {};
  if(!info.shareToken)return {url:resourceUrl(info)};
  return state.key===key?state:{};
}

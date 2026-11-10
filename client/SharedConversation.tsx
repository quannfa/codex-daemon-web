import {useCallback,useEffect,useMemo,useRef,useState} from "react";
import {Send,LockKeyhole,Paperclip,X,RotateCcw,FileText} from "lucide-react";
import {clientUUID} from "./client-uuid";
import {FileReferenceContext} from "./ResourceMarkdown";
import {useSharedUploads} from "./useSharedUploads";
import SharedActivity,{SharedInput,type SharedMessage as Message} from "./SharedActivity";

type Snapshot={title:string;cwd:string;status:string;messages:Message[];queued:{id:string;text:string;content?:Message["content"]}[];olderCursor:string|null;expiresAt:number|null};
export default function SharedConversation({token}:{token:string}){
  const [snapshot,setSnapshot]=useState<Snapshot|null>(null);
  const [older,setOlder]=useState<Message[]>([]);
  const [cursor,setCursor]=useState<string|null>(null);
  const [text,setText]=useState("");
  const [sending,setSending]=useState(false);
  const [loadingOlder,setLoadingOlder]=useState(false);
  const [error,setError]=useState("");
  const [notice,setNotice]=useState("");
  const [unavailable,setUnavailable]=useState(false);
  const fatal=useRef(false),reading=useRef(false),hasOlder=useRef(false);
  const pending=useRef<{signature:string;id:string}|null>(null);
  const sendingRef=useRef(false);
  const fileInput=useRef<HTMLInputElement>(null);
  const scroll=useRef<HTMLDivElement>(null),follow=useRef(true);
  const valid=/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/.test(token);
  const request=useCallback(async(path:string,init:RequestInit={})=>{
    const headers=new Headers(init.headers);headers.set("Authorization","Share "+token);
    const response=await fetch("/api/shared/"+path,{...init,credentials:"omit",cache:"no-store",headers});
    const data=await response.json().catch(()=>({}));
    if(response.status===401){
      fatal.current=true;setUnavailable(true);setSnapshot(null);setOlder([]);
    }
    if(!response.ok)throw Error(data.error||(response.status===413?"Each file must be 32 MB or smaller.":"Shared conversation is unavailable."));
    return data;
  },[token]);
  const api=useCallback((path:string,body?:unknown)=>request(path,body===undefined?{}:{
    method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body),
  }),[request]);
  const attachments=useSharedUploads(request,Boolean(snapshot)&&!sending&&!unavailable,setError);
  const clearAttachments=attachments.clear;
  useEffect(()=>{if(unavailable)clearAttachments();},[unavailable,clearAttachments]);
  const uploadsReady=attachments.uploads.every(u=>u.status==="ready");
  const canSend=Boolean(snapshot)&&!sending&&!unavailable&&uploadsReady&&Boolean(text.trim()||attachments.uploads.length);
  const refresh=useCallback(async()=>{
    if(reading.current||fatal.current||!valid)return;
    reading.current=true;
    try{
      const data:Snapshot=await api("conversation");
      if(fatal.current)return;
      setSnapshot(data);setError("");
      if(!hasOlder.current)setCursor(data.olderCursor);
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{reading.current=false;}
  },[api,valid]);
  useEffect(()=>{
    if(!valid){fatal.current=true;setUnavailable(true);return;}
    fatal.current=false;
    void refresh();
    const timer=setInterval(()=>{if(!document.hidden)void refresh();},3000);
    const focus=()=>void refresh();
    window.addEventListener("focus",focus);
    return()=>{clearInterval(timer);window.removeEventListener("focus",focus);fatal.current=true;};
  },[refresh,valid]);
  const messages=useMemo(()=>{
    const all=new Map<string,Message>();
    for(const message of [...older,...(snapshot?.messages||[])])all.set(message.id,message);
    return [...all.values()];
  },[older,snapshot]);
  useEffect(()=>{
    if(follow.current&&scroll.current)scroll.current.scrollTop=scroll.current.scrollHeight;
  },[messages,snapshot?.queued]);
  const loadOlder=async()=>{
    if(!cursor)return;
    setLoadingOlder(true);
    const height=scroll.current?.scrollHeight||0;
    try{
      const data:Snapshot=await api("conversation?before="+encodeURIComponent(cursor));
      if(fatal.current)return;
      hasOlder.current=true;follow.current=false;
      setOlder(current=>[...data.messages,...current]);setCursor(data.olderCursor);
      requestAnimationFrame(()=>{if(scroll.current)scroll.current.scrollTop+=scroll.current.scrollHeight-height;});
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setLoadingOlder(false);}
  };
  const send=async()=>{
    if(!canSend||sendingRef.current||fatal.current)return;
    sendingRef.current=true;setSending(true);setNotice("");setError("");
    const content=text.trim(),attachmentIds=attachments.uploads.map(u=>u.id);
    const signature=JSON.stringify({text:content,attachmentIds});
    try{
      if(pending.current?.signature!==signature)pending.current={signature,id:clientUUID()};
      const result=await api("messages",{text:content,requestId:pending.current!.id,...(attachmentIds.length?{attachmentIds}:{})});
      if(result.status==="queued"){
        setText("");attachments.clear();pending.current=null;follow.current=true;
        setNotice("Message queued for this conversation.");
      }else setNotice("Delivery is not yet confirmed. Check the conversation before retrying; retries use the same message ID.");
      await refresh();
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{sendingRef.current=false;setSending(false);}
  };
  return <main className="shared-conversation-page">
    <header className="shared-conversation-header">
      <LockKeyhole size={21}/>
      <div><span>Shared conversation</span><h1>{snapshot?.title||"Codex conversation"}</h1></div>
      {snapshot?<span className="shared-status">{snapshot.status==="active"?"Working":"Connected"}</span>:null}
    </header>
    {unavailable?<section className="shared-unavailable" role="alert"><h2>Sharing link unavailable</h2><p>This link is invalid, expired, or revoked. Ask the owner for a new link.</p></section>:<>
      <div className="shared-message-list" ref={scroll} onScroll={()=>{
        const el=scroll.current;if(el)follow.current=el.scrollHeight-el.scrollTop-el.clientHeight<100;
      }}>
        {!snapshot?<p role="status">Connecting to shared conversation…</p>:null}
        {cursor?<button className="shared-load-older" type="button" disabled={loadingOlder} onClick={()=>void loadOlder()}>Load earlier messages</button>:null}
        {snapshot&&messages.length===0&&!snapshot.queued.length?<p className="shared-empty">Send a message to begin.</p>:null}
        <FileReferenceContext.Provider value={{cwd:snapshot?.cwd||"",shareToken:token}}>
          {messages.map(message=><SharedActivity key={message.id} message={message}/>)}
        {snapshot?.queued.map(message=><article key={message.id} className="shared-message shared-message-queued">
          <span className="shared-role">Queued message</span><SharedInput text={message.text} content={message.content}/>
        </article>)}
        </FileReferenceContext.Provider>
      </div>
      <footer className="shared-compose"
        onDragOver={e=>{if(Array.from(e.dataTransfer.types).includes("Files"))e.preventDefault();}}
        onDrop={e=>{if(e.dataTransfer.files.length){e.preventDefault();attachments.add(Array.from(e.dataTransfer.files));}}}>
        {error?<p role="alert" className="share-error">{error}</p>:null}
        {notice?<p role="status" className="shared-notice">{notice}</p>:null}
        {attachments.uploads.length?<ul className="shared-upload-list">{attachments.uploads.map(upload=><li key={upload.id} className={"shared-upload-"+upload.status}>
          {upload.preview?<img src={upload.preview} alt="Attached image"/>:<FileText size={21} aria-hidden="true"/>}
          <span className="shared-upload-info"><strong>{upload.name}</strong><small>{upload.status==="uploading"?"Uploading…":upload.status==="error"?upload.error:"Ready to send"}</small></span>
          {upload.status==="error"?<button type="button" aria-label="Retry upload" disabled={sending} onClick={()=>attachments.retry(upload.id)}><RotateCcw size={16}/></button>:null}
          <button type="button" aria-label="Remove attachment" title={upload.name} disabled={sending} onClick={()=>attachments.remove(upload.id)}><X size={16}/></button>
        </li>)}</ul>:null}
        <form onSubmit={e=>{e.preventDefault();void send();}}>
          <input type="file" ref={fileInput} multiple hidden aria-label="Attach images or files" disabled={!snapshot||sending}
            onChange={e=>{attachments.add(Array.from(e.target.files||[]));e.target.value="";}}/>
          <button type="button" aria-label="Attach images or files" title="Attach images or files" disabled={!snapshot||sending} onClick={()=>fileInput.current?.click()}><Paperclip size={19}/></button>
          <textarea aria-label="Message this conversation" placeholder="Message this conversation…" rows={3} maxLength={8000}
            disabled={!snapshot||sending} value={text} onChange={e=>setText(e.target.value)}
            onPaste={e=>{
              const files=Array.from(e.clipboardData.files);
              if(!files.length)return;
              e.preventDefault();
              const value=e.clipboardData.getData("text/plain");
              if(value){const input=e.currentTarget;setText(current=>(current.slice(0,input.selectionStart)+value+current.slice(input.selectionEnd)).slice(0,8000));}
              attachments.add(files);
            }}
            onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();void send();}}}/>
          <button className="share-primary" type="submit" aria-label="Send message" disabled={!canSend}><Send size={19}/></button>
        </form>
        <small>Up to 10 files, 32 MB each. Paste screenshots or drop files here.</small>
        <small>Only this conversation is shared. Conversation options are managed by its owner.</small>
      </footer>
    </>}
  </main>;
}

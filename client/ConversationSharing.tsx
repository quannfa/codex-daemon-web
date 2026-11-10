import {useEffect,useState} from "react";
import {Copy,Link2,Trash2,X} from "lucide-react";
type Grant={id:string;createdAt:number;expiresAt:number|null;revokedAt:number|null};
async function clipboard(text:string){
  try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);return;}}catch{/* HTTP/local clipboard fallback. */}
  const input=document.createElement("textarea");
  input.value=text;input.style.position="fixed";input.style.opacity="0";
  document.body.append(input);input.select();
  const ok=document.execCommand("copy");input.remove();
  if(!ok)throw Error("Copy failed. Select and copy the link below.");
}
export default function ConversationSharing({threadId,title,onClose}:{threadId:string;title:string;onClose:()=>void}){
  const [shares,setShares]=useState<Grant[]>([]);
  const [days,setDays]=useState("7");
  const [link,setLink]=useState("");
  const [linkId,setLinkId]=useState("");
  const [busy,setBusy]=useState(false);
  const [ready,setReady]=useState(false);
  const [error,setError]=useState("");
  const [message,setMessage]=useState("");
  const refresh=async()=>{
    const response=await fetch("/api/shares?threadId="+encodeURIComponent(threadId),{credentials:"same-origin"});
    const data=await response.json();
    if(!response.ok)throw Error(data.error||"Could not load sharing links.");
    setShares(data.shares);setReady(true);
  };
  useEffect(()=>{
    let alive=true;
    void fetch("/api/shares?threadId="+encodeURIComponent(threadId),{credentials:"same-origin"})
      .then(async response=>{const data=await response.json();if(!response.ok)throw Error(data.error||"Could not load sharing links.");return data;})
      .then(data=>{if(alive){setShares(data.shares);setReady(true);}})
      .catch(e=>{if(alive)setError(String(e));});
    return()=>{alive=false;};
  },[threadId]);
  const create=async()=>{
    setBusy(true);setError("");setMessage("");
    try{
      const response=await fetch("/api/shares",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({threadId,expiresInDays:days==="never"?null:Number(days)})});
      const data=await response.json();
      if(!response.ok)throw Error(data.error||"Could not create sharing link.");
      const url=new URL(window.location.pathname,window.location.origin);
      url.hash="share="+data.token;
      setLink(url.toString());setLinkId(data.id);
      await refresh();
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };
  const revoke=async(id:string)=>{
    setBusy(true);setError("");setMessage("");
    try{
      const response=await fetch("/api/shares/"+encodeURIComponent(id),{method:"DELETE",credentials:"same-origin"});
      if(!response.ok)throw Error("Could not revoke sharing link.");
      if(id===linkId){setLink("");setLinkId("");}
      await refresh();setMessage("Sharing link revoked.");
    }catch(e){setError(e instanceof Error?e.message:String(e));}
    finally{setBusy(false);}
  };
  return <div className="modal-scrim settings-scrim" onClick={()=>{if(!busy)onClose();}}>
    <section className="conversation-sharing" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title"
      onClick={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==="Escape"&&!busy)onClose();}}>
      <header><h2 id="share-dialog-title">Share conversation</h2><button type="button" aria-label="Close" disabled={busy} onClick={onClose}><X size={19}/></button></header>
      <p className="share-conversation-title">{title}</p>
      <p className="codex-extensions-note">Anyone with this link can read this conversation's chat history and send messages using its existing capabilities. Other conversations and settings are not available on the shared page.</p>
      <div className="share-create-row">
        <label>Link lifetime <select value={days} onChange={e=>setDays(e.target.value)} disabled={busy}>
          <option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option><option value="never">Until revoked</option>
        </select></label>
        <button type="button" className="share-primary" disabled={!ready||busy} onClick={()=>void create()}><Link2 size={16}/>Generate sharing link</button>
      </div>
      {link?<div className="share-link-result">
        <label htmlFor="generated-share-link">Sharing link</label>
        <input id="generated-share-link" readOnly value={link} onFocus={e=>e.target.select()}/>
        <button type="button" onClick={()=>void clipboard(link).then(()=>setMessage("Sharing link copied.")).catch(e=>setError(e.message))}><Copy size={16}/>Copy sharing link</button>
        <p className="codex-extensions-note">Copy this link now. The secret is not stored on the server and cannot be shown again.</p>
      </div>:null}
      <h3>Sharing links</h3>
      {!ready&&!error?<p>Loading…</p>:shares.length===0?<p className="codex-extensions-note">No sharing links yet.</p>:
        <ul className="share-link-list">{[...shares].reverse().map(share=>{
          const inactive=share.revokedAt!==null||(share.expiresAt!==null&&share.expiresAt<=Date.now());
          return <li key={share.id}>
            <div><span>{new Date(share.createdAt).toLocaleString()}</span>
              <small>{share.revokedAt!==null?"Revoked":inactive?"Expired":share.expiresAt===null?"Until revoked":new Date(share.expiresAt).toLocaleString()}</small></div>
            <button type="button" disabled={busy||inactive} onClick={()=>void revoke(share.id)}><Trash2 size={15}/>Revoke link</button>
          </li>;
        })}</ul>}
      {error?<p role="alert" className="share-error">{error}</p>:null}
      {message?<p role="status">{message}</p>:null}
    </section>
  </div>;
}

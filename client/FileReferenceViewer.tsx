import {useContext,useEffect,useState} from "react";
import {createPortal} from "react-dom";
import DOMPurify from "dompurify";
import { FileReferenceContext, MarkdownContent } from "./ResourceMarkdown";
import { sanitizeSvg } from "./MarkdownCodeBlock";
import { resourceUrl,useResourceUrl,useResource,readResourceText,type ResourceScope } from "./resources";
const MAX_TEXT=5_000_000;
export default function FileReferenceViewer({path,scope={},onClose}:{path:string;scope?:ResourceScope;onClose:()=>void}) {
  const context=useContext(FileReferenceContext);
  const {info,error}=useResource(path,scope);
  const media=useResourceUrl(info);
  const [text,setText]=useState("");
  const [loaded,setLoaded]=useState(false);
  const [readError,setReadError]=useState("");
  const [source,setSource]=useState(false);
  useEffect(()=>{
    setText("");setLoaded(false);setReadError("");setSource(false);
    if(!info||!["text","markdown","svg","html"].includes(info.kind))return;
    if(info.size>MAX_TEXT){setReadError("Text preview is limited to 5 MB. Download the original file instead.");return;}
    const controller=new AbortController();
    void readResourceText(info,controller.signal).then(value=>{
      if(!controller.signal.aborted){setText(value);setLoaded(true);}
    }).catch(e=>{if(!controller.signal.aborted)setReadError(e instanceof Error?e.message:String(e));});
    return()=>controller.abort();
  },[info]);
  let svg="",svgError="";
  if(info?.kind==="svg"&&loaded&&!source){try{svg=sanitizeSvg(text);}catch(e){svgError=String(e);}}
  const html=info?.kind==="html"&&loaded?DOMPurify.sanitize(text,{FORBID_TAGS:["script","iframe","object","embed","form","base","link"],FORBID_ATTR:["srcset"]}):"";
  const nested={...context,cwd:path.slice(0,path.lastIndexOf("/"))||"/",threadId:scope.threadId,shareToken:scope.shareToken,baseResourceId:info?.id,openThread:context?.openThread};
  return createPortal(<div className="modal-scrim file-reference-scrim" onClick={onClose}>
    <section className="file-reference-panel" role="dialog" aria-modal="true" aria-label="File preview" onClick={e=>e.stopPropagation()} onKeyDown={e=>{if(e.key==="Escape"){e.stopPropagation();onClose();}}}>
      <div className="file-reference-heading"><strong title={path}>{path.split("/").at(-1)||path}</strong>
        <div className="resource-actions">{info&&media.url?<><a href={info.shareToken?media.url:resourceUrl(info,true)} download={info.name}>Download</a><a href={media.url} target="_blank" rel="noopener noreferrer">Open original</a></>:null}
          <button type="button" autoFocus onClick={onClose}>Close</button></div>
      </div>
      <small className="file-reference-path">{path}</small>
      {info&&["markdown","svg","html"].includes(info.kind)?<button type="button" className="settings-toggle" onClick={()=>setSource(v=>!v)}>{source?"Show preview":"Show source"}</button>:null}
      {error||readError||media.error?<p role="alert">{error||readError||media.error}</p>:!info?<p>Reading file…</p>:
        info.kind==="image"?(media.url?<img src={media.url} alt={info.name} className="file-reference-image" onError={()=>setReadError("Image unavailable. The original file may have changed or your session expired.")}/>:<p>Reading file…</p>):
        info.kind==="pdf"?(media.url?<iframe src={media.url} title="PDF preview" className="file-reference-pdf"/>:<p>Reading file…</p>):
        info.kind==="binary"?<p>Preview is unavailable for this file type. Download the original file.</p>:
        !loaded?<p>Reading file…</p>:
        source?<pre className="file-reference-text">{text}</pre>:
        info.kind==="markdown"?<FileReferenceContext.Provider value={nested}><MarkdownContent text={text}/></FileReferenceContext.Provider>:
        info.kind==="svg"?svg?<div className="resource-svg" dangerouslySetInnerHTML={{__html:svg}}/>:<p role="alert">{svgError}</p>:
        info.kind==="html"?<><p className="settings-page-note">Static HTML preview. Scripts and external resources are disabled.</p><iframe title="HTML preview" className="file-reference-pdf" sandbox="" referrerPolicy="no-referrer" srcDoc={'<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src data:; style-src \'unsafe-inline\'; form-action \'none\'; base-uri \'none\'">'+html}/></>:
        <pre className="file-reference-text">{text}</pre>}
    </section>
  </div>,document.body);
}

import { createContext, useContext, useState, type ComponentProps } from "react";
import ReactMarkdown, {type ExtraProps} from "react-markdown";
import remarkDirective from "remark-directive";
import {FileText} from "lucide-react";
import {remarkFileCitations} from "./file-citations";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import { normalizeMathDelimiters } from "./math-markdown";
import { MarkdownCodeBlock, sanitizeSvg } from "./MarkdownCodeBlock";
import FileReferenceViewer from "./FileReferenceViewer";
import { localReferencePath, safeMarkdownUrl } from "./resource-paths";
import { useResourceUrl, useResource, readResourceText, type ResourceScope } from "./resources";
import { useEffect } from "react";
export type FileReferenceContextValue = ResourceScope & {cwd:string;openThread?:((id:string)=>void)};
export const FileReferenceContext=createContext<FileReferenceContextValue|null>(null);
export function MarkdownContent({text}:{text:string}) {
  return <div className="markdown-content"><ReactMarkdown remarkPlugins={[remarkGfm,remarkMath,remarkDirective,remarkFileCitations]} rehypePlugins={[[rehypeKatex,{trust:false,strict:"ignore",maxExpand:1000,maxSize:20}]]} urlTransform={safeMarkdownUrl}
    components={{a:MarkdownLink,img:MarkdownImage,pre:MarkdownCodeBlock}}>{normalizeMathDelimiters(text)}</ReactMarkdown></div>;
}
function MarkdownLink({href,children,node}:ComponentProps<"a">&ExtraProps) {
  const context=useContext(FileReferenceContext);
  const [preview,setPreview]=useState(false);
  const value=href||"";
  const purpose=node?.properties.dataCodexFileCitation;
  if(purpose){
    const path=context?localReferencePath(value,context.cwd):null;
    const label=purpose==="output"?"Output file":purpose==="input"?"Input file":"Referenced file";
    const labelZh=purpose==="output"?"输出文件":purpose==="input"?"输入文件":"引用文件";
    return <><button type="button" className="markdown-file-citation" title={path||value}
      disabled={!path||!context} onClick={()=>setPreview(true)}>
      <FileText size={22} aria-hidden="true"/>
      <span className="file-citation-label"><strong>{children}</strong><small><span className="file-citation-purpose-en">{label}</span><span className="file-citation-purpose-zh">{labelZh}</span></small></span>
    </button>{preview&&path&&context?<FileReferenceViewer path={path} scope={context} onClose={()=>setPreview(false)}/>:null}</>;
  }
  const threadId=value.match(/^codex:\/\/threads\/([a-f0-9-]{20,})/i)?.[1];
  if(threadId&&context&&!context.openThread)return <span>{children}</span>;
  if(threadId&&context?.openThread)return <button type="button" className="markdown-local-link" onClick={()=>context.openThread?.(threadId)}>{children}</button>;
  if(/^https?:\/\//i.test(value))return <a href={value} target="_blank" rel="noopener noreferrer">{children}</a>;
  if(value.startsWith("#"))return context?.shareToken?<span>{children}</span>:<a href={value}>{children}</a>;
  const path=context?localReferencePath(value,context.cwd):null;
  if(!path||!context)return <span title={value}>{children}</span>;
  return <><button type="button" className="markdown-local-link" title={path} onClick={()=>setPreview(true)}>{children}</button>
    {preview?<FileReferenceViewer path={path} scope={context} onClose={()=>setPreview(false)}/>:null}</>;
}
export function LocalResourceImage({path,alt,scope}:{path:string;alt:string;scope:ResourceScope}) {
  const {info,error}=useResource(path,scope);
  const media=useResourceUrl(info,info?.kind==="image");
  const [failed,setFailed]=useState(false);
  const [preview,setPreview]=useState(false);
  const [svg,setSvg]=useState("");
  const [svgError,setSvgError]=useState("");
  useEffect(()=>{
    setFailed(false);setSvg("");setSvgError("");
    if(!info||info.kind!=="svg")return;
    if(info.size>5_000_000){setSvgError("SVG exceeds the 5 MB preview limit. Open the file to download it.");return;}
    const controller=new AbortController();
    void readResourceText(info,controller.signal).then(source=>{
      if(!controller.signal.aborted)setSvg(sanitizeSvg(source));
    }).catch(e=>{if(!controller.signal.aborted)setSvgError(String(e));});
    return()=>controller.abort();
  },[info]);
  return <span className="local-resource-image">
    {error||svgError||media.error?<span className="resource-error" role="status">{alt}: {error||svgError||media.error}</span>:
    !info||(info.kind==="image"&&!media.url)?<span className="resource-loading">Loading image…</span>:
    info.kind==="svg"&&svg?<button type="button" className="resource-image-button" aria-label={alt} onClick={()=>setPreview(true)}><span dangerouslySetInnerHTML={{__html:svg}}/></button>:
    info.kind==="image"&&!failed?<button type="button" className="resource-image-button" onClick={()=>setPreview(true)}><img src={media.url} alt={alt} loading="lazy" onError={()=>setFailed(true)}/></button>:
    <button type="button" className="markdown-local-link" onClick={()=>setPreview(true)}>{failed?"Image unavailable; open file":alt}</button>}
    {preview?<FileReferenceViewer path={path} scope={scope} onClose={()=>setPreview(false)}/>:null}
  </span>;
}
function MarkdownImage({src,alt}:ComponentProps<"img">) {
  const context=useContext(FileReferenceContext);
  const value=src||"";
  if(/^(?:https?:|data:image\/)/i.test(value))return <a href={value} target="_blank" rel="noopener noreferrer"><img src={value} alt={alt||"Embedded image"} className="markdown-embedded-image" loading="lazy" referrerPolicy="no-referrer"/></a>;
  const path=context?localReferencePath(value,context.cwd):null;
  return path&&context?<LocalResourceImage path={path} alt={alt||path.split("/").at(-1)||"Image"} scope={context}/>:<span>{alt||"Image reference"}</span>;
}

import {isValidElement,useState,type ReactNode} from "react";
import DOMPurify from "dompurify";
import hljs from "highlight.js/lib/common";
import MermaidDiagram from "./MermaidDiagram";
import {sanitizeSvg} from "./diagramSvg";
import "highlight.js/styles/github-dark.css";

export {sanitizeSvg};
function SvgDiagram({source}:{source:string}){
  const result=(()=>{
    try {return {svg:sanitizeSvg(source),error:""};}
    catch(error){return {svg:"",error:error instanceof Error?error.message:"Invalid SVG."};}
  })();
  return result.svg?
    <div className="markdown-diagram" role="img" aria-label="SVG diagram"
      dangerouslySetInnerHTML={{__html:result.svg}}/>:
    <small className="markdown-diagram-error">SVG preview unavailable: {result.error}</small>;
}

export function MarkdownCodeBlock({children}:{children?:ReactNode}){
  const child=isValidElement<{className?:string;children?:ReactNode}>(children)?children:null;
  const language=child?.props.className?.match(/(?:^|\s)language-([\w+.-]+)/)?.[1]?.toLowerCase()||"";
  const raw=child?.props.children;
  const source=(typeof raw==="string"?raw:Array.isArray(raw)?raw.join(""):String(raw??"")).replace(/\n$/,"");
  const diagram=language==="mermaid"?"mermaid":language==="svg"?"svg":null;
  const [showSource,setShowSource]=useState(false);
  const [copied,setCopied]=useState(false);
  let highlighted="";
  if(!diagram&&language&&hljs.getLanguage(language)){
    try {
      highlighted=DOMPurify.sanitize(hljs.highlight(source,{language,ignoreIllegals:true}).value,{
        ALLOWED_TAGS:["span"],ALLOWED_ATTR:["class"]
      });
    }catch{highlighted="";}
  }
  const copy=async()=>{
    try {
      if(navigator.clipboard?.writeText)await navigator.clipboard.writeText(source);
      else {
        const textarea=document.createElement("textarea");
        textarea.value=source;textarea.style.position="fixed";textarea.style.opacity="0";
        document.body.appendChild(textarea);textarea.select();
        const success=document.execCommand("copy");textarea.remove();
        if(!success)throw new Error("Clipboard unavailable");
      }
      setCopied(true);
    }catch{setCopied(false);}
  };
  return <div className="markdown-code-block">
    <div className="markdown-code-toolbar">
      <span>{language||"text"}</span>
      <div>
        {diagram?<button type="button" onClick={()=>setShowSource(value=>!value)}>
          {showSource?"Hide code":"Show code"}
        </button>:null}
        <button type="button" onClick={()=>void copy()}>{copied?"Copied":"Copy"}</button>
      </div>
    </div>
    {diagram?(language==="mermaid"?<MermaidDiagram source={source}/>:<SvgDiagram source={source}/>):null}
    {!diagram||showSource?<pre className="markdown-code-source">
      {highlighted?<code className="hljs" dangerouslySetInnerHTML={{__html:highlighted}}/>:
        <code>{source}</code>}
    </pre>:null}
  </div>;
}

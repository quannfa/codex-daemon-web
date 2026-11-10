import {useContext,useState} from "react";
import MessageTimestamp from "./MessageTimestamp";
import {FileReferenceContext,LocalResourceImage,MarkdownContent} from "./ResourceMarkdown";
import FileReferenceViewer from "./FileReferenceViewer";
import {localReferencePath,safeMarkdownUrl} from "./resource-paths";
type Part=Record<string,any>;
export type SharedMessage={id:string;role:"user"|"assistant"|"activity";text:string;content?:Part[];item?:Part;startedAtMs?:number|null;completedAtMs?:number|null};
function Attachment({part}:{part:Part}){
  const context=useContext(FileReferenceContext);
  const [open,setOpen]=useState(false);
  const path=typeof part.path==="string"&&context?localReferencePath(part.path,context.cwd):null;
  const raw=typeof part.url==="string"?part.url:part.type==="image"&&typeof part.data==="string"?
    "data:"+(part.mimeType||"image/png")+";base64,"+part.data:"";
  const url=safeMarkdownUrl(raw);
  if(part.type==="text")return <MarkdownContent text={String(part.text||"")}/>;
  if(part.type==="localImage"&&path&&context)return <LocalResourceImage path={path} alt={path.split("/").at(-1)||"Attached image"} scope={context}/>;
  if(part.type==="image"&&/^(https?:|data:image\/)/i.test(url))return <a href={url} target="_blank" rel="noopener noreferrer"><img src={url} alt="Attached image" className="markdown-embedded-image" referrerPolicy="no-referrer"/></a>;
  if(part.type==="audio"&&/^https?:/i.test(url))return <audio controls src={url}/>;
  const label=String(part.name||part.path||part.type||"Attachment");
  if(path&&context)return <><button type="button" className="markdown-local-link" onClick={()=>setOpen(true)}>{label}</button>
    {open?<FileReferenceViewer path={path} scope={context} onClose={()=>setOpen(false)}/>:null}</>;
  return <span className="shared-attachment">{label}</span>;
}
function ToolContent({value}:{value:unknown}){
  if(typeof value==="string")return <MarkdownContent text={value}/>;
  if(Array.isArray(value))return <>{value.map((v,i)=><ToolContent key={i} value={v}/>)}</>;
  if(!value||typeof value!=="object")return null;
  const part=value as Part;
  if(["text","image","localImage","audio","localAudio"].includes(part.type))return <Attachment part={part}/>;
  if(part.type==="resource"&&part.resource?.text)return <MarkdownContent text={String(part.resource.text)}/>;
  if(part.content)return <ToolContent value={part.content}/>;
  if(part.contentItems)return <ToolContent value={part.contentItems}/>;
  return null;
}
function Activity({item}:{item:Part}){
  const labels:Record<string,string>={commandExecution:"Command",fileChange:"File changes",mcpToolCall:"MCP tool",dynamicToolCall:"Tool call",functionCallOutput:"Tool output",reasoning:"Reasoning summary",plan:"Plan",webSearch:"Web search",imageView:"Viewed an image",imageGeneration:"Image generation",collabAgentToolCall:"Agent activity",subAgentActivity:"Agent activity",contextCompaction:"Context summarized"};
  const title=[labels[item.type]||item.type,item.server,item.tool||item.name].filter(Boolean).join(" · ");
  const summary=Array.isArray(item.summary)?item.summary.join("\n"):String(item.summary||"");
  const details=JSON.stringify(item,(key,value)=>{
    if((key==="data"||key==="result"||key==="image_url")&&typeof value==="string"&&value.length>1000&&(value.startsWith("data:image/")||new RegExp("^[A-Za-z0-9+/=]+$").test(value)))return "[Image content]";
    return value;
  },2);
  return <details className="shared-activity">
    <summary><span>{title}</span>{item.status?<small>{String(item.status)}</small>:null}</summary>
    {item.type==="commandExecution"?<>
      <pre className="shared-command"><code>{String(item.command||"")}</code></pre>
      {item.aggregatedOutput?<pre>{String(item.aggregatedOutput)}</pre>:null}
      {item.exitCode!==undefined&&item.exitCode!==null?<small>Exit code: {String(item.exitCode)}</small>:null}
    </>:item.type==="reasoning"?<MarkdownContent text={summary}/>:
    item.type==="plan"?<MarkdownContent text={String(item.text||"")}/>:
    item.type==="fileChange"?<>{(item.changes||[]).map((change:Part,i:number)=><section key={i}>
      <Attachment part={{type:"file",path:change.path}}/><pre>{String(change.diff||"")}</pre>
    </section>)}</>:<>
      <ToolContent value={item.result}/><ToolContent value={item.output}/><ToolContent value={item.content}/>
      {item.type==="imageView"&&item.path?<Attachment part={{type:"localImage",path:item.path}}/>:null}
      {item.type==="imageGeneration"&&item.savedPath?<Attachment part={{type:"localImage",path:item.savedPath}}/>:null}
      {item.type==="imageGeneration"&&!item.savedPath&&item.result?<Attachment part={{type:"image",url:String(item.result).startsWith("data:")?item.result:"data:image/png;base64,"+item.result}}/>:null}
      <pre className="shared-tool-details">{details}</pre>
    </>}
  </details>;
}
export function SharedInput({text,content}:{text:string;content?:Part[]}){
  return content?.length?<>{content.map((part,i)=><Attachment key={i} part={part}/>)}</>:<MarkdownContent text={text}/>;
}
export default function SharedActivity({message}:{message:SharedMessage}){
  if(message.role==="activity")return <Activity item={message.item||{type:"Tool output"}}/>;
  return <article className={"shared-message shared-message-"+message.role}>
    <span className="shared-role">{message.role==="assistant"?"Codex":"User"}</span>
    {message.role==="user"?<SharedInput text={message.text} content={message.content}/>:<MarkdownContent text={message.text}/>}
    <div className="message-meta"><MessageTimestamp startedAtMs={message.startedAtMs} completedAtMs={message.completedAtMs}/></div>
  </article>;
}

import {localReferencePath} from "./resource-paths";

type MarkdownNode={
  type:string;
  name?:string;
  value?:string;
  attributes?:Record<string,string|null|undefined>;
  children?:MarkdownNode[];
  data?:Record<string,unknown>;
  position?:{start:{offset?:number};end:{offset?:number}};
};

/** Directive paths are literal filenames, so encode #, ?, %, brackets and spaces. */
export function fileCitationTarget(value:unknown):{url:string;name:string}|null{
  if(typeof value!=="string"||!value.trim()||/[\u0000-\u001f\u007f\\]/.test(value))return null;
  let path=value;
  if(/^file:\/\//i.test(path)){
    const local=localReferencePath(path,"/");
    if(!local)return null;
    path=local;
  }else if(/^[a-z][a-z0-9+.-]*:/i.test(path)||path.startsWith("//"))return null;
  if(path.endsWith("/"))return null;
  const name=path.split("/").at(-1);
  if(!name||name==="."||name==="..")return null;
  try{return {url:path.split("/").map(encodeURIComponent).join("/"),name};}
  catch{return null;}
}

/** Run after remark-directive. Unknown/malformed directives remain visible text. */
export function remarkFileCitations(){
  return (tree:MarkdownNode,file:{toString:()=>string})=>{
    const source=String(file);
    const visit=(parent:MarkdownNode,insideLink=false)=>{
      const linked=insideLink||["link","linkReference","image","imageReference"].includes(parent.type);
      if(!parent.children)return;
      parent.children=parent.children.map(node=>{
        if(["textDirective","leafDirective","containerDirective"].includes(node.type)){
          const target=!linked&&node.name==="codex-file-citation"&&node.type!=="containerDirective"?
            fileCitationTarget(node.attributes?.path):null;
          if(target){
            return {...node,children:[{type:"text",value:target.name}],
              data:{hName:"a",hProperties:{
                href:target.url,
                dataCodexFileCitation:node.attributes?.purpose==="output"?"output":node.attributes?.purpose==="input"?"input":"reference",
              }}};
          }
          const start=node.position?.start.offset,end=node.position?.end.offset;
          const value=typeof start==="number"&&typeof end==="number"?source.slice(start,end):":"+String(node.name||"");
          const text:MarkdownNode={type:"text",value,position:node.position};
          return node.type==="textDirective"?text:{type:"paragraph",children:[text],position:node.position};
        }
        visit(node,linked);
        return node;
      });
    };
    visit(tree);
  };
}

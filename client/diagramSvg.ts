import DOMPurify from "dompurify";

function cleanDiagramSvg(source:string,preserveStyles=false):SVGSVGElement {
  const cleaned=DOMPurify.sanitize(source,{
    USE_PROFILES:{svg:true,svgFilters:true},
    FORBID_TAGS:["script","foreignObject","iframe","object","embed","image","use","a",...(preserveStyles?[]:["style"])],
    FORBID_ATTR:["href","xlink:href"],
    ALLOW_DATA_ATTR:false,
  });
  const holder=document.createElement("div");
  holder.innerHTML=cleaned;
  const svg=holder.querySelector("svg");
  if(!svg)throw new Error("The code does not contain a valid SVG element.");
  for(const element of holder.querySelectorAll("*")){
    for(const attr of Array.from(element.attributes)){
      const value=attr.value;
      const urls=[...value.matchAll(/url\(\s*["']?([^)"']+)["']?\s*\)/gi)];
      if(urls.some(match=>!match[1].trim().startsWith("#")) ||
         /@import|expression\s*\(|javascript\s*:/i.test(value) ||
         /^on/i.test(attr.name))
        element.removeAttribute(attr.name);
    }
  }
  if(preserveStyles){
    for(const style of Array.from(holder.querySelectorAll("style"))){
      const css=style.textContent||"";
      if(/@import|url\(\s*["']?(?!#)[^)"']+["']?\s*\)|expression\s*\(|javascript\s*:/i.test(css))
        style.remove();
    }
  }
  return svg;
}

/** Inline SVG previews must not introduce styles into the surrounding page. */
export function sanitizeSvg(source:string):string {
  return cleanDiagramSvg(source).outerHTML;
}

/** Mermaid styles are kept inside the sanitized SVG viewer. */
export function sanitizeMermaidSvg(source:string):string {
  return cleanDiagramSvg(source,true).outerHTML;
}

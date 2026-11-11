import {useCallback,useEffect,useId,useRef,useState} from "react";
import {ArrowDown,ArrowLeft,ArrowRight,ArrowUp,Maximize,Minimize,RotateCcw,ZoomIn,ZoomOut} from "lucide-react";
import {TransformComponent,TransformWrapper,type ReactZoomPanPinchRef} from "react-zoom-pan-pinch";
import {sanitizeMermaidSvg} from "./diagramSvg";

// Based on the MIT-licensed viewer at https://github.com/avol-io/react-mermaid;
// the fit calculation is corrected here to use the complete SVG viewBox.
const PAN_STEP=80;

let mermaidModule:Promise<(typeof import("mermaid"))["default"]>|undefined;
function getMermaid(){
  if(!mermaidModule)mermaidModule=import("mermaid").then(({default:mermaid})=>{
    mermaid.initialize({
      startOnLoad:false,
      securityLevel:"strict",
      theme:"default",
      htmlLabels:false,
      flowchart:{htmlLabels:false},
      suppressErrorRendering:true,
    });
    return mermaid;
  });
  return mermaidModule;
}

let diagramSerial=0;

function useFitToScreen(wrapperRef:React.RefObject<HTMLDivElement|null>){
  const controlsRef=useRef<ReactZoomPanPinchRef>(null);
  const contentRef=useRef<HTMLDivElement>(null);
  const fitToScreen=useCallback((animate=200)=>{
    const wrapper=wrapperRef.current;
    const controls=controlsRef.current;
    const svg=contentRef.current?.querySelector("svg");
    if(!wrapper||!controls||!svg)return;
    const values=svg.getAttribute("viewBox")?.trim().split(/[\s,]+/).map(Number);
    if(!values||values.length<4||values.some(value=>!Number.isFinite(value)))return;
    const [, , viewWidth,viewHeight]=values;
    if(viewWidth<=0||viewHeight<=0)return;
    svg.setAttribute("width",String(viewWidth));
    svg.setAttribute("height",String(viewHeight));
    svg.style.maxWidth="none";
    const {width,height}=wrapper.getBoundingClientRect();
    const padding=24;
    const scale=Math.min((width-padding*2)/viewWidth,(height-padding*2)/viewHeight);
    const nextScale=Number.isFinite(scale)&&scale>0?scale:1;
    const x=(width-viewWidth*nextScale)/2;
    const y=(height-viewHeight*nextScale)/2;
    controls.setTransform(x,y,nextScale,animate);
  },[wrapperRef]);
  return {controlsRef,contentRef,fitToScreen};
}

export default function MermaidDiagram({source}:{source:string}){
  const id=useId().replace(/[^a-zA-Z0-9_-]/g,"");
  const wrapperRef=useRef<HTMLDivElement>(null);
  const {controlsRef,contentRef,fitToScreen}=useFitToScreen(wrapperRef);
  const [svg,setSvg]=useState("");
  const [error,setError]=useState("");
  const [fullscreen,setFullscreen]=useState(false);
  const renderVersion=useRef(0);

  useEffect(()=>{
    const version=++renderVersion.current;
    let canceled=false;
    const timeout=setTimeout(()=>{
      void getMermaid().then(async mermaid=>{
        const result=await mermaid.render("codex-mermaid-"+id+"-"+(++diagramSerial),source);
        if(canceled||version!==renderVersion.current)return;
        setSvg(sanitizeMermaidSvg(result.svg));
        setError("");
      }).catch(reason=>{
        if(!canceled&&version===renderVersion.current){
          setSvg("");
          setError(reason instanceof Error?reason.message:"Invalid Mermaid diagram.");
        }
      });
    },0);
    return()=>{canceled=true;clearTimeout(timeout);};
  },[id,source]);

  useEffect(()=>{
    if(!svg)return;
    const frame=requestAnimationFrame(()=>fitToScreen(0));
    return()=>cancelAnimationFrame(frame);
  },[fitToScreen,svg]);

  useEffect(()=>{
    if(!svg)return;
    const frame=requestAnimationFrame(()=>fitToScreen(200));
    return()=>cancelAnimationFrame(frame);
  },[fitToScreen,fullscreen,svg]);

  useEffect(()=>{
    const wrapper=wrapperRef.current;
    if(!wrapper||!svg)return;
    const observer=new ResizeObserver(()=>fitToScreen(0));
    observer.observe(wrapper);
    return()=>observer.disconnect();
  },[fitToScreen,svg]);

  const pan=useCallback((dx:number,dy:number)=>{
    const controls=controlsRef.current;
    if(!controls)return;
    const {positionX,positionY,scale}=controls.state;
    controls.setTransform(positionX+dx,positionY+dy,scale,100);
  },[controlsRef]);

  return <div ref={wrapperRef} className={"react-mermaid-wrapper"+(fullscreen?" react-mermaid-fullscreen":"")} role="img" aria-label="Mermaid diagram">
    {error?<div className="react-mermaid-error" role="alert">Mermaid diagram unavailable: {error}</div>:
      <TransformWrapper
        onInit={ref=>{controlsRef.current=ref;}}
        minScale={0.1}
        maxScale={10}
        centerZoomedOut={false}
        wheel={{step:0.1}}
      >
        {({zoomIn,zoomOut})=><>
          <div className="react-mermaid-toolbar react-mermaid-toolbar--top">
            <button type="button" onClick={()=>setFullscreen(value=>!value)}
              title={fullscreen?"Exit fullscreen":"Fullscreen"} aria-label={fullscreen?"Exit fullscreen":"Fullscreen"}>
              {fullscreen?<Minimize size={16}/>:<Maximize size={16}/>} 
            </button>
          </div>
          <div className="react-mermaid-toolbar react-mermaid-toolbar--bottom">
            <div className="react-mermaid-grid">
              <span/>
              <button type="button" onClick={()=>pan(0,-PAN_STEP)} title="Pan up" aria-label="Pan up"><ArrowUp size={14}/></button>
              <button type="button" onClick={()=>zoomIn()} title="Zoom in" aria-label="Zoom in"><ZoomIn size={14}/></button>
              <button type="button" onClick={()=>pan(-PAN_STEP,0)} title="Pan left" aria-label="Pan left"><ArrowLeft size={14}/></button>
              <button type="button" onClick={()=>fitToScreen(200)} title="Reset view" aria-label="Reset view"><RotateCcw size={14}/></button>
              <button type="button" onClick={()=>pan(PAN_STEP,0)} title="Pan right" aria-label="Pan right"><ArrowRight size={14}/></button>
              <span/>
              <button type="button" onClick={()=>pan(0,PAN_STEP)} title="Pan down" aria-label="Pan down"><ArrowDown size={14}/></button>
              <button type="button" onClick={()=>zoomOut()} title="Zoom out" aria-label="Zoom out"><ZoomOut size={14}/></button>
            </div>
          </div>
          <TransformComponent wrapperStyle={{width:"100%",height:"100%"}}>
            <div ref={contentRef} dangerouslySetInnerHTML={{__html:svg}}/>
          </TransformComponent>
        </>}
      </TransformWrapper>}
  </div>;
}

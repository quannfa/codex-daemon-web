import React, {useEffect,useState} from "react";
import SharedConversation from "./SharedConversation";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initializeInterfaceLanguage } from "./interface-language";

function Entry(){
  const [hash,setHash]=useState(window.location.hash);
  useEffect(()=>{
    const change=()=>setHash(window.location.hash);
    window.addEventListener("hashchange",change);
    return()=>window.removeEventListener("hashchange",change);
  },[]);
  if(hash.startsWith("#share="))return <SharedConversation key={hash} token={hash.slice(7)}/>;
  return <App/>;
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Entry />
  </React.StrictMode>,
);

initializeInterfaceLanguage();

import express from "express";
import {SharedUploads,MAX_SHARED_UPLOAD_BYTES,uploadIdPattern} from "./shared-uploads.js";
import {mountResources,ResourceError,type ResourceStore} from "./resources.js";
import type {RequestHandler} from "express";
import {ConversationShares,ShareError} from "./conversation-shares.js";
import {SharedConversationGateway} from "./shared-conversation.js";
import {daemonThreadId} from "./scheduled-task-target.js";
export function mountConversationShares(app:express.Express,store:ConversationShares,gateway:SharedConversationGateway,owner:RequestHandler,origin:RequestHandler,resources?:ResourceStore,uploads?:SharedUploads){
  const safe=(work:(req:express.Request,res:express.Response)=>Promise<void>):RequestHandler=>(req,res)=>{
    res.setHeader("Cache-Control","no-store");
    res.setHeader("Referrer-Policy","no-referrer");
    void work(req,res).catch(error=>{
      const status=error instanceof ShareError?error.status:503;
      res.status(status).json({error:error instanceof ShareError?error.message:"Conversation unavailable. Please try again later."});
    });
  };
  const id=(value:unknown)=>{
    try{return daemonThreadId(value);}catch{throw new ShareError(400,"Invalid conversation ID.");}
  };
  if(uploads){
    const uploadAuth:RequestHandler=(req,res,next)=>{
      res.setHeader("Cache-Control","no-store");res.setHeader("Referrer-Policy","no-referrer");
      try{
        const grant=store.authenticate(req.header("authorization"));
        if(!uploads.localFiles)throw new ShareError(400,"File uploads require a local daemon.");
        if(Object.keys(req.query).length||!uploadIdPattern.test(String(req.params.id)))throw new ShareError(400,"Invalid upload request.");
        res.locals.shareGrant=grant;next();
      }catch(error){res.status(error instanceof ShareError?error.status:401).json({error:error instanceof Error?error.message:"Invalid upload."});}
    };
    app.post("/api/shared/uploads/:id",origin,uploadAuth,(req,res,next)=>{
      express.raw({type:"application/octet-stream",limit:MAX_SHARED_UPLOAD_BYTES})(req,res,error=>{
        if(error){res.status((error as {status?:number}).status===413?413:400).json({error:"Each file must be 32 MB or smaller."});return;}
        next();
      });
    },safe(async(req,res)=>{
      let name:string;
      try{name=decodeURIComponent(req.header("x-file-name")||"");}catch{throw new ShareError(400,"Invalid filename.");}
      if(!name||name.length>1024||!Buffer.isBuffer(req.body))throw new ShareError(400,"Upload a file with its filename.");
      res.status(201).json(await uploads.put(res.locals.shareGrant,String(req.params.id),name,req.body));
    }));
    app.delete("/api/shared/uploads/:id",origin,uploadAuth,safe(async(req,res)=>{
      await uploads.remove(res.locals.shareGrant,String(req.params.id).toLowerCase());
      res.json({removed:true});
    }));
  }
  if(resources){
    const resourceAuth:RequestHandler=(req,res,next)=>{
      res.setHeader("Cache-Control","no-store");
      res.setHeader("Referrer-Policy","no-referrer");
      try{
        const grant=store.authenticate(req.header("authorization"));
        if(req.method==="POST"&&(!req.body||Object.keys(req.body).some(k=>k!=="path"&&k!=="baseResourceId")))
          throw new ShareError(400,"Only a resource path and base resource are accepted.");
        res.locals.checkResourceAccess=()=>{
          try{store.active(grant.id);}catch{throw new ResourceError(401,"This sharing link is invalid, expired, or revoked.");}
        };
        next();
      }catch(error){
        res.status(error instanceof ShareError?error.status:401).json({error:error instanceof Error?error.message:"Sharing link unavailable."});
      }
    };
    mountResources(app,resources,resourceAuth,origin,"/api/shared/resources");
  }
  app.get("/api/shares",owner,safe(async(req,res)=>{
    res.json({shares:store.list(id(req.query.threadId))});
  }));
  app.post("/api/shares",origin,owner,safe(async(req,res)=>{
    if(!req.body||Object.keys(req.body).some(k=>!["threadId","expiresInDays"].includes(k)))throw new ShareError(400,"Invalid sharing settings.");
    const threadId=id(req.body.threadId);
    await gateway.verify(threadId);
    res.status(201).json(await store.create(threadId,req.body.expiresInDays===undefined?7:req.body.expiresInDays));
  }));
  app.delete("/api/shares/:id",origin,owner,safe(async(req,res)=>{
    await store.revoke(String(req.params.id));
    res.json({revoked:true});
  }));
  app.get("/api/shared/conversation",safe(async(req,res)=>{
    const grant=store.authenticate(req.header("authorization"));
    if(Object.keys(req.query).some(k=>k!=="before"))throw new ShareError(400,"Only this shared conversation is available.");
    res.json(await gateway.read(grant,req.query.before));
  }));
  app.post("/api/shared/messages",origin,safe(async(req,res)=>{
    const grant=store.authenticate(req.header("authorization"));
    if(Object.keys(req.query).length)throw new ShareError(400,"Invalid request.");
    res.status(202).json(await gateway.send(grant,req.body));
  }));
}

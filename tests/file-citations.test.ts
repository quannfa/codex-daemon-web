import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkDirective from "remark-directive";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import {remarkFileCitations,fileCitationTarget} from "../client/file-citations";
import {localReferencePath,safeMarkdownUrl} from "../client/resource-paths";
function render(text:string){
 const links:{href:string;purpose:unknown}[]=[];
 const html=renderToStaticMarkup(createElement(ReactMarkdown,{
  children:text,remarkPlugins:[remarkGfm,remarkMath,remarkDirective,remarkFileCitations],urlTransform:safeMarkdownUrl,
  components:{a:({href,children,node})=>{
   links.push({href:href||"",purpose:node?.properties.dataCodexFileCitation});
   return createElement("a",{href},children);
  }},
 }));
 return {html,links};
}
test("renders the reported Chinese DOCX citation, preserving filename and purpose",()=>{
 const path="/data/zqf/招投标教学/教学示例/天津工业大学_电磁通讯体系评估项目_技术部分示例.docx";
 const {html,links}=render('":codex-file-citation{path="'+path+'" purpose="output"}"');
 assert.equal(links.length,1);assert.equal(links[0].purpose,"output");
 assert.equal(localReferencePath(links[0].href,"/workspace"),path);
 assert.ok(html.includes(path.split("/").at(-1)!));
 assert.ok(!html.includes("codex-file-citation"));
});
test("supports inline and standalone references, relative paths, file URLs and reordered attributes",()=>{
 for(const source of [
  'See :codex-file-citation{purpose="output" path="结果 文件.docx"} now.',
  "::codex-file-citation{path='结果 文件.docx' purpose='output'}",
  '> :codex-file-citation{path="结果 文件.docx" purpose="output"}',
  '- :codex-file-citation{path="结果 文件.docx" purpose="output"}',
  '**:codex-file-citation{path="结果 文件.docx" purpose="output"}**',
 ]){
  const r=render(source);assert.equal(r.links.length,1,source);
  assert.equal(localReferencePath(r.links[0].href,"/project"),"/project/结果 文件.docx");
 }
 const r=render(':codex-file-citation{path="file:///data/result%20file.pdf" purpose="input"} :codex-file-citation{path="/tmp/reference.md"}');
 assert.equal(r.links.length,2);assert.equal(r.links[0].purpose,"input");assert.equal(r.links[1].purpose,"reference");
 assert.equal(localReferencePath(r.links[0].href,"/"),"/data/result file.pdf");
});
test("literal filename punctuation and HTML entities cannot create markup or truncate paths",()=>{
 const path='/data/a [b] (c) # ? 100% & "quote".docx';
 const encoded=path.replaceAll("&","&amp;").replaceAll('"',"&quot;");
 const r=render(':codex-file-citation{path="'+encoded+'" purpose="output" onclick="alert(1)"}');
 assert.equal(r.links.length,1);
 assert.equal(localReferencePath(r.links[0].href,"/"),path);
 assert.doesNotMatch(r.html,/onclick|<script|javascript:/);
 assert.equal(fileCitationTarget("/data/\u0000name"),null);
 assert.equal(fileCitationTarget("javascript:alert(1)"),null);
 assert.equal(fileCitationTarget("https://example.com/test.docx"),null);
 assert.equal(fileCitationTarget("file://remote/path"),null);
});
test("code, math, escaped examples and incomplete directives remain text",()=>{
 const citation=':codex-file-citation{path="/tmp/result.docx" purpose="output"}';
 const tick=String.fromCharCode(96);
 for(const source of [
  tick+citation+tick,
  tick.repeat(3)+"text\n"+citation+"\n"+tick.repeat(3),
  "~~~markdown\n"+citation+"\n~~~",
  "    "+citation,
  "\\:"+citation.slice(1),
  "$"+citation+"$",
  citation.slice(0,-1),
  ':codex-file-citation{path="',
  ':codex-file-citation{purpose="output"}',
  ':unrelated{path="/tmp/result.docx"}',
 ]){
  const r=render(source);assert.equal(r.links.length,0,source);
  assert.ok(r.html.includes("codex-file-citation")||r.html.includes(":unrelated"),source);
 }
});
test("existing links are preserved and references inside links never create nested controls",()=>{
 const r=render('[Download](/tmp/a.docx "Title") and [label :codex-file-citation{path="/tmp/b.docx"}](/tmp/c.md)');
 assert.equal(r.links.length,2);
 assert.ok(r.links.every(x=>!x.purpose));
 assert.ok(r.html.includes(':codex-file-citation'));
});

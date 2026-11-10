import assert from "node:assert/strict";
import test from "node:test";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import {normalizeMathDelimiters} from "../client/math-markdown";
function render(text:string){return renderToStaticMarkup(createElement(ReactMarkdown,{
 children:normalizeMathDelimiters(text),remarkPlugins:[remarkMath],rehypePlugins:[[rehypeKatex,{trust:false,strict:"ignore",maxExpand:1000,maxSize:20}]],
}));}
test("renders dollar and LaTeX delimiters, fractions, and Chinese text",()=>{
 const examples=[String.raw`$x^2$`,String.raw`\(x^2\)`,"$$\nx^2\n$$",String.raw`\[ R=\frac{\text{各组残差均值之间的散布}}{\text{各组内部残差散布的平均值}} \]`];
 for(const example of examples){const html=render(example);assert.match(html,/class="katex"/);assert.doesNotMatch(html,/katex-error/);}
 assert.match(render(examples[3]),/katex-display/);
});
test("does not rewrite fenced, inline, indented code, or incomplete streaming math",()=>{
 const samples=["```latex\n\\[ x \\]\n```","~~~\n\\( x \\)\n~~~",String.raw`\`\(x\)\``.replaceAll("\\`","`"),"    \\[ x \\]",String.raw`unfinished \[ x`,String.raw`escaped \\[ x \\]`];
 for(const sample of samples)assert.equal(normalizeMathDelimiters(sample),sample);
 assert.equal(normalizeMathDelimiters("ordinary [text](file.md)"),"ordinary [text](file.md)");
});
test("malformed formulas fall back without injecting active HTML",()=>{
 assert.doesNotThrow(()=>render(String.raw`$\badcommand{x}$`));
 const html=render(String.raw`$\href{javascript:alert(1)}{click}$`);
 assert.doesNotMatch(html,/<a[^>]*href=/);
 assert.doesNotMatch(html,/<script/);
});

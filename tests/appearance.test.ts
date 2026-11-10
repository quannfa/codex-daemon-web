import assert from "node:assert/strict";
import test from "node:test";
import { contrastText, defaultAppearance, readAppearance } from "../client/appearance";
test("appearance preferences recover from invalid or unavailable storage", () => {
  for (const raw of ["null", "{", "[]", "123", '{"accent":"red","selection":"#fff","contrast":"invalid"}']) {
    assert.deepEqual(readAppearance({getItem: () => raw}), defaultAppearance);
  }
  assert.deepEqual(readAppearance({getItem: () => {throw Error("blocked");}}), defaultAppearance);
  assert.deepEqual(readAppearance({getItem: () => '{"accent":"#123456","selection":"#FEDCBA","contrast":"standard"}'}),
    {accent: "#123456", selection: "#FEDCBA", contrast: "standard"});
});
test("selection foreground maintains readable contrast across the color range", () => {
  const lum = (hex: string) => {
    const rgb = [1,3,5].map(i => parseInt(hex.slice(i,i+2),16)/255).map(v => v <= 0.04045 ? v/12.92 : ((v+0.055)/1.055)**2.4);
    return rgb[0]*0.2126+rgb[1]*0.7152+rgb[2]*0.0722;
  };
  for(let r=0;r<=255;r+=17) for(let g=0;g<=255;g+=17) for(let b=0;b<=255;b+=17) {
    const color="#"+[r,g,b].map(n=>n.toString(16).padStart(2,"0")).join("");
    const a=lum(color), f=lum(contrastText(color));
    assert.ok((Math.max(a,f)+0.05)/(Math.min(a,f)+0.05)>=4.5, color);
  }
});

/** Accept LaTeX delimiters without rewriting fenced or inline code. */
export function normalizeMathDelimiters(markdown: string): string {
  let output = "", offset = 0;
  let fence: {char: string; length: number} | null = null;
  while (offset < markdown.length) {
    if (offset === 0 || markdown[offset - 1] === "\n") {
      const end = markdown.indexOf("\n", offset);
      const line = markdown.slice(offset, end < 0 ? markdown.length : end);
      const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = null;
        output += line + (end < 0 ? "" : "\n"); offset = end < 0 ? markdown.length : end + 1; continue;
      }
      if (marker) {
        fence = {char: marker[1][0], length: marker[1].length};
        output += line + (end < 0 ? "" : "\n"); offset = end < 0 ? markdown.length : end + 1; continue;
      }
      // Four-space/tab indented code is not prose.
      if (/^(?: {4}|\t)/.test(line)) {output += line + (end < 0 ? "" : "\n");offset=end<0?markdown.length:end+1;continue;}
    }
    if (markdown[offset] === "`") {
      let length=1;while(markdown[offset+length]==="`")length++;
      const marker="`".repeat(length);let end=markdown.indexOf(marker,offset+length);
      while(end>=0 && (markdown[end-1]==="`" || markdown[end+length]==="`"))end=markdown.indexOf(marker,end+length);
      if(end>=0){output+=markdown.slice(offset,end+length);offset=end+length;continue;}
    }
    if (markdown[offset] === "\\" && (markdown[offset+1] === "[" || markdown[offset+1] === "(")) {
      let previous=offset-1;while(previous>=0&&markdown[previous]==="\\")previous--;
      if((offset-1-previous)%2===0){
        const display=markdown[offset+1]==="[",closing=display?"\\]":"\\)";
        let end=markdown.indexOf(closing,offset+2);
        while(end>=0&&markdown[end-1]==="\\")end=markdown.indexOf(closing,end+2);
        if(end>=0){
          const body=markdown.slice(offset+2,end).trim();
          if(body && (display||!body.includes("\n")) && !/(?:^|\n) {0,3}(?:`{3,}|~{3,})/.test(body)){
            output+=display?"\n$$\n"+body+"\n$$\n":"$"+body+"$";
            offset=end+2;continue;
          }
        }
      }
    }
    output+=markdown[offset++];
  }
  return output;
}

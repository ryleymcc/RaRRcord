const mentionPattern = /(?<![\p{L}\p{N}_@/])(@[a-z0-9_]{3,24})(?![\p{L}\p{N}_@]|[.-][a-z0-9_])/giu;
export const inlineMarkdown = /(\*\*[^*\n]+\*\*|(?<![\p{L}\p{N}_@])_[^_\n]+_|\x60[^\x60\n]+\x60)/gu;

export function splitMentions(text:string) {
  return text.split(mentionPattern);
}

export function mentionsUser(text:string, username:string) {
  const handle="@"+username.toLowerCase();
  return text.split("```").some((section,index)=>index%2===0 &&
    section.split(inlineMarkdown).some((part,i)=>{
      if(i%2 && part.startsWith("`"))return false;
      const delimiter=i%2?(part.startsWith("**")?2:1):0;
      const prose=delimiter?part.slice(delimiter,-delimiter):part;
      return splitMentions(prose).some((mention,i)=>i%2===1&&mention.toLowerCase()===handle);
    }));
}

export function mentionAtCursor(text:string, cursor:number) {
  const match=/(?<![\p{L}\p{N}_@/])@([a-z0-9_]{0,24})$/iu.exec(text.slice(0,cursor));
  if(!match)return;
  const prose=text.slice(0,match.index).split("```");
  if(prose.length%2===0 || prose.at(-1)!.split("`").length%2===0)return;
  const suffix=/^[a-z0-9_]*/i.exec(text.slice(cursor))![0];
  return {start:match.index,end:cursor+suffix.length,query:match[1].toLowerCase()};
}

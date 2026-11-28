export type MessageLinkTarget = {channel:string;id:number};
const messageAddress=(channel:string,id:number)=>encodeURIComponent(channel)+"/"+id;
const messageFragment="#chat/";

export function messageLink(channel:string,id:number){
  return messageFragment+messageAddress(channel,id);
}

export function messageLinkPath(channel:string,id:number){
  return "/?"+new URLSearchParams({message:messageAddress(channel,id)});
}

export function parseMessageLink(hash:string){
  return hash.startsWith(messageFragment)?parseMessageQuery(hash.slice(messageFragment.length)):undefined;
}

export function parseMessageQuery(value:string|null|undefined):MessageLinkTarget|undefined{
  const match=/^([^/]+)\/([1-9]\d*)$/.exec(value??"");
  if(!match)return;
  const id=Number(match[2]);
  if(!Number.isSafeInteger(id))return;
  try{
    const channel=decodeURIComponent(match[1]);
    if(channel.length<=64)return {channel,id};
  }catch{
    return;
  }
}

export function splitMessageLinks(text:string,origin:string){
  const parts:{text:string;target?:MessageLinkTarget}[]=[];
  let end=0;
  for(const match of text.matchAll(/(?<![\p{L}\p{N}_/@])https?:\/\/[^\s<>"'\x60]+/giu)){
    const candidate=match[0].replace(/[.,!?;:)\]}]+$/,"");
    let url:URL;
    try{url=new URL(candidate);}catch{continue;}
    if(url.origin!==origin||url.pathname!=="/"||url.username||url.password)continue;
    const target=url.hash&&!url.search?parseMessageLink(url.hash):
      !url.hash&&url.searchParams.size===1?parseMessageQuery(url.searchParams.get("message")):undefined;
    if(!target)continue;
    if(match.index>end)parts.push({text:text.slice(end,match.index)});
    parts.push({text:candidate,target});
    end=match.index+candidate.length;
  }
  if(end<text.length)parts.push({text:text.slice(end)});
  return parts;
}

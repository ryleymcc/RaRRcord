export type Person = {id:string; name:string; username:string; avatar?:boolean; role:string; state?:string; status:string};
export type Channel = {id:string; server:string|null; kind:string; name:string; category:string; description:string; permission:string; position:number; unread:number;allowed?:string[]};
export type Server = {id:string; name:string; icon?:string; picture?:string|null};
// The version tag changes whenever the picture does, so a new upload is not hidden by the browser cache.
export const serverPictureUrl=(id:string,version:string)=>"/api/ra/servericon?key="+encodeURIComponent(id)+"&v="+encodeURIComponent(version);
export type Message = {id:number; uid:string; name:string; username:string; has_avatar:boolean; body:string; created:number; edited?:number; deleted:number; pinned:number; reply?:number; attachment?:string; filename?:string; reactions?:string; my_reactions?:string};
export type Preferences = {
  input:string; output:string; camera:string; sensitivity:number; noise:boolean; echo:boolean; gain:boolean;
  ptt:boolean; key:string; screenQuality:"smooth"|"maximum"|"custom"; resolution:string; bitrate:number; codec:string; mode:string; notifications:boolean; compact:boolean; voiceSounds:boolean;
  // Unset means "strong", or "off" when an older saved setting had noise turned off.
  suppression?:"strong"|"standard"|"browser"|"off"; voiceGate?:boolean;
  // Send call media only through the TURN relay, so other people never see this device's IP address.
  hideIp?:boolean;
  // Lines spoken on this device when a particular person joins your voice room.
  joinAnnouncements?:{user:string;text:string}[];
};
export const defaults:Preferences={input:"",output:"",camera:"",sensitivity:3,noise:true,echo:true,gain:true,ptt:false,key:"Space",screenQuality:"smooth",resolution:"1080x60",bitrate:8000,codec:"auto",mode:"motion",notifications:false,compact:false,voiceSounds:true};
export const qualities=["480x30","720x30","720x60","1080x30","1080x60","1080x120","1080x144","1440x30","1440x60","1440x144","2160x30","2160x60"];
export async function request<T>(path:string, input?:object | FormData):Promise<T> {
  const response=await fetch("/api/ra/"+path, input===undefined ? {cache:"no-store"} : {
    method:"POST",headers:input instanceof FormData?undefined:{"content-type":"application/json"},body:input instanceof FormData?input:JSON.stringify(input),
  });
  const data=await response.json().catch(()=>({error:"Sites did not return an application response. Check your ChatGPT sign-in."})) as T & {error?:string};
  if (!response.ok || data?.error) throw new Error(data?.error || "Request failed.");
  return data;
}

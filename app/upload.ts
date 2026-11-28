// Uploads with progress. fetch() can't report upload progress, so this uses XMLHttpRequest.
export function uploadWithProgress(data:FormData,progress:(fraction:number)=>void):Promise<void>{
  return new Promise((resolve,reject)=>{
    const xhr=new XMLHttpRequest();
    xhr.open("POST","/api/ra/upload");
    xhr.upload.onprogress=event=>{if(event.lengthComputable)progress(event.loaded/event.total);};
    xhr.onload=()=>{
      let body:{error?:string}={};
      try{body=JSON.parse(xhr.responseText);}catch{body={error:"RaRRcord didn't respond. Reload the page, and sign in again if asked."};}
      if(xhr.status>=200&&xhr.status<300&&!body.error)resolve();
      else reject(new Error(body.error||"Upload failed."));
    };
    xhr.onerror=()=>reject(new Error("Failed to fetch"));
    xhr.send(data);
  });
}
export const isImage=(name:string)=>/\.(png|gif|jpe?g|webp)$/i.test(name);
export function typingText(names:string[]){
  if(!names.length)return "";
  if(names.length===1)return names[0]+" is typing";
  if(names.length===2)return names[0]+" and "+names[1]+" are typing";
  if(names.length===3)return names[0]+", "+names[1]+" and "+names[2]+" are typing";
  return "Several people are typing";
}

"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";

// A modal built on <dialog>: Escape closes it, focus stays inside, and focus returns to the opener.
export function Modal({title,wide=false,onClose,children,className=""}:{title:string;wide?:boolean;onClose:()=>void;children:ReactNode;className?:string}){
  const ref=useRef<HTMLDialogElement>(null);
  const titleId=useId();
  const close=useRef(onClose);
  useEffect(()=>{close.current=onClose;});
  useEffect(()=>{
    const dialog=ref.current;
    const opener=document.activeElement as HTMLElement|null;
    if(dialog&&!dialog.open){
      dialog.showModal();
      // showModal focuses the close button; prefer the field the dialog marks, else its first field.
      const body=dialog.querySelector(".dialog-body");
      const target=body?.querySelector<HTMLElement>("[data-autofocus]")??body?.querySelector<HTMLElement>(":scope>:not(header) :is(input:not([type=hidden]),select,textarea)");
      target?.focus();
    }
    return ()=>{dialog?.close();if(opener?.isConnected)opener.focus();};
  },[]);
  return <dialog ref={ref} className={"dialog"+(wide?" wide":"")+(className?" "+className:"")} aria-labelledby={titleId}
    onCancel={event=>{event.preventDefault();close.current();}}
    onMouseDown={event=>{if(event.target===event.currentTarget)close.current();}}>
    <div className="dialog-body">
      <header><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Close dialog" title="Close" onClick={()=>close.current()}><X size={20}/></button></header>
      {children}
    </div>
  </dialog>;
}

type ConfirmRequest={title:string;body?:string;action:string;danger?:boolean;reason?:string};
type Pending=ConfirmRequest&{resolve:(answer:{ok:boolean;reason:string})=>void};
let show:((request:Pending)=>void)|null=null;

// Ask before a step that can't be undone. Resolves with ok=false if the person cancels.
export function confirmAction(request:ConfirmRequest):Promise<{ok:boolean;reason:string}>{
  return new Promise(resolve=>{
    if(!show){resolve({ok:false,reason:""});return;}
    show({...request,resolve});
  });
}

export function ConfirmHost(){
  const [pending,setPending]=useState<Pending|null>(null);
  const [reason,setReason]=useState("");
  useEffect(()=>{
    show=request=>{setReason("");setPending(previous=>{previous?.resolve({ok:false,reason:""});return request;});};
    return ()=>{show=null;};
  },[]);
  if(!pending)return null;
  const finish=(ok:boolean)=>{pending.resolve({ok,reason:reason.trim()});setPending(null);};
  return <Modal title={pending.title} onClose={()=>finish(false)} className="confirm">
    <form className="settings-form" onSubmit={event=>{event.preventDefault();finish(true);}}>
      {pending.body&&<p>{pending.body}</p>}
      {pending.reason!==undefined&&<label>{pending.reason}<textarea data-autofocus required rows={3} maxLength={500} value={reason} onChange={event=>setReason(event.target.value)}/></label>}
      <div className="dialog-actions">
        <button type="button" data-autofocus={pending.reason===undefined?"":undefined} onClick={()=>finish(false)}>Cancel</button>
        <button className={pending.danger?"danger-button":"primary"}>{pending.action}</button>
      </div>
    </form>
  </Modal>;
}

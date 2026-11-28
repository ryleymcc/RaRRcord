import { useSyncExternalStore } from "react";
// Reads a CSS media query. The server render assumes a wide screen.
export function useMedia(query:string,server=true){
  return useSyncExternalStore(
    notify=>{const list=window.matchMedia(query);list.addEventListener("change",notify);return ()=>list.removeEventListener("change",notify);},
    ()=>window.matchMedia(query).matches,
    ()=>server,
  );
}

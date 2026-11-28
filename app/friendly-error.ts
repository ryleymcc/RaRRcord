// Turns technical failures into sentences people can act on. The original text is kept for Diagnostics.
const rules:[RegExp,string][]=[
  [/^AI noise suppression could not start/i,"Noise suppression couldn't start, so your browser's built-in filter is on instead."],
  [/failed to fetch|networkerror|load failed|network request failed/i,"Can't reach RaRRcord right now. Check your connection and try again."],
  [/notallowederror|permission denied|declined or blocked/i,"Your browser blocked the microphone, camera or screen. Allow it from the icon in the address bar, then try again."],
  [/notreadableerror|could not start (video|audio) source/i,"Another app is using your microphone or camera. Close it and try again."],
  [/did not return an application response/i,"RaRRcord didn't respond. Reload the page, and sign in again if asked."],
];
export function friendlyError(message:string):string{
  for(const [pattern,text] of rules)if(pattern.test(message))return text;
  // Messages written for people pass through; anything that looks like internals is summarized.
  if(/https?:\/\/|HTTP status|\bat \w+ \(|TypeError|DOMException|undefined|null/i.test(message))return "Something went wrong. Details are in Diagnostics.";
  return message;
}

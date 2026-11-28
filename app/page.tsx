import { headers } from "next/headers";
import { chatGPTSignInPath, getChatGPTUser } from "./chatgpt-auth";
import Community from "./community";
import {messageLinkPath,parseMessageQuery} from "../lib/message-links";

export const dynamic = "force-dynamic";

export default async function Page({searchParams}:{searchParams:Promise<{message?:string|string[]}>}) {
  const user = await getChatGPTUser();
  const local = (await headers()).get("x-rarrcord-auth-mode") === "local";
  if(user)return <Community localAuth={local}/>;
  const {message}=await searchParams;
  const target=parseMessageQuery(typeof message==="string"?message:undefined);
  const returnTo=target?messageLinkPath(target.channel,target.id):"/";
  return <main className="entry"><div className="entry-card"><span className="brand-mark">R</span><h1>RaRRcord</h1><p>Private community messaging, voice, and screen sharing.</p><a className="primary" href={chatGPTSignInPath(returnTo)} target="_top">{local ? "Sign in or create account" : "Continue with ChatGPT"}</a><a href="/privacy">Privacy</a></div></main>;
}

import { chatGPTSignInPath, getChatGPTUser } from "./chatgpt-auth";
import Community from "./community";

export const dynamic = "force-dynamic";

export default async function Page() {
  const user = await getChatGPTUser();
  return user ? <Community /> : <main className="entry"><div className="entry-card"><span className="brand-mark">R</span><h1>RaRRcord</h1><p>Private community messaging, voice, and screen sharing.</p><a className="primary" href={chatGPTSignInPath("/")} target="_top">Continue with ChatGPT</a><a href="/privacy">Privacy</a></div></main>;
}

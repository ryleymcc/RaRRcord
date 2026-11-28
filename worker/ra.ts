import { EMAIL_HEADER, ID_HEADER, signOutPath } from "./identity.ts";
import { localOrigin, localLogout } from "./local-auth.ts";
import { allow, dailyUploadBytes, readLimits } from "./limits.ts";
import { backgroundPresets } from "../lib/backgrounds.ts";

type Value = string | number | null;
type User = { id:string; username:string; name:string; state:string; role:string; status:string; seen:number; avatar:string|null; epoch:number; prefs:string };
type Channel = { id:string; kind:string; server:string|null; name:string; permission:string; category:string; description:string; position:number };
type Voice = { uid:string; peer:string; channel:string; expires:number; cam:number; screen:number; joined:number };
type Input = Record<string, unknown>;

const day = 86400000;
const lease = 16000;
const movedPeer = (peer:string) => "moved:"+peer;
// "45 seconds", "90 minutes", "1 hour", "36 hours", "2 days": the largest unit that is either
// exact or at least two of it. Keep in step with timeLeft in app/moderate-member.tsx.
export const timeLeft = (ms:number) => {
  // Round up to the second, and past a minute to the minute, so "1:59:50" reads "2 hours".
  ms=Math.ceil(ms/1000)*1000;
  if (ms>60000) ms=Math.ceil(ms/60000)*60000;
  const units=[[86400000,"day"],[3600000,"hour"],[60000,"minute"],[1000,"second"]] as const;
  const [size,unit]=units.find(([size])=>ms%size===0&&ms>=size || ms>=2*size) ?? units[3];
  const n=Math.ceil(ms/size);
  return n+" "+unit+(n===1?"":"s");
};
const sessionName = "__Host-rarr";
const authHeaders = { "cache-control":"private, no-store", "x-content-type-options":"nosniff" };
const unicodeEmoji = new RegExp("^(?:\\p{RGI_Emoji})$", "v");
const seed = [
  ["general","General","text"], ["announcements","Announcements","text"], ["development","Development","text"],
  ["screenshots","Screenshots","text"], ["off-topic","Off-topic","text"], ["general-voice","General Voice","voice"],
  ["gaming","Gaming","voice"], ["development-voice","Development Voice","voice"], ["afk","AFK","voice"],
];
class Problem extends Error { constructor(readonly status:number, message:string) { super(message); } }
function deny(status:number, message:string):never { throw new Problem(status,message); }
function string(value:unknown, max:number, min=1) {
  if (typeof value !== "string" || value.trim().length < min || value.length > max) deny(400,"Invalid input.");
  return value.trim();
}
// Display text with control, invisible and bidi-override characters removed, so a name cannot
// hide characters or reorder itself to look like someone else's.
function label(value:unknown, max:number, min=1) {
  if (typeof value!=="string") deny(400,"Invalid input.");
  return string(value.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,"").replace(/\s+/gu," "),max,min);
}
// A display name may not copy another member's display name or username.
async function nameTaken(db:D1Database, name:string, self:string) {
  const key=name.toLowerCase();
  return !!await db.prepare("SELECT 1 FROM users WHERE id<>? AND state<>'deleted' AND (lower(name)=? OR username=?)").bind(self,key,key).first();
}
function number(value:unknown, fallback=0) {
  const result = Number(value ?? fallback);
  if (!Number.isSafeInteger(result) || result < 0) deny(400,"Invalid number.");
  return result;
}
function token() { return crypto.randomUUID().replaceAll("-","") + crypto.randomUUID().replaceAll("-",""); }
async function digest(value:string) {
  const data = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(data), n=>n.toString(16).padStart(2,"0")).join("");
}
function json(data:unknown, status=200, headers:HeadersInit={}) {
  return Response.json(data, {status, headers:{...authHeaders,...headers}});
}
function cookie(value:string, age:number) {
  return sessionName+"="+value+"; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age="+age;
}
const view = (u:User) => ({
  id:u.id, name:u.name, username:u.username, role:u.role, state:u.state, status:u.status, avatar:!!u.avatar,
});
const channelAccess = (alias:string) => [
  "(("+alias+".kind IN ('dm','private') AND EXISTS (SELECT 1 FROM channel_members ca WHERE ca.channel="+alias+".id AND ca.uid=? AND ("+alias+".kind='dm' OR EXISTS (SELECT 1 FROM members pm WHERE pm.server="+alias+".server AND pm.uid=ca.uid))))",
  "OR ("+alias+".kind NOT IN ('dm','private') AND (?='admin' OR EXISTS",
  "(SELECT 1 FROM members ma WHERE ma.server="+alias+".server AND ma.uid=?",
  "AND ("+alias+".permission='' OR "+alias+".permission=ma.role OR ma.role='moderator')))))",
].join(" ");
export async function api(request:Request, env:Cloudflare.Env):Promise<Response> {
  try {
    return await route(request,env);
  } catch (error) {
    if (error instanceof Problem) return json({error:error.message},error.status);
    console.error("RaRRcord API failure", error instanceof Error ? error.message : "unknown error");
    return json({error:"The Site could not complete this request."},500);
  }
}
async function route(request:Request, env:Cloudflare.Env):Promise<Response> {
  const url=new URL(request.url);
  const path=url.pathname.slice(8);
  const q=url.searchParams;
  const now=Date.now();
  const write=request.method==="POST";
  if (!write && request.method!=="GET") deny(405,"Method unsupported.");
  if (write && request.headers.get("origin")!==(env.RARRCORD_AUTH==="local" ? localOrigin(env) : url.origin)) deny(403,"This request must come from RaRRcord.");
  // Set only by worker/identity.ts after it verifies the sign-in.
  const id=request.headers.get(ID_HEADER);
  const email=request.headers.get(EMAIL_HEADER);
  if (!id || !email) deny(401,"Sign in to use RaRRcord.");
  if (!write) {
    const bucket=path==="history" && q.get("search")?.trim() ? "search" : path;
    if (!allow(id+":"+bucket,readLimits[bucket]??60,now)) deny(429,"Please slow down.");
  }
  const db=env.DB;
  if (!db) deny(503,"Database binding unavailable.");
  const sql=(query:string,...values:Value[])=>db.prepare(query).bind(...values);
  const run=(query:string,...values:Value[])=>sql(query,...values).run();
  const one=<T>(query:string,...values:Value[])=>sql(query,...values).first<T>();
  const all=async <T>(query:string,...values:Value[])=>(await sql(query,...values).all<T>()).results;
  // Runs several statements in one round trip and returns each one's rows.
  const many=async (statements:D1PreparedStatement[])=>(await db.batch(statements)).map(result=>result.results as Record<string,unknown>[]);
  const rawSession=(request.headers.get("cookie")??"").match(/(?:^|;\s*)__Host-rarr=([a-f0-9]{64})(?:;|$)/)?.[1];
  const sessionKey=rawSession ? await digest(rawSession) : "";
  // One round trip for the account and whether this request's session is still live.
  const signedIn=await one<User & {live:number}>("SELECT u.*,EXISTS (SELECT 1 FROM sessions s WHERE s.token=? AND s.uid=u.id AND s.epoch=u.epoch AND s.expires>?) AS live FROM users u WHERE u.id=?",sessionKey,now,id);
  let user:User|null=signedIn;
  const live=!!sessionKey && !!signedIn?.live;
  const validSession=async (account:User)=> !!sessionKey && !!await one(
    "SELECT token FROM sessions WHERE token=? AND uid=? AND epoch=? AND expires>?",sessionKey,id,account.epoch,now);
  const audit=(action:string, detail:string)=>sql("INSERT INTO audit(uid,action,detail,time) VALUES(?,?,?,?)",id,action,detail,now);
  const upload = path==="upload" || path==="avatar" || path==="servericon" || path==="serverbackground" || path==="applogo";
  let body:Input={};
  if (write && !upload) {
    if (!request.headers.get("content-type")?.startsWith("application/json")) deny(415,"Expected JSON.");
    const size=Number(request.headers.get("content-length")??0);
    if (size>80000) deny(413,"Request too large.");
    const raw=await request.text();
    if (raw.length>80000) deny(413,"Request too large.");
    try { body=JSON.parse(raw); } catch { deny(400,"Invalid JSON."); }
    if (!body || Array.isArray(body) || typeof body!=="object") deny(400,"Expected an object.");
  }
  if (path==="session" && !write) {
    return json({user:user?view(user):null, active:user?.state==="approved" && live,
      ownerConfigured:!!env.RARRCORD_OWNER_EMAIL, nativeIdentity:true});
  }
  if (path==="enroll" && write) {
    if (!user) {
      const owner=!!env.RARRCORD_OWNER_EMAIL && email.toLowerCase()===env.RARRCORD_OWNER_EMAIL.trim().toLowerCase();
      const local=env.RARRCORD_AUTH==="local";
      const username=local ? id.slice(6) : string(body.username,24,3).toLowerCase();
      if (local && (!id.startsWith("local:") || (body.username!==undefined && body.username!==username))) deny(400,"Use your sign-in username.");
      // Local profiles never accept arbitrary display names from onboarding or autofill.
      const name=local ? username : label(body.name ?? username,40);
      if (await nameTaken(db,name,id)) deny(409,"Another member already uses that name.");
      if (!/^[a-z0-9_]+$/.test(username)) deny(400,"Use letters, numbers and underscores.");
      if (await one("SELECT 1 FROM users WHERE username=? OR lower(name)=?",username,username)) deny(409,"Username already taken.");
      const statements=[
        sql("INSERT OR IGNORE INTO servers(id,name) VALUES('community','Community')"),
        ...seed.map(([cid,title,kind],i)=>sql("INSERT OR IGNORE INTO channels(id,server,name,kind,category,position) VALUES(?,'community',?,?,?,?)",cid,title,kind,kind==="text"?"Text channels":"Voice rooms",i)),
        sql("INSERT INTO users(id,username,name,seen) VALUES(?,?,?,?)",id,username,name,now),
        sql("INSERT INTO members(server,uid,role) VALUES('community',?,'member')",id),
      ];
      if (owner) statements.push(
        sql("INSERT OR IGNORE INTO settings(key,value) VALUES('verified_owner',?)",id),
        sql("UPDATE users SET role='admin',state='approved' WHERE id=? AND id=(SELECT value FROM settings WHERE key='verified_owner')",id),
      );
      statements.push(sql("INSERT INTO audit(uid,action,detail,time) SELECT id,CASE WHEN role='admin' THEN 'owner initialized' ELSE 'membership requested' END,id,? FROM users WHERE id=?",now,id));
      if (body.invite) {
        const key=await digest(string(body.invite,64));
        const invite=await one<{server:string|null}>("SELECT server FROM invites WHERE token=? AND claimed IS NULL AND expires>?",key,now);
        if (!invite) deny(400,"Invitation is expired or used.");
        statements.push(sql("UPDATE invites SET claimed=? WHERE token=? AND claimed IS NULL AND expires>?",id,key,now));
        statements.push(sql("INSERT OR IGNORE INTO members(server,uid) SELECT server,? FROM invites WHERE token=? AND claimed=? AND server IS NOT NULL",id,key,id));
      }
      await db.batch(statements);
      user=await one<User>("SELECT * FROM users WHERE id=?",id);
    }
    if (!user) deny(409,"Account initialization failed.");
    if (user.state!=="approved") return json({user:view(user),active:false});
    if (rawSession && !await validSession(user)) deny(401,"Session revoked or expired. Sign out, then sign in again.");
    if (await validSession(user)) return json({user:view(user),active:true});
    const newSession=token();
    await db.batch([
      sql("DELETE FROM sessions WHERE uid=? AND expires<=?",id,now),
      sql("INSERT INTO sessions(token,uid,epoch,expires) VALUES(?,?,?,?)",await digest(newSession),id,user.epoch,now+7*day),
    ]);
    return json({user:view(user),active:true},200,{"set-cookie":cookie(newSession,604800)});
  }
  if (path==="logout" && write) {
    if (sessionKey) await run("DELETE FROM sessions WHERE uid=? AND token=?",id,sessionKey);
    if (user) await run("DELETE FROM voice WHERE uid=?",id);
    const response=json({signOut:signOutPath(env)},200,{"set-cookie":cookie("",0)});
    if (env.RARRCORD_AUTH==="local") response.headers.append("set-cookie",await localLogout(request,env));
    return response;
  }
  if (!user || user.state!=="approved" || !live) deny(403,"Your RaRRcord session does not have access.");
  const account=user;
  const access:Value[]=[id,account.role,id];
  const admin=account.role==="admin";
  const chan=async (cid:string, kind?:string)=>{
    const c=await one<Channel>("SELECT c.* FROM channels c WHERE c.id=? AND "+channelAccess("c"),cid,...access);
    if (!c || (kind && c.kind!==kind)) deny(404,"Channel unavailable.");
    return c;
  };
  const cid=()=>string(write?body.channel:q.get("channel"),64);
  const checkMessageTarget=async (channel:Channel, reply:number|null)=>{
    await timedOut(channel);
    if (reply && !await one("SELECT 1 FROM messages WHERE id=? AND channel=? AND deleted=0",reply,channel.id)) deny(404,"Reply target unavailable.");
    if (channel.kind==="dm" && await one("SELECT 1 FROM channel_members cm JOIN blocks b ON (b.uid=? AND b.blocked=cm.uid) OR (b.uid=cm.uid AND b.blocked=?) WHERE cm.channel=?",id,id,channel.id)) deny(403,"Direct messaging unavailable.");
  };
  const moderate=async (channel:Channel)=> admin || !!(channel.server && await one(
    "SELECT 1 FROM members WHERE server=? AND uid=? AND role='moderator'",channel.server,id));
  // A timed-out member can read but cannot post, react, type or join voice in that server until it ends.
  const timedOut=async (channel:Channel)=>{
    if (!channel.server) return;
    const row=await one<{timeout:number}>("SELECT timeout FROM members WHERE server=? AND uid=? AND timeout>?",channel.server,id,now);
    if (row) deny(403,"You are timed out in this server for "+timeLeft(row.timeout-now)+".");
  };
  const throttle=async (bucket:string, limit:number)=>{
    const minute=Math.floor(now/60000);
    const row=await one<{hits:number}>("INSERT INTO rate(uid,bucket,minute,hits) VALUES(?,?,?,1) ON CONFLICT(uid,bucket) DO UPDATE SET hits=CASE WHEN minute=excluded.minute THEN hits+1 ELSE 1 END, minute=excluded.minute RETURNING hits",id,bucket,minute);
    if (!row || row.hits>limit) deny(429,"Please slow down.");
  };
  const changed=(channel:string, mid:number)=>sql("INSERT INTO events(channel,mid,time) VALUES(?,?,?)",channel,mid,now);
  const messageQuery=(clause:string, args:Value[], order:string, limit:number)=>
    sql("SELECT m.*,u.name,u.username,u.avatar IS NOT NULL AS has_avatar,(SELECT json_group_object(emoji,count) FROM (SELECT emoji,COUNT(*) count FROM reactions WHERE mid=m.id GROUP BY emoji)) AS reactions,(SELECT json_group_array(emoji) FROM reactions WHERE mid=m.id AND uid=?) AS my_reactions FROM messages m JOIN users u ON u.id=m.uid WHERE "+clause+" ORDER BY "+order+" LIMIT ?",id,...args,limit);
  const readMessages=async (clause:string, args:Value[], order:string, limit:number)=>
    (await messageQuery(clause,args,order,limit).all()).results;
  if (path==="workspace" && !write) {
    return json({
      // "picture" is only a short version tag for cache busting; the storage key itself stays on the server.
      servers:await all("SELECT s.id,s.name,s.icon,substr(s.picture,1,8) AS picture,substr(s.background,1,8) AS background,s.background_fill,s.background_dim FROM servers s WHERE ?='admin' OR EXISTS (SELECT 1 FROM members WHERE server=s.id AND uid=?) ORDER BY name",account.role,id),
      channels:await all("SELECT c.*, (SELECT COUNT(*) FROM messages m WHERE m.channel=c.id AND m.deleted=0 AND m.uid<>? AND m.id>COALESCE((SELECT mid FROM reads WHERE uid=? AND channel=c.id),0)) unread FROM channels c WHERE "+channelAccess("c")+" ORDER BY position,c.name",id,id,...access),
      people:await all("SELECT u.id,u.name,u.username,u.role,u.avatar IS NOT NULL AS avatar,CASE WHEN u.seen<? THEN 'offline' ELSE u.status END status FROM users u WHERE u.state='approved' AND (u.id=? OR ?='admin' OR EXISTS (SELECT 1 FROM members a JOIN members b ON a.server=b.server WHERE a.uid=? AND b.uid=u.id)) ORDER BY u.name COLLATE NOCASE,u.id",now-25000,id,account.role,id),
      settings:await all("SELECT key,value FROM settings WHERE key IN ('bitrate','upload','stun')"),
      // The app logo's version tag; the storage key itself stays on the server.
      logo:(await one<{version:string}>("SELECT substr(value,1,8) AS version FROM settings WHERE key='app_logo'"))?.version??null,
      prefs:JSON.parse(account.prefs),
      // Servers where this account may move people between voice rooms.
      // Members currently timed out in servers this account can see, so the app can label them.
      timeouts:await all("SELECT m.server,m.uid,m.timeout FROM members m JOIN servers s ON s.id=m.server WHERE m.timeout>? AND (?='admin' OR EXISTS (SELECT 1 FROM members x WHERE x.server=m.server AND x.uid=?))",now,account.role,id),
      moderates:admin?(await all<{id:string}>("SELECT id FROM servers")).map(s=>s.id):
        (await all<{server:string}>("SELECT server FROM members WHERE uid=? AND role='moderator'",id)).map(m=>m.server),
    });
  }
  if (path==="history" && !write) {
    const c=await chan(cid());
    const before=number(q.get("before"),Number.MAX_SAFE_INTEGER);
    const search=q.get("search")?.trim().slice(0,100);
    const cursor=await one<{id:number}>("SELECT COALESCE(MAX(id),0) id FROM events WHERE channel=?",c.id);
    const rows=await readMessages("m.channel=? AND m.id<? AND m.deleted=0"+(search?" AND instr(lower(m.body),lower(?))>0":"")+(q.has("pinned")?" AND m.pinned=1":""),
      search?[c.id,before,search]:[c.id,before],"m.id DESC",50);
    return json({messages:rows.reverse(),cursor:cursor?.id??0});
  }
  if (path==="poll" && !write) {
    const seen=account.seen<now-9000 ? run("UPDATE users SET seen=? WHERE id=?",now,id) : null;
    const result:Record<string,unknown>={};
    // The chat and voice halves are independent, so they run side by side, each in as few round trips as possible.
    const chat=async ()=>{
      if (!q.has("channel")) return;
      const c=await chan(cid());
      const after=number(q.get("after"));
      const [events,messages,typing]=await many([
        sql("SELECT id,mid FROM events WHERE channel=? AND id>? ORDER BY id LIMIT 95",c.id,after),
        messageQuery("m.channel=? AND m.id IN (SELECT mid FROM events WHERE channel=? AND id>? ORDER BY id LIMIT 95)",[c.id,c.id,after],"m.id",120),
        sql("SELECT u.name FROM typing t JOIN users u ON t.uid=u.id WHERE t.channel=? AND t.expires>? AND t.uid<>? AND u.state='approved'",c.id,now,id),
      ]);
      result.cursor=(events.at(-1)?.id as number|undefined)??after;
      result.messages=messages;
      result.typing=typing;
    };
    const call=async ()=>{
      if (!q.has("peer")) return;
      const peer=string(q.get("peer"),64);
      // Only a room this account may still enter counts as joined.
      // A moved peer (see "move") still finds its row, under the new room, until it rejoins there.
      const room=await one<Voice>("SELECT v.* FROM voice v JOIN channels c ON c.id=v.channel AND c.kind='voice' WHERE v.uid=? AND (v.peer=? OR v.peer=?) AND v.expires>? AND "+channelAccess("c"),id,peer,movedPeer(peer),now,...access);
      result.voice=null;
      if (!room) return;
      // A moderator may have moved this person; the client follows when this differs from its room.
      result.room=room.channel;
      if (room.peer!==peer) { result.voice=[]; result.moved=true; return; }
      const statements=[
        // A just-joined sender must be visible in the roster for its signal to be processed.
        sql("SELECT id,sender,data FROM signals WHERE channel=? AND recipient=? AND id>? AND expires>? ORDER BY id LIMIT 100",room.channel,peer,number(q.get("signal")),now),
        sql("SELECT v.peer,v.uid,v.cam,v.screen,u.name FROM voice v JOIN users u ON v.uid=u.id JOIN channels c ON v.channel=c.id WHERE v.channel=? AND v.expires>? AND v.peer NOT LIKE 'moved:%' AND u.state='approved' AND "+channelAccess("c").replace("ca.uid=?","ca.uid=v.uid").replace("?='admin'","u.role='admin'").replace("ma.uid=?","ma.uid=v.uid")+" AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.uid=? AND b.blocked=v.uid) OR (b.uid=v.uid AND b.blocked=?)) ORDER BY v.joined,u.name COLLATE NOCASE,v.uid",room.channel,now,id,id),
      ];
      // The lease lasts 16 s; renewing once it is under 10 s saves a write on most polls.
      if (room.expires-now<lease-6000) statements.push(sql("UPDATE voice SET expires=? WHERE uid=? AND peer=?",now+lease,id,peer));
      const [signals,roster]=await many(statements);
      result.signals=signals;
      result.voice=roster;
    };
    const rooms=async ()=>{
      if (!q.has("rooms")) return;
      // Everyone currently in a voice room this viewer can see, for the channel sidebar.
      result.rooms=await all("SELECT v.channel,v.uid,u.name,u.avatar IS NOT NULL AS has_avatar,v.cam,v.screen,v.joined FROM voice v JOIN users u ON v.uid=u.id JOIN channels c ON v.channel=c.id WHERE v.expires>? AND u.state='approved' AND c.kind='voice' AND "+channelAccess("c")+" AND "+channelAccess("c").replace("ca.uid=?","ca.uid=v.uid").replace("?='admin'","u.role='admin'").replace("ma.uid=?","ma.uid=v.uid")+" AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.uid=? AND b.blocked=v.uid) OR (b.uid=v.uid AND b.blocked=?)) ORDER BY v.joined,u.name COLLATE NOCASE,v.uid",now,...access,id,id);
    };
    await Promise.all([seen,chat(),call(),rooms()]);
    return json(result);
  }
  if (path==="ice" && !write) {
    const stun=await one<{value:string}>("SELECT value FROM settings WHERE key='stun'");
    const servers:RTCIceServer[]=[{urls:stun?.value || "stun:stun.cloudflare.com:3478"}];
    // Cloudflare's TURN service hands out short-lived credentials for its relay. A relay lets calls
    // hide each person's IP address and connect through strict NATs.
    const cloudflare=env.RARRCORD_TURN_KEY_ID && env.RARRCORD_TURN_KEY_TOKEN;
    const broker=cloudflare?"https://rtc.live.cloudflare.com/v1/turn/keys/"+encodeURIComponent(env.RARRCORD_TURN_KEY_ID!)+"/credentials/generate-ice-servers":env.RARRCORD_TURN_BROKER;
    const secret=cloudflare?env.RARRCORD_TURN_KEY_TOKEN:env.RARRCORD_TURN_TOKEN;
    let relay=false;
    if (broker && secret) {
      try {
        const reply=await fetch(broker,{method:"POST",headers:{authorization:"Bearer "+secret,"content-type":"application/json"},body:JSON.stringify({ttl:86400}),signal:AbortSignal.timeout(2500)});
        if (reply.ok) {
          const data=await reply.json<{iceServers:RTCIceServer[]|RTCIceServer}>();
          for (const server of [data?.iceServers ?? []].flat()) {
            // Browsers block port 53, so those addresses only slow down connection setup.
            const urls=[server.urls].flat().filter(u=>typeof u==="string" && !/:53(\?|$)/.test(u));
            if (!urls.length) continue;
            servers.push({...server,urls});
            if (urls.some(u=>/^turns?:/.test(u))) relay=true;
          }
        }
      } catch {
        console.warn("RaRRcord TURN service unavailable; using STUN.");
      }
    }
    return json({servers,relay});
  }
  if (path==="transport" && !write) {
    if (request.headers.get("upgrade")?.toLowerCase()!=="websocket") return json({transport:"authenticated polling"});
    if (request.headers.get("origin")!==(env.RARRCORD_AUTH==="local" ? localOrigin(env) : url.origin)) deny(403,"Invalid WebSocket origin.");
    const sockets=new WebSocketPair();
    sockets[1].accept();
    sockets[1].send("RaRRcord WebSocket runtime probe");
    sockets[1].close(1000,"Probe complete");
    return new Response(null,{status:101,webSocket:sockets[0]});
  }
  if ((path==="attachment" || path==="avatar" || path==="servericon" || path==="serverbackground" || path==="applogo") && !write) {
    if (!env.BUCKET) deny(503,"File storage unavailable.");
    // There is only one app logo, so its URL carries no key.
    const key=path==="applogo"?"":string(q.get("key"),100);
    let storageKey=key;
    let filename="attachment";
    if (path==="attachment") {
      const row=await one<{channel:string;filename:string}>("SELECT channel,filename FROM messages WHERE attachment=? AND deleted=0",key);
      if (!row) deny(404,"File unavailable.");
      await chan(row.channel);
      filename=row.filename;
    } else if (path==="servericon") {
      // Only people who can see a server in their list (members and administrators) can load its picture.
      const row=await one<{picture:string|null}>("SELECT s.picture FROM servers s WHERE s.id=? AND (?='admin' OR EXISTS (SELECT 1 FROM members WHERE server=s.id AND uid=?))",key,account.role,id);
      if (!row?.picture) deny(404,"Server picture unavailable.");
      storageKey=row.picture;
    } else if (path==="applogo") {
      // Every approved member sees the app logo, so anyone signed in may load it.
      const row=await one<{value:string}>("SELECT value FROM settings WHERE key='app_logo'");
      if (!row?.value) deny(404,"App logo unavailable.");
      storageKey=row.value;
    } else if (path==="serverbackground") {
      // Same rule as the server picture: only people who can see the server can load its background.
      const row=await one<{background:string|null}>("SELECT s.background FROM servers s WHERE s.id=? AND (?='admin' OR EXISTS (SELECT 1 FROM members WHERE server=s.id AND uid=?))",key,account.role,id);
      if (!row?.background) deny(404,"Server background unavailable.");
      storageKey=row.background;
    } else {
      const row=await one<{avatar:string|null}>("SELECT avatar FROM users WHERE id=? AND state='approved'",key);
      if (!row?.avatar) deny(404,"Avatar unavailable.");
      storageKey=row.avatar;
    }
    // Storage keys are random and never reused, so the browser may keep a copy. Attachments never change;
    // an avatar URL is per user, so it is rechecked after 5 minutes and answered with 304 when unchanged.
    const etag='"'+storageKey+'"';
    const caching={"cache-control":path==="attachment"?"private, max-age=31536000, immutable":"private, max-age=300","etag":etag,"x-content-type-options":"nosniff"};
    if (request.headers.get("if-none-match")===etag) return new Response(null,{status:304,headers:caching});
    const object=await env.BUCKET.get(storageKey);
    if (!object) deny(404,"File unavailable.");
    const media=object.httpMetadata?.contentType ?? "application/octet-stream";
    return new Response(object.body,{headers:{...caching,"content-type":media,
      "content-disposition":(media.startsWith("image/") && !q.has("download")?"inline":"attachment")+"; filename*=UTF-8''"+encodeURIComponent(filename),
      "content-security-policy":"default-src 'none'; sandbox"}});
  }
  if (path==="admin" && !write) {
    if (!admin) deny(403,"Administrator access required.");
    return json({
      users:await all("SELECT id,username,name,state,role,seen,status FROM users ORDER BY state,name LIMIT 500"),
      channels:(await all<Channel & {allowed:string}>("SELECT c.*, (SELECT json_group_array(uid) FROM channel_members WHERE channel=c.id) allowed FROM channels c WHERE server IS NOT NULL ORDER BY position,name")).map(c=>({...c,allowed:JSON.parse(c.allowed)})),
      logs:await all("SELECT a.*,u.name FROM audit a LEFT JOIN users u ON a.uid=u.id ORDER BY a.id DESC LIMIT 80"),
      streams:await all("SELECT v.uid,u.name,c.name room,v.cam,v.screen FROM voice v JOIN users u ON v.uid=u.id JOIN channels c ON v.channel=c.id WHERE expires>? AND u.state='approved'",now),
      roles:await all("SELECT * FROM roles ORDER BY server,name"), members:await all("SELECT * FROM members"),
    });
  }
  if (!write) deny(404,"Unknown operation.");
  if (path==="upload" || path==="avatar" || path==="servericon" || path==="serverbackground" || path==="applogo") {
    // Server pictures and backgrounds are both per-server images that only administrators may change.
    const serverImage=path==="servericon" || path==="serverbackground";
    if ((serverImage || path==="applogo") && !admin) deny(403,"Administrator access required.");
    await throttle(path,18);
    if (!env.BUCKET) deny(503,"File storage unavailable.");
    const config=await one<{value:string}>("SELECT value FROM settings WHERE key='upload'");
    const limit=path==="serverbackground"?4194304:path!=="upload"?2097152:Math.min(Number(config?.value??8000000),20000000);
    // Without a length the whole body would be buffered before the size check below.
    const length=Number(request.headers.get("content-length"));
    if (!request.headers.has("content-length") || !Number.isSafeInteger(length)) deny(411,"Upload length required.");
    if (length>limit+30000) deny(413,"File too large.");
    const today=Math.floor(now/day);
    const used=await one<{hits:number}>("SELECT hits FROM rate WHERE uid=? AND bucket='bytes' AND minute=?",id,today);
    if ((used?.hits??0)+length>dailyUploadBytes) deny(413,"Daily upload limit reached. Try again tomorrow.");
    const data=await request.formData();
    const file=data.get("file");
    if (!file || typeof file==="string" || !file.size || file.size>limit) deny(413,"File missing or too large.");
    const c=path==="upload"?await chan(string(data.get("channel"),64)):null;
    const serverId=serverImage?string(data.get("server"),64):"";
    if (serverImage && !await one("SELECT 1 FROM servers WHERE id=?",serverId)) deny(404,"Server unavailable.");
    const gif=c && data.get("gif")==="1";
    const caption=gif?string(data.get("text")??"",8000,0):"";
    const reply=gif && data.has("reply")?number(data.get("reply")):null;
    if (c) await checkMessageTarget(c,reply);
    let filename=file.name.replace(/[\u0000-\u001f\u007f]/g,"").slice(0,180)||"attachment";
    const head=new Uint8Array(await file.slice(0,16).arrayBuffer());
    const ascii=String.fromCharCode(...head);
    const media=head[0]===137 && ascii.slice(1,4)==="PNG"?"image/png":
      head[0]===255 && head[1]===216 && head[2]===255?"image/jpeg":
      /^GIF8[79]a/.test(ascii)?"image/gif":ascii.startsWith("RIFF")&&ascii.slice(8,12)==="WEBP"?"image/webp":"application/octet-stream";
    if (!c && media==="application/octet-stream") deny(415,"Use a PNG, JPEG, GIF, or WebP image.");
    if (gif && media!=="image/gif") deny(415,"Choose a GIF file.");
    if (media==="image/gif" && !/\.gif$/i.test(filename)) filename=filename.slice(0,176)+".gif";
    const key=token();
    await env.BUCKET.put(key,file.stream(),{httpMetadata:{contentType:media}});
    // Counts toward today's upload allowance; "minute" holds the day number for this bucket.
    const tally=sql("INSERT INTO rate(uid,bucket,minute,hits) VALUES(?,'bytes',?,?) ON CONFLICT(uid,bucket) DO UPDATE SET hits=CASE WHEN minute=excluded.minute THEN hits+excluded.hits ELSE excluded.hits END, minute=excluded.minute",id,today,file.size);
    try {
      if (c) await db.batch([
        sql("INSERT INTO messages(channel,uid,body,attachment,filename,reply,created) VALUES(?,?,?,?,?,?,?)",c.id,id,caption,key,filename,reply,now),
        sql("INSERT INTO events(channel,mid,time) VALUES(?,last_insert_rowid(),?)",c.id,now),
        sql("DELETE FROM typing WHERE channel=? AND uid=?",c.id,id),
        tally,
      ]);
      else if (path==="servericon") {
        const old=await one<{picture:string|null}>("SELECT picture FROM servers WHERE id=?",serverId);
        await db.batch([sql("UPDATE servers SET picture=? WHERE id=?",key,serverId),sql("INSERT INTO audit(uid,action,detail,time) VALUES(?,?,?,?)",id,"server_picture",serverId,now),tally]);
        if (old?.picture) await env.BUCKET.delete(old.picture);
      } else if (path==="applogo") {
        const old=await one<{value:string}>("SELECT value FROM settings WHERE key='app_logo'");
        await db.batch([sql("INSERT INTO settings(key,value) VALUES('app_logo',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",key),sql("INSERT INTO audit(uid,action,detail,time) VALUES(?,?,?,?)",id,"app_logo","uploaded",now),tally]);
        if (old?.value) await env.BUCKET.delete(old.value);
      } else if (path==="serverbackground") {
        const old=await one<{background:string|null}>("SELECT background FROM servers WHERE id=?",serverId);
        await db.batch([sql("UPDATE servers SET background=? WHERE id=?",key,serverId),sql("INSERT INTO audit(uid,action,detail,time) VALUES(?,?,?,?)",id,"server_background",serverId,now),tally]);
        if (old?.background) await env.BUCKET.delete(old.background);
      } else {
        await db.batch([sql("UPDATE users SET avatar=? WHERE id=?",key,id),tally]);
        if (account.avatar) await env.BUCKET.delete(account.avatar);
      }
    } catch(error) {
      await env.BUCKET.delete(key);
      throw error;
    }
    return json({});
  }
  if (path==="message") {
    await throttle(path,45);
    const c=await chan(cid());
    const action=body.action??"send";
    if (action==="send") {
      const text=string(body.text,8000);
      const reply=body.reply?number(body.reply):null;
      await checkMessageTarget(c,reply);
      await db.batch([
        sql("INSERT INTO messages(channel,uid,body,reply,created) VALUES(?,?,?,?,?)",c.id,id,text,reply,now),
        sql("INSERT INTO events(channel,mid,time) VALUES(?,last_insert_rowid(),?)",c.id,now),
        sql("DELETE FROM typing WHERE channel=? AND uid=?",c.id,id)
      ]);
      return json({});
    }
    const mid=number(body.id);
    const m=await one<{uid:string;attachment:string|null}>("SELECT uid,attachment FROM messages WHERE channel=? AND id=? AND deleted=0",c.id,mid);
    if (!m) deny(404,"Message unavailable.");
    if (action==="react") {
      await checkMessageTarget(c,null);
      const emoji=string(body.emoji,64);
      if (!unicodeEmoji.test(emoji)) deny(400,"Invalid reaction.");
      await db.batch([body.remove?sql("DELETE FROM reactions WHERE mid=? AND uid=? AND emoji=?",mid,id,emoji):
        sql("INSERT OR IGNORE INTO reactions(mid,uid,emoji) VALUES(?,?,?)",mid,id,emoji),changed(c.id,mid)]);
      return json({});
    }
    if (action==="edit" && m.uid===id) {
      await timedOut(c);
      await db.batch([sql("UPDATE messages SET body=?,edited=? WHERE id=?",string(body.text,8000),now,mid),changed(c.id,mid)]);
    } else if (action==="delete" && (m.uid===id || await moderate(c))) {
      await db.batch([sql("UPDATE messages SET deleted=1,body='',attachment=NULL,filename=NULL WHERE id=?",mid),changed(c.id,mid)]);
      if (m.attachment) await env.BUCKET?.delete(m.attachment);
    } else if (action==="pin" && (m.uid===id || await moderate(c))) {
      await db.batch([sql("UPDATE messages SET pinned=1-pinned WHERE id=?",mid),changed(c.id,mid)]);
    } else if (action==="report") {
      await audit("message reported",c.id+"/"+mid+" "+string(body.reason,240)).run();
    } else deny(403,"Message action unavailable.");
    return json({});
  }
  if (path==="read" || path==="typing") {
    const c=await chan(cid());
    if (path==="read") {
      const mid=number(body.id);
      if (await one("SELECT 1 FROM messages WHERE id=? AND channel=?",mid,c.id)) {
        await run("INSERT INTO reads(channel,uid,mid) VALUES(?,?,?) ON CONFLICT(channel,uid) DO UPDATE SET mid=MAX(mid,excluded.mid)",c.id,id,mid);
      }
    } else {
      await throttle(path,25);
      // Typing while timed out is ignored rather than refused, so the composer stays quiet.
      if (c.server && await one("SELECT 1 FROM members WHERE server=? AND uid=? AND timeout>?",c.server,id,now)) return json({});
      await run("INSERT INTO typing(channel,uid,expires) VALUES(?,?,?) ON CONFLICT(channel,uid) DO UPDATE SET expires=excluded.expires",c.id,id,now+5000);
    }
    return json({});
  }
  if (path==="profile") {
    await throttle(path,12);
    const name=env.RARRCORD_AUTH==="local" ? account.username : label(body.name,40);
    if (await nameTaken(db,name,id)) deny(409,"Another member already uses that name.");
    const status=string(body.status,10);
    if (!["online","idle","dnd","offline"].includes(status)) deny(400,"Invalid status.");
    const prefs=JSON.stringify(body.prefs??{});
    if (prefs.length>5000) deny(400,"Too many preferences.");
    await run("UPDATE users SET name=?,status=?,prefs=? WHERE id=?",name,status,prefs,id);
    return json({});
  }
  if (path==="dm" || path==="block") {
    await throttle(path,15);
    const ids=[...new Set((Array.isArray(body.users)?body.users:[]).map(v=>string(v,200)))];
    if (!ids.length || ids.length>8 || ids.includes(id)) deny(400,"Select community members.");
    if (path==="block") {
      if (ids.length!==1) deny(400,"Select one member.");
      await (body.remove?run("DELETE FROM blocks WHERE uid=? AND blocked=?",id,ids[0]):run("INSERT OR IGNORE INTO blocks(uid,blocked) VALUES(?,?)",id,ids[0]));
      return json({});
    }
    const names=[];
    for (const uid of ids) {
      const person=await one<{name:string}>("SELECT u.name FROM users u WHERE u.id=? AND u.state='approved' AND EXISTS (SELECT 1 FROM members a JOIN members b ON a.server=b.server WHERE a.uid=? AND b.uid=u.id) AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.uid=? AND b.blocked=u.id) OR (b.uid=u.id AND b.blocked=?))",uid,id,id,id);
      if (!person) deny(403,"Member unavailable for direct messaging.");
      names.push(person.name);
    }
    // Nobody in a group may have blocked anyone else in it.
    if (ids.length>1 && await one("SELECT 1 FROM blocks WHERE uid IN (SELECT value FROM json_each(?)) AND blocked IN (SELECT value FROM json_each(?))",JSON.stringify(ids),JSON.stringify(ids))) deny(403,"Member unavailable for direct messaging.");
    const dm=await digest(JSON.stringify([id,...ids].sort()));
    await db.batch([sql("INSERT OR IGNORE INTO channels(id,name,kind,category) VALUES(?,?,'dm','Direct messages')",dm,label(body.name??names.join(", ").slice(0,80),80)),
      ...[id,...ids].map(uid=>sql("INSERT OR IGNORE INTO channel_members(channel,uid) VALUES(?,?)",dm,uid))]);
    return json({id:dm});
  }
  if (path==="moderate") {
    // Disconnect from voice, kick from a server, or time out, like Discord's member actions.
    // Administrators can act on anyone but themselves and other administrators; a server's
    // moderators can act on its ordinary members.
    await throttle(path,30);
    const action=string(body.action,16), target=string(body.target,200), server=string(body.server,64);
    if (!["disconnect","kick","timeout"].includes(action)) deny(400,"Invalid moderation action.");
    if (!await one("SELECT 1 FROM servers WHERE id=?",server)) deny(404,"Server unavailable.");
    const mine=await one<{role:string}>("SELECT role FROM members WHERE server=? AND uid=?",server,id);
    if (!admin && mine?.role!=="moderator") deny(403,"Moderating members requires administrator or moderator access.");
    if (target===id) deny(409,"You cannot do that to yourself.");
    const person=await one<User>("SELECT * FROM users WHERE id=?",target);
    const membership=await one<{role:string}>("SELECT role FROM members WHERE server=? AND uid=?",server,target);
    if (!person || !membership) deny(404,"That person is not in this server.");
    if (person.role==="admin") deny(403,"Administrators cannot be kicked or timed out.");
    if (!admin && membership.role==="moderator") deny(403,"Only an administrator can moderate another moderator.");
    // Voice rooms of this server that the person is in.
    const leaveVoice=sql("DELETE FROM voice WHERE uid=? AND channel IN (SELECT id FROM channels WHERE server=? AND kind='voice')",target,server);
    const commands:D1PreparedStatement[]=[];
    let detail=target+" in "+server;
    if (action==="disconnect") {
      if (!await one("SELECT 1 FROM voice v JOIN channels c ON c.id=v.channel WHERE v.uid=? AND c.server=? AND v.expires>?",target,server,now)) deny(404,"That person is not in a voice room here.");
      commands.push(leaveVoice);
    } else if (action==="kick") {
      commands.push(leaveVoice,
        sql("DELETE FROM typing WHERE uid=? AND channel IN (SELECT id FROM channels WHERE server=?)",target,server),
        sql("DELETE FROM members WHERE server=? AND uid=?",server,target));
    } else {
      // 0 lifts a timeout; otherwise one minute to 28 days, Discord's limit.
      const duration=number(body.duration);
      if (duration!==0 && (duration<60000 || duration>28*day)) deny(400,"Choose a timeout between one minute and 28 days.");
      const until=duration?now+duration:0;
      commands.push(sql("UPDATE members SET timeout=? WHERE server=? AND uid=?",until,server,target));
      if (duration) commands.push(leaveVoice,sql("DELETE FROM typing WHERE uid=? AND channel IN (SELECT id FROM channels WHERE server=?)",target,server));
      detail+=duration?" for "+timeLeft(duration):" lifted";
    }
    commands.push(audit(action==="timeout"&&!number(body.duration)?"timeout removed":action==="disconnect"?"voice disconnect":action,detail));
    await db.batch(commands);
    return json({});
  }
  if (path==="move" && write) {
    // Moving someone between voice rooms, Discord's "Move members". Administrators can move anyone;
    // a server's moderators can move people between that server's rooms.
    await throttle("move",30);
    const target=string(body.target,200);
    const to=await chan(cid(),"voice");
    const current=await one<Voice>("SELECT * FROM voice WHERE uid=? AND expires>?",target,now);
    if (!current) deny(404,"That person is no longer in a voice room.");
    const from=await chan(current.channel,"voice");
    if (from.id===to.id) return json({moved:false});
    if (from.server!==to.server) deny(400,"Move people between rooms of the same server.");
    if (!await moderate(from)) deny(403,"Moving members requires administrator or moderator access.");
    const person=await one<User>("SELECT * FROM users WHERE id=? AND state='approved'",target);
    if (!person) deny(404,"Account unavailable.");
    // The person must be allowed into the destination themselves.
    if (!await one("SELECT 1 FROM channels c WHERE c.id=? AND "+channelAccess("c"),to.id,person.id,person.role,person.id)) deny(403,"That person cannot join "+to.name+".");
    // The row moves at once, so the sidebar shows it, but its peer is parked under a "moved:" name
    // that no call roster lists. The person's client sees the new room on its next poll and
    // rejoins there with a fresh connection, so nobody in either room talks to the old peer.
    const moved=await one("UPDATE voice SET channel=?,peer=CASE WHEN peer LIKE 'moved:%' THEN peer ELSE 'moved:'||peer END,cam=0,screen=0 WHERE uid=? AND channel=? AND expires>? AND (SELECT COUNT(*) FROM voice WHERE channel=? AND expires>? AND uid<>?)<6 RETURNING uid",
      to.id,target,from.id,now,to.id,now,target);
    if (!moved) deny(409,to.name+" already has six peers.");
    await audit("voice move",target+" "+from.id+" -> "+to.id).run();
    return json({moved:true});
  }
  if (path==="voice" || path==="signal") {
    const room=await chan(cid(),"voice");
    const peer=string(body.peer,64);
    if (!/^[a-f0-9-]{36}$/.test(peer)) deny(400,"Invalid peer ID.");
    if (path==="voice" && body.action==="join") {
      await throttle("join",15);
      await timedOut(room);
      const count=await one<{count:number}>("SELECT COUNT(*) count FROM voice WHERE channel=? AND expires>? AND uid<>?",room.id,now,id);
      if ((count?.count??0)>=6) deny(409,"This room already has six peers.");
      // joined orders the room's roster and tiles. A reconnect into the same room keeps its place;
      // a new room, a lapsed lease or a rejoin after being moved ("moved:" peer) starts at the end.
      await run("INSERT INTO voice(uid,channel,peer,expires,joined) VALUES(?,?,?,?,?) ON CONFLICT(uid) DO UPDATE SET joined=CASE WHEN voice.channel=excluded.channel AND voice.expires>excluded.joined AND voice.peer NOT LIKE 'moved:%' THEN voice.joined ELSE excluded.joined END,channel=excluded.channel,peer=excluded.peer,expires=excluded.expires,cam=0,screen=0",id,room.id,peer,now+lease,now);
      return json({});
    }
    const current=await one<Voice>("SELECT * FROM voice WHERE channel=? AND uid=? AND peer=? AND expires>?",room.id,id,peer,now);
    if (!current) deny(403,"Join the voice room first.");
    if (path==="voice") {
      if (body.action==="leave") await run("DELETE FROM voice WHERE uid=? AND peer=?",id,peer);
      else await run("UPDATE voice SET cam=?,screen=? WHERE uid=? AND peer=?",body.cam?1:0,body.screen?1:0,id,peer);
      return json({});
    }
    await throttle("signal",240);
    const target=string(body.target,64);
    const recipient=await one("SELECT v.uid FROM voice v JOIN users u ON u.id=v.uid JOIN channels c ON c.id=v.channel WHERE v.peer=? AND v.channel=? AND v.expires>? AND v.uid<>? AND u.state='approved' AND "+channelAccess("c").replace("ca.uid=?","ca.uid=v.uid").replace("?='admin'","u.role='admin'").replace("ma.uid=?","ma.uid=v.uid")+" AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.uid=? AND b.blocked=v.uid) OR (b.uid=v.uid AND b.blocked=?))",target,room.id,now,id,id,id);
    if (!recipient) deny(404,"Peer unavailable.");
    const data=body.data as Record<string,unknown>|null;
    if (!data || typeof data!=="object" || !["description","ice","candidates","subscribe","tracks","speaking"].includes(String(data.type))) deny(400,"Invalid signaling event.");
    const encoded=JSON.stringify(data);
    if (encoded.length>40000) deny(413,"Signaling event too large.");
    await db.batch([
      sql("DELETE FROM signals WHERE expires<=?",now),
      sql("INSERT INTO signals(channel,sender,recipient,data,expires) VALUES(?,?,?,?,?)",room.id,peer,target,encoded,now+30000),
    ]);
    return json({});
  }
  if (path==="admin") {
    if (!admin) deny(403,"Administrator access required.");
    await throttle(path,40);
    const action=string(body.action,32);
    const target=body.target?string(body.target,200):"";
    const commands:D1PreparedStatement[]=[];
    const key=crypto.randomUUID();
    let invitation:string|undefined;
    // Files to remove from storage once the database changes are committed.
    let files:string[]=[];
    // Everything stored for the channels a query selects, so deleting a channel leaves nothing behind.
    const purge=async (channelQuery:string, value:string)=>{
      files=(await all<{attachment:string}>("SELECT attachment FROM messages WHERE attachment IS NOT NULL AND channel IN ("+channelQuery+")",value)).map(r=>r.attachment);
      const scoped=(table:string, column="channel")=>sql("DELETE FROM "+table+" WHERE "+column+" IN ("+channelQuery+")",value);
      commands.push(
        sql("DELETE FROM reactions WHERE mid IN (SELECT id FROM messages WHERE channel IN ("+channelQuery+"))",value),
        scoped("messages"),scoped("events"),scoped("reads"),scoped("typing"),scoped("channel_members"),scoped("signals"),scoped("voice"),
      );
    };
    if (action==="account") {
      const state=string(body.state,16);
      const role=string(body.role,16);
      if (!["pending","approved","suspended","banned","deleted"].includes(state) || !["admin","member"].includes(role)) deny(400,"Invalid account status.");
      const existing=await one<User>("SELECT * FROM users WHERE id=?",target);
      if (!existing) deny(404,"Account unavailable.");
      const downgrade=existing.role==="admin" && (role!=="admin" || state!=="approved");
      if (downgrade && target===id) deny(409,"Ask another administrator to change your administrator access.");
      if (downgrade && !await one("SELECT 1 FROM users WHERE id<>? AND role='admin' AND state='approved'",target)) deny(409,"Keep at least one active administrator.");
      commands.push(sql("UPDATE users SET state=?,role=?,epoch=epoch+1 WHERE id=? AND (role<>'admin' OR (?='approved' AND ?='admin') OR EXISTS (SELECT 1 FROM users WHERE id<>? AND role='admin' AND state='approved'))",state,role,target,state,role,target));
      commands.push(sql("DELETE FROM sessions WHERE uid=?",target),sql("DELETE FROM voice WHERE uid=?",target));
      if (env.RARRCORD_AUTH==="local" && ["suspended","banned","deleted"].includes(state)) commands.push(sql("DELETE FROM local_sessions WHERE username=?",target.slice(6)));
      if (state==="deleted") {
        commands.push(sql("UPDATE users SET name='Deleted user', avatar=NULL,prefs='{}' WHERE id=?",target));
        if (existing.avatar) files.push(existing.avatar);
      }
    } else if (action==="revoke") {
      if (env.RARRCORD_AUTH==="local") commands.push(sql("DELETE FROM local_sessions WHERE username=?",target.slice(6)));
      commands.push(sql("UPDATE users SET epoch=epoch+1 WHERE id=?",target),sql("DELETE FROM sessions WHERE uid=?",target),sql("DELETE FROM voice WHERE uid=?",target));
    } else if (action==="disconnect") commands.push(sql("DELETE FROM voice WHERE uid=?",target));
    else if (action==="server") {
      const name=label(body.name,60);
      if (target) commands.push(sql("UPDATE servers SET name=?,icon=? WHERE id=?",name,string(body.icon??"",4,0),target));
      else commands.push(sql("INSERT INTO servers(id,name,icon) VALUES(?,?,?)",key,name,string(body.icon??"",4,0)),sql("INSERT INTO members(server,uid) VALUES(?,?)",key,id));
    } else if (action==="app_logo_remove") {
      const row=await one<{value:string}>("SELECT value FROM settings WHERE key='app_logo'");
      commands.push(sql("DELETE FROM settings WHERE key='app_logo'"));
      if (row?.value) files.push(row.value);
    } else if (action==="server_picture_remove") {
      const row=await one<{picture:string|null}>("SELECT picture FROM servers WHERE id=?",target);
      if (!row) deny(404,"Server unavailable.");
      commands.push(sql("UPDATE servers SET picture=NULL WHERE id=?",target));
      if (row.picture) files.push(row.picture);
    } else if (action==="server_background") {
      // Sets the colour or gradient and the dimming; removeImage also clears an uploaded image.
      const row=await one<{background:string|null}>("SELECT background FROM servers WHERE id=?",target);
      if (!row) deny(404,"Server unavailable.");
      const fill=string(body.fill??"",24,0).toLowerCase();
      if (fill && !/^#[0-9a-f]{6}$/.test(fill) && !backgroundPresets.some(p=>fill==="preset:"+p)) deny(400,"Choose a colour or one of the gradients.");
      const dim=number(body.dim,60);
      if (dim>90) deny(400,"Dimming must be between 0 and 90.");
      const removeImage=body.removeImage===true;
      commands.push(sql("UPDATE servers SET background_fill=?,background_dim=?"+(removeImage?",background=NULL":"")+" WHERE id=?",fill,dim,target));
      if (removeImage && row.background) files.push(row.background);
    } else if (action==="server_delete") {
      await purge("SELECT id FROM channels WHERE server=?",target);
      const old=await one<{picture:string|null;background:string|null}>("SELECT picture,background FROM servers WHERE id=?",target);
      if (old?.picture) files.push(old.picture);
      if (old?.background) files.push(old.background);
      commands.push(sql("DELETE FROM channels WHERE server=?",target),sql("DELETE FROM members WHERE server=?",target),sql("DELETE FROM roles WHERE server=?",target),sql("DELETE FROM invites WHERE server=?",target),sql("DELETE FROM servers WHERE id=?",target));
    } else if (action==="channel") {
      const server=string(body.server,64), name=label(body.name,60), kind=string(body.kind,12);
      if (!["text","voice","private"].includes(kind) || !await one("SELECT 1 FROM servers WHERE id=?",server)) deny(400,"Invalid channel.");
      if (target && !await one("SELECT 1 FROM channels WHERE id=? AND server=? AND kind<>'dm'",target,server)) deny(404,"Channel unavailable.");
      const args:Value[]=[name,kind,string(body.category??"",40,0),string(body.description??"",200,0),string(body.permission??"",32,0),number(body.position)];
      commands.push(target?sql("UPDATE channels SET name=?,kind=?,category=?,description=?,permission=?,position=? WHERE id=?",...args,target):
        sql("INSERT INTO channels(name,kind,category,description,permission,position,id,server) VALUES(?,?,?,?,?,?,?,?)",...args,key,server));
      if (kind==="private") {
        commands.push(sql("DELETE FROM channel_members WHERE channel=?",target||key));
        const allowed=Array.isArray(body.users)?body.users.slice(0,100).map(uid=>string(uid,200)):[id];
        for (const uid of new Set(allowed)) commands.push(sql("INSERT INTO channel_members(channel,uid) SELECT ?,uid FROM members WHERE server=? AND uid=?",target||key,server,uid));
      }
    } else if (action==="order") {
      const server=string(body.server,64), destination=string(body.destination,64);
      const rows=await all<{id:string}>("SELECT id FROM channels WHERE server=? ORDER BY position,name,id",server);
      const from=rows.findIndex(row=>row.id===target), to=rows.findIndex(row=>row.id===destination);
      if (from<0 || to<0) deny(404,"Channel unavailable.");
      const [item]=rows.splice(from,1);
      rows.splice(to,0,item);
      commands.push(...rows.map((row,i)=>sql("UPDATE channels SET position=? WHERE id=? AND server=?",i,row.id,server)));
    } else if (action==="channel_delete") {
      await purge("SELECT id FROM channels WHERE id=? AND kind<>'dm'",target);
      commands.push(sql("DELETE FROM channels WHERE id=? AND kind<>'dm'",target));
    }
    else if (action==="role") {
      const server=string(body.server,64), role=string(body.role,32);
      if (!await one("SELECT 1 FROM servers WHERE id=?",server)) deny(404,"Server unavailable.");
      commands.push(sql("INSERT OR IGNORE INTO roles(server,name) VALUES(?,?)",server,role));
    } else if (action==="member") {
      const server=string(body.server,64), role=string(body.role,32);
      if (!await one("SELECT 1 FROM servers WHERE id=?",server) || !await one("SELECT 1 FROM users WHERE id=?",target) ||
          (!["member","moderator"].includes(role) && !await one("SELECT 1 FROM roles WHERE server=? AND name=?",server,role))) deny(400,"Invalid membership.");
      commands.push(body.remove?sql("DELETE FROM members WHERE server=? AND uid=?",server,target):
        sql("INSERT INTO members(server,uid,role) VALUES(?,?,?) ON CONFLICT(server,uid) DO UPDATE SET role=excluded.role",server,target,role));
    } else if (action==="invite") {
      invitation=token();
      commands.push(sql("INSERT INTO invites(token,server,expires) VALUES(?,?,?)",await digest(invitation),target||null,now+7*day));
    } else if (action==="settings") {
      const bitrate=number(body.bitrate), upload=number(body.upload);
      const stun=string(body.stun??"",200,0);
      if (bitrate>4294967 || (bitrate>0 && bitrate<500)) deny(400,"Set a bitrate ceiling of at least 500 Kbps or leave it blank.");
      if (upload<100000 || upload>20000000 || (stun && !/^stuns?:[a-z0-9.-]+(?::[0-9]+)?$/i.test(stun))) deny(400,"Invalid application settings.");
      for (const [k,val] of Object.entries({bitrate:String(bitrate),upload:String(upload),stun})) commands.push(sql("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",k,val));
    } else deny(400,"Invalid administration action.");
    commands.push(audit(action,target||key));
    await db.batch(commands);
    // R2 deletes at most 1000 keys per call.
    for (let i=0;i<files.length;i+=1000) await env.BUCKET?.delete(files.slice(i,i+1000));
    return json({invitation,id:key});
  }
  deny(404,"Unknown operation.");
}

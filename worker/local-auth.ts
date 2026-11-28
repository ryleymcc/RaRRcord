import { randomBytes, createHash, scryptSync, timingSafeEqual } from "node:crypto";

const cookieName = "__Host-rarr-local";
const lifetime = 7 * 86400;
const usernamePattern = /^[a-z0-9_]{3,24}$/;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const same = (a: string, b: string) => timingSafeEqual(Buffer.from(hash(a), "hex"), Buffer.from(hash(b), "hex"));
const derive = (password: string, salt: string) => scryptSync(password, Buffer.from(salt, "hex"), 32, { N: 32768, r: 8, p: 3, maxmem: 64 * 1024 * 1024 }).toString("hex");
const cookie = (value: string, age: number) => `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
const token = (request: Request) => (request.headers.get("cookie") ?? "").match(/(?:^|;\s*)__Host-rarr-local=([a-f0-9]{64})(?:;|$)/)?.[1];
export const localEmail = (username: string) => `${username}@rarrcord.invalid`;
export const localId = (username: string) => `local:${username}`;

export function localOrigin(env: Cloudflare.Env): string | null {
  try {
    const url = new URL(env.RARRCORD_PUBLIC_ORIGIN ?? "");
    return url.protocol === "https:" && url.origin === env.RARRCORD_PUBLIC_ORIGIN ? url.origin : null;
  } catch { return null; }
}

export async function localIdentity(request: Request, env: Cloudflare.Env) {
  const raw = token(request);
  if (!raw || !env.DB || !localOrigin(env)) return null;
  const row = await env.DB.prepare("SELECT s.username FROM local_sessions s JOIN local_accounts a ON a.username=s.username WHERE s.token=? AND s.expires>?")
    .bind(hash(raw), Date.now()).first<{username:string}>();
  return row ? { id: localId(row.username), email: localEmail(row.username), name: row.username } : null;
}

export async function localLogout(request: Request, env: Cloudflare.Env): Promise<string> {
  const raw = token(request);
  if (raw && env.DB) await env.DB.prepare("DELETE FROM local_sessions WHERE token=?").bind(hash(raw)).run();
  return cookie("", 0);
}

const htmlHeaders = { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" };
function form(message = "", status = 200) {
  // Only constant messages are passed here. Never interpolate supplied form values.
  return new Response(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>RaRRcord sign in</title><style>body{font:16px system-ui;background:#15171c;color:#eee;max-width:420px;margin:8vh auto;padding:20px}form{display:grid;gap:12px;background:#22252c;padding:20px;border-radius:12px;margin:18px 0}label{display:grid;gap:5px}input,button{font:inherit;padding:10px;border-radius:6px;border:1px solid #555}input{background:#15171c;color:#eee}button{background:#5865f2;color:white;cursor:pointer}a{color:#aeb6ff}</style><h1>RaRRcord</h1>${message ? `<p role="alert">${message}</p>` : ""}<form method="post" action="/signin-with-chatgpt"><h2>Sign in</h2><input type="hidden" name="action" value="login"><label>Username<input name="username" autocomplete="username" required maxlength="24"></label><label>Password<input type="password" name="password" autocomplete="current-password" required maxlength="128"></label><button>Sign in</button></form><form method="post" action="/signin-with-chatgpt"><h2>Create account</h2><input type="hidden" name="action" value="register"><label>Username<input name="username" autocomplete="username" required minlength="3" maxlength="24" pattern="[A-Za-z0-9_]+"></label><label>Password (at least 12 characters)<input type="password" name="password" autocomplete="new-password" required minlength="12" maxlength="128"></label><label>Registration code<input type="password" name="code" required maxlength="128" autocomplete="off"></label><button>Create account</button></form><p>Your sign-in username is your public display name. Never use a password as your username. Members require administrator approval.</p><a href="/privacy">Privacy</a></html>`, { status, headers: htmlHeaders });
}

async function limitedForm(request: Request) {
  if (!request.headers.get("content-type")?.startsWith("application/x-www-form-urlencoded")) return null;
  if (Number(request.headers.get("content-length") ?? 0) > 4096 || !request.body) return null;
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let size = 0, text = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); return null; }
      text += decoder.decode(value, { stream: true });
    }
    return new URLSearchParams(text + decoder.decode());
  } finally { reader.releaseLock(); }
}

// Persisted fixed-window limits; the global limit also bounds new per-user rows and KDF load.
async function allowAttempt(db: D1Database, bucket: string, limit: number, minute: number) {
  const row = await db.prepare("INSERT INTO local_auth_rate(bucket,minute,hits) VALUES(?,?,1) ON CONFLICT(bucket) DO UPDATE SET hits=CASE WHEN minute=excluded.minute THEN hits+1 ELSE 1 END, minute=excluded.minute RETURNING hits")
    .bind(bucket, minute).first<{hits:number}>();
  return !!row && row.hits <= limit;
}

export async function localAuthRoute(request: Request, env: Cloudflare.Env): Promise<Response> {
  const db = env.DB, origin = localOrigin(env);
  const owner = env.RARRCORD_LOCAL_OWNER ?? "";
  if (!db || !origin || !usernamePattern.test(owner) || env.RARRCORD_OWNER_EMAIL !== localEmail(owner)) return form("Authentication is not configured.", 503);
  if (request.method === "GET") return form();
  if (request.method !== "POST") return form("Method not allowed.", 405);
  if (request.headers.get("origin") !== origin) return form("Invalid request origin.", 403);
  const body = await limitedForm(request);
  if (!body) return form("Invalid request.", 400);
  const username = (body.get("username") ?? "").trim().toLowerCase();
  const password = body.get("password") ?? "";
  const action = body.get("action");
  if (!usernamePattern.test(username) || password.length < 12 || password.length > 128 || (action !== "login" && action !== "register")) return form("Invalid username or password.", 400);
  const minute = Math.floor(Date.now() / 60000);
  if (!await allowAttempt(db, "global", 24, minute)) return form("Too many attempts. Try again in a minute.", 429);
  await db.prepare("DELETE FROM local_auth_rate WHERE minute<?").bind(minute - 5).run();
  if (!await allowAttempt(db, "user:" + username, 6, minute)) return form("Too many attempts. Try again in a minute.", 429);
  const account = await db.prepare("SELECT salt,password_hash FROM local_accounts WHERE username=?").bind(username).first<{salt:string;password_hash:string}>();
  if (action === "register") {
    if (password.trim().normalize("NFKC").toLowerCase() === username) return form("Choose a password different from your username.", 400);
    const code = body.get("code") ?? "";
    const expected = username === owner ? env.RARRCORD_OWNER_CODE : env.RARRCORD_REGISTRATION_CODE;
    if (!expected || expected.length < 24 || env.RARRCORD_OWNER_CODE === env.RARRCORD_REGISTRATION_CODE || code.length > 128 || !same(code, expected) || account) return form("Registration refused.", 403);
    // The owner must finish onboarding before any other account can register.
    if (username !== owner && !await db.prepare("SELECT 1 FROM users WHERE id=? AND role='admin' AND state='approved'").bind(localId(owner)).first()) return form("Administrator setup is not complete.", 403);
    const salt = randomBytes(16).toString("hex");
    const inserted = await db.prepare("INSERT OR IGNORE INTO local_accounts(username,salt,password_hash) VALUES(?,?,?)").bind(username, salt, derive(password, salt)).run();
    if (inserted.meta.changes !== 1) return form("Registration refused.", 403);
  } else {
    // Perform the same expensive operation even when the account is absent.
    const actual = derive(password, account?.salt ?? "00000000000000000000000000000000");
    if (!same(actual, account?.password_hash ?? "0".repeat(64)) || !account) return form("Invalid username or password.", 401);
  }
  const raw = randomBytes(32).toString("hex");
  const now = Date.now();
  const previous = token(request);
  await db.batch([
    db.prepare("DELETE FROM local_sessions WHERE expires<=? OR token=?").bind(now, previous ? hash(previous) : ""),
    db.prepare("INSERT INTO local_sessions(token,username,expires) VALUES(?,?,?)").bind(hash(raw), username, now + lifetime * 1000),
  ]);
  const headers = new Headers({ location: "/", "cache-control": "private, no-store" });
  headers.append("set-cookie", cookie(raw, lifetime));
  headers.append("set-cookie", "__Host-rarr=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0");
  return new Response(null, { status: 303, headers });
}

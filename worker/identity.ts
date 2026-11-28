// Works out who is making a request, before the app or the API sees it.
//
// RARRCORD_AUTH picks the sign-in provider:
//   "access": Cloudflare Access. The Worker verifies the signed Cf-Access-Jwt-Assertion token
//             against the team's public keys, so a request that skips Access (a workers.dev or
//             preview URL, or a hand-made request) gets no identity.
//   "sites":  OpenAI Sites. The Sites platform sets the oai-authenticated-user-* headers.
//             Only safe when the app is hosted on Sites.
// Anything else signs nobody in, so a missing setting fails closed.
//
// The result goes on the request as x-rarrcord-user-id / x-rarrcord-user-email. Copies of those
// headers sent by the browser are always removed first.

export const ID_HEADER = "x-rarrcord-user-id";
export const EMAIL_HEADER = "x-rarrcord-user-email";
export const NAME_HEADER = "x-rarrcord-user-name";
const SITES_ID = "oai-authenticated-user-id";
const SITES_EMAIL = "oai-authenticated-user-email";
const SITES_NAME = "oai-authenticated-user-full-name";
const SITES_NAME_ENCODING = "oai-authenticated-user-full-name-encoding";

export type Identity = { id: string; email: string; name?: string };

type Jwk = JsonWebKey & { kid?: string };
type Keys = { keys: Map<string, CryptoKey>; fetched: number };
const keyCache = new Map<string, Keys>();
const keyLifetime = 3600_000;

export function authMode(env: Cloudflare.Env): "access" | "sites" | null {
  if (env.RARRCORD_AUTH === "access" && env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD) return "access";
  if (env.RARRCORD_AUTH === "sites") return "sites";
  return null;
}

export function signOutPath(env: Cloudflare.Env) {
  return authMode(env) === "access" ? "/cdn-cgi/access/logout" : "/signout-with-chatgpt?return_to=%2F";
}

function teamOrigin(domain: string) {
  const host = domain.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  return "https://" + host;
}

function base64url(value: string) {
  const text = atob(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));
  return Uint8Array.from(text, c => c.charCodeAt(0));
}

async function signingKeys(origin: string, now: number, refresh = false, fetcher: typeof fetch = fetch) {
  const cached = keyCache.get(origin);
  if (cached && !refresh && now - cached.fetched < keyLifetime) return cached.keys;
  const reply = await fetcher(origin + "/cdn-cgi/access/certs", { signal: AbortSignal.timeout(3000) });
  if (!reply.ok) throw new Error("Access keys unavailable");
  const body = await reply.json() as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (!jwk.kid || jwk.kty !== "RSA") continue;
    keys.set(jwk.kid, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  keyCache.set(origin, { keys, fetched: now });
  return keys;
}

// Returns the token's claims when it is a valid Access token for this application, else null.
export async function verifyAccessToken(token: string, domain: string, audience: string, now = Date.now(), fetcher: typeof fetch = fetch) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string }, claims: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(base64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(base64url(parts[1])));
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;
  const origin = teamOrigin(domain);
  let keys = await signingKeys(origin, now, false, fetcher);
  // Access rotates its keys; an unknown key id means ours are stale.
  if (!keys.has(header.kid)) keys = await signingKeys(origin, now, true, fetcher);
  const key = keys.get(header.kid);
  if (!key) return null;
  const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, base64url(parts[2]), new TextEncoder().encode(parts[0] + "." + parts[1]));
  if (!valid) return null;
  const seconds = now / 1000;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== origin || !aud.includes(audience)) return null;
  if (typeof claims.exp !== "number" || claims.exp < seconds - 30) return null;
  if (typeof claims.nbf === "number" && claims.nbf > seconds + 30) return null;
  return claims;
}

function cookieValue(request: Request, name: string) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

export async function identify(request: Request, env: Cloudflare.Env, fetcher: typeof fetch = fetch): Promise<Identity | null> {
  const mode = authMode(env);
  if (mode === "sites") {
    const id = request.headers.get(SITES_ID), email = request.headers.get(SITES_EMAIL);
    if (!id || !email) return null;
    let name: string | undefined;
    const encoded = request.headers.get(SITES_NAME);
    if (encoded && request.headers.get(SITES_NAME_ENCODING) === "percent-encoded-utf-8") {
      try { name = decodeURIComponent(encoded); } catch { name = undefined; }
    }
    return { id, email, name };
  }
  if (mode === "access") {
    const token = request.headers.get("cf-access-jwt-assertion") ?? cookieValue(request, "CF_Authorization");
    if (!token) return null;
    let claims: Record<string, unknown> | null = null;
    try {
      claims = await verifyAccessToken(token, env.CF_ACCESS_TEAM_DOMAIN!, env.CF_ACCESS_AUD!, Date.now(), fetcher);
    } catch (error) {
      console.error("RaRRcord could not verify a Cloudflare Access token", error instanceof Error ? error.message : "unknown error");
    }
    // Service tokens carry no email and are not people.
    if (!claims || typeof claims.sub !== "string" || !claims.sub || typeof claims.email !== "string") return null;
    return { id: "cf:" + claims.sub, email: claims.email };
  }
  return null;
}

// The request the app and the API see: only the identity this Worker established.
export async function authenticate(request: Request, env: Cloudflare.Env, fetcher: typeof fetch = fetch) {
  const identity = await identify(request, env, fetcher);
  const headers = new Headers(request.headers);
  for (const name of [ID_HEADER, EMAIL_HEADER, NAME_HEADER, SITES_ID, SITES_EMAIL, SITES_NAME, SITES_NAME_ENCODING]) headers.delete(name);
  if (identity) {
    headers.set(ID_HEADER, identity.id);
    headers.set(EMAIL_HEADER, identity.email);
    if (identity.name) headers.set(NAME_HEADER, encodeURIComponent(identity.name));
  }
  return new Request(request, { headers });
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { authenticate, identify, signOutPath, verifyAccessToken } from "../worker/identity.ts";

const team = "rarr-test.cloudflareaccess.com", aud = "aud-123";
const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const other = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
const jwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid: "k1" };
let fetches = 0;
const fetcher = async url => { fetches++; assert.equal(url, "https://" + team + "/cdn-cgi/access/certs"); return Response.json({ keys: [jwk] }); };
const b64 = data => Buffer.from(data).toString("base64url");
async function sign(claims, { key = pair.privateKey, kid = "k1", alg = "RS256" } = {}) {
  const head = b64(JSON.stringify({ alg, kid })), body = b64(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, new TextEncoder().encode(head + "." + body));
  return head + "." + body + "." + b64(new Uint8Array(sig));
}
const now = Math.floor(Date.now() / 1000);
const good = { iss: "https://" + team, aud: [aud], sub: "user-1", email: "friend@example.test", exp: now + 600, iat: now };
const env = { RARRCORD_AUTH: "access", CF_ACCESS_TEAM_DOMAIN: team, CF_ACCESS_AUD: aud };

test("valid Access tokens are accepted and everything else is refused", async () => {
  assert.equal((await verifyAccessToken(await sign(good), team, aud, Date.now(), fetcher)).sub, "user-1");
  for (const bad of [
    await sign({ ...good, aud: ["someone-else"] }),
    await sign({ ...good, iss: "https://evil.cloudflareaccess.com" }),
    await sign({ ...good, exp: now - 120 }),
    await sign({ ...good, nbf: now + 600 }),
    await sign(good, { key: other.privateKey }),
    await sign(good, { alg: "HS256" }),
    (await sign(good)).replace(/\.[^.]+\./, "." + b64(JSON.stringify({ ...good, sub: "admin" })) + "."),
    "not-a-token",
  ]) assert.equal(await verifyAccessToken(bad, team, aud, Date.now(), fetcher), null);
  assert.ok(fetches <= 3, "keys are cached");
});

test("forged identity headers never get through", async () => {
  const forged = new Request("https://ra.example/api/ra/session", { headers: {
    "oai-authenticated-user-id": "owner", "oai-authenticated-user-email": "owner@example.test",
    "x-rarrcord-user-id": "owner", "x-rarrcord-user-email": "owner@example.test",
  } });
  for (const mode of [env, {}, { RARRCORD_AUTH: "access" }]) {
    const seen = await authenticate(forged, mode, fetcher);
    assert.equal(seen.headers.get("x-rarrcord-user-id"), null);
    assert.equal(seen.headers.get("oai-authenticated-user-id"), null);
  }
  const signed = new Request("https://ra.example/", { headers: { "cf-access-jwt-assertion": await sign(good), "x-rarrcord-user-id": "owner" } });
  const seen = await authenticate(signed, env, fetcher);
  assert.equal(seen.headers.get("x-rarrcord-user-id"), "cf:user-1");
  assert.equal(seen.headers.get("x-rarrcord-user-email"), "friend@example.test");
  assert.equal(await identify(new Request("https://ra.example/", { headers: { "cf-access-jwt-assertion": await sign({ ...good, email: undefined }) } }), env, fetcher), null);
  assert.equal(signOutPath(env), "/cdn-cgi/access/logout");
});

test("Sites mode keeps working when it is chosen explicitly", async () => {
  const request = new Request("https://ra.example/", { headers: { "oai-authenticated-user-id": "u1", "oai-authenticated-user-email": "u1@example.test", "oai-authenticated-user-full-name": "Ren%C3%A9", "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8" } });
  const seen = await authenticate(request, { RARRCORD_AUTH: "sites" });
  assert.equal(seen.headers.get("x-rarrcord-user-id"), "u1");
  assert.equal(decodeURIComponent(seen.headers.get("x-rarrcord-user-name")), "René");
  assert.equal(seen.headers.get("oai-authenticated-user-id"), null);
});

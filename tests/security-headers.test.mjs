import { test } from "node:test";
import assert from "node:assert/strict";
import { newNonce, pagePolicy, secure, withPolicy } from "../worker/security-headers.ts";

test("pages get a nonce policy and the standard headers", async () => {
  const nonce = newNonce();
  assert.match(nonce, /^[A-Za-z0-9+/]{24}$/);
  const policy = pagePolicy(nonce, "ra.example");
  assert.match(policy, new RegExp(`script-src 'self' 'nonce-${nonce.replace(/[+/]/g, "\\$&")}'`));
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /connect-src 'self' wss:\/\/ra\.example/);
  const forwarded = withPolicy(new Request("https://ra.example/"), policy);
  assert.equal(forwarded.headers.get("content-security-policy"), policy);
  const page = secure(new Response("<p>hi</p>", { headers: { "content-type": "text/html; charset=utf-8" } }), policy);
  assert.equal(page.headers.get("content-security-policy"), policy);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(page.headers.get("strict-transport-security"), /max-age=31536000/);
  assert.match(page.headers.get("permissions-policy"), /camera=\(self\)/);
  assert.equal(await page.text(), "<p>hi</p>");
});

test("existing headers win and non-HTML responses get no page policy", () => {
  const file = secure(new Response("x", { headers: { "content-type": "image/png", "content-security-policy": "default-src 'none'; sandbox" } }), "default-src 'self'");
  assert.equal(file.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  const json = secure(Response.json({}), "default-src 'self'");
  assert.equal(json.headers.get("content-security-policy"), null);
  assert.equal(json.headers.get("x-content-type-options"), "nosniff");
});

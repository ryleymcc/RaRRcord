// Browser security headers for every response the Worker produces.
// Pages get a nonce-based Content-Security-Policy: vinext reads the nonce from the
// request's CSP header and stamps it on the scripts it inlines.

export function pagePolicy(nonce: string, host: string) {
  return [
    "default-src 'self'",
    // 'wasm-unsafe-eval' lets the noise-suppression worklets compile their WebAssembly models.
    `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
    // React style attributes are inline styles; fonts come from Google Fonts until they are self-hosted.
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' data: https://fonts.gstatic.com",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    `connect-src 'self' wss://${host}`,
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    "upgrade-insecure-requests",
  ].join("; ");
}

const always: Record<string, string> = {
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "same-origin",
  "cross-origin-opener-policy": "same-origin",
  "permissions-policy": "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=(), serial=(), bluetooth=()",
};

export function newNonce() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...bytes));
}

// Gives the page renderer a request that carries the policy, so its inline scripts get the nonce.
export function withPolicy(request: Request, policy: string) {
  const headers = new Headers(request.headers);
  headers.set("content-security-policy", policy);
  return new Request(request, { headers });
}

// Adds the headers without overriding any the response already set, such as the sandbox policy on files.
export function secure(response: Response, policy?: string) {
  if (response.status === 101 || (response as Response & { webSocket?: unknown }).webSocket) return response;
  const result = new Response(response.body, response);
  for (const [name, value] of Object.entries(always)) if (!result.headers.has(name)) result.headers.set(name, value);
  const html = result.headers.get("content-type")?.includes("text/html");
  if (policy && html && !result.headers.has("content-security-policy")) result.headers.set("content-security-policy", policy);
  return result;
}

import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";
import { api } from "./ra";
import { authenticate } from "./identity";
import { newNonce, pagePolicy, secure, withPolicy } from "./security-headers";

const worker = {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    // The dev server injects its own inline scripts, so the headers apply to production builds only.
    // Local development signs in through the Sites mock, which only answers loopback requests.
    if (import.meta.env.DEV) {
      const local = env.RARRCORD_AUTH ? env : { ...env, RARRCORD_AUTH: "sites" };
      return render(await authenticate(request, local), local, ctx);
    }
    const signedIn = await authenticate(request, env);
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/ra/")) return secure(await api(signedIn, env));
    const policy = pagePolicy(newNonce(), url.host);
    return secure(await render(withPolicy(signedIn, policy), env, ctx), policy);
  },
};

function render(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>): Response | Promise<Response> {
  if (new URL(request.url).pathname.startsWith("/api/ra/")) return api(request, env);
  let binding = ctx.props?.CONNECTORS;
  // Local preview emulates the same request-scoped capability. This branch and
  // the auxiliary service binding are absent from production builds.
  if (import.meta.env.DEV && !binding && env.CONNECTORS) {
    const preview = env.CONNECTORS;
    const expiresAt = Date.now() + 60_000;
    binding = {
      async getContext() {
        if (Date.now() >= expiresAt) return { status: "request_context_expired" };
        return preview.getContext?.() ?? { status: "binding_unavailable" };
      },
      async invoke(connectorId, actionName, args) {
        if (Date.now() >= expiresAt) {
          return { status: "request_context_expired", message: "This request has expired. Please try again." };
        }
        return preview.invoke(connectorId, actionName, args);
      },
    };
  }
  return runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
}

export default worker;

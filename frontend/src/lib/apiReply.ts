/**
 * One place to answer "the server replied with something that is not JSON".
 *
 * Both local-custom API clients (`alertsApi.ts`, `warehouseApi.ts`) used to
 * either crash on it or invent their own sentence, and upstream's `api.ts`
 * already handles it with a content-type check. This is that check, with the
 * part that was missing: *why* a request can come back 200 and still be HTML.
 *
 * A 200 is not evidence of data. Two handlers answer unmatched paths with the
 * web app's own `index.html` at status **200**:
 *
 * - Vite's dev-server SPA fallback, which fires for any path whose prefix is
 *   absent from `PROXY_PATHS` in `vite.config.ts`;
 * - `SPAStaticFiles` on the API server, which fires for any `/api/...` route
 *   the *running* process never registered.
 *
 * Either one makes `res.ok` true, so the only symptom is a bare
 * `SyntaxError: Unexpected token '<'` in the browser. That shell also carries
 * `ETag`/`Last-Modified` with no `Cache-Control`, so a cache can keep the wrong
 * answer for hours after the server was fixed. All three causes are named, with
 * an action each, in the order they can be checked: a message that points at
 * only one of them is a lead the next failure will send you down.
 */

export function contentTypeOf(res: Response): string {
  return res.headers.get("content-type") ?? "unknown";
}

export function isJsonReply(res: Response): boolean {
  return contentTypeOf(res).toLowerCase().includes("json");
}

/** The sentence every client shows when a reply is not JSON. */
export function nonJsonReplyMessage(path: string, res: Response): string {
  return (
    `${path} (HTTP ${res.status}): the server answered with something that is not ` +
    "JSON. An unregistered path is served the web app's own index.html with status " +
    "200, so the request looks fine right up until someone reads it. Three causes, " +
    "in the order they can be checked: no dev-proxy entry for this path prefix (add it to PROXY_PATHS in vite.config.ts), " +
    "the running API server predates the route (restart it), " +
    "or the browser is replaying a cached copy of that page (hard-reload with Ctrl+Shift+R). " +
    `Got ${contentTypeOf(res)}.`
  );
}

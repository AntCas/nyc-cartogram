const PATH_PREFIX = "/nyc";
const DIAGNOSTIC_HEADER = "x-nyc-cartogram-worker";

function withoutPrefix(pathname) {
  if (pathname === PATH_PREFIX || pathname === `${PATH_PREFIX}/`) return "/";
  if (pathname.startsWith(`${PATH_PREFIX}/`)) {
    return pathname.slice(PATH_PREFIX.length);
  }
  return null;
}

function withDiagnosticHeader(response) {
  const headers = new Headers(response.headers);
  headers.set(DIAGNOSTIC_HEADER, "1");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function rewriteAssetRedirect(requestUrl, response) {
  const location = response.headers.get("location");
  if (!location) return response;

  const resolved = new URL(location, requestUrl);
  if (resolved.origin !== requestUrl.origin) return response;
  if (!resolved.pathname.startsWith("/")) return response;
  if (resolved.pathname.startsWith(PATH_PREFIX)) return response;

  const headers = new Headers(response.headers);
  headers.set("location", `${PATH_PREFIX}${resolved.pathname}${resolved.search}`);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const rewrittenPath = withoutPrefix(url.pathname);

    if (rewrittenPath === null) {
      return withDiagnosticHeader(new Response("Not found", { status: 404 }));
    }

    url.pathname = rewrittenPath === "/" || rewrittenPath.startsWith("/@") ? "/" : rewrittenPath;
    const assetRequest = new Request(url.toString(), request);
    const assetResponse = await env.ASSETS.fetch(assetRequest);
    return withDiagnosticHeader(rewriteAssetRedirect(url, assetResponse));
  },
};

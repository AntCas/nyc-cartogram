const PATH_PREFIX = "/nyc";

function withoutPrefix(pathname) {
  if (pathname === PATH_PREFIX) return "/";
  if (pathname.startsWith(`${PATH_PREFIX}/`)) {
    return pathname.slice(PATH_PREFIX.length);
  }
  return null;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === PATH_PREFIX) {
      url.pathname = `${PATH_PREFIX}/`;
      return Response.redirect(url.toString(), 308);
    }

    const rewrittenPath = withoutPrefix(url.pathname);

    if (rewrittenPath === null) {
      return new Response("Not found", { status: 404 });
    }

    url.pathname = rewrittenPath === "/" || rewrittenPath.startsWith("/@") ? "/index.html" : rewrittenPath;
    const assetRequest = new Request(url.toString(), request);
    return env.ASSETS.fetch(assetRequest);
  },
};

/** Fills in the actual bound port when a Public URL override omits one (e.g. the user typed
 *  "http://192.168.1.42" instead of "http://192.168.1.42:8787") - otherwise the resulting invite
 *  links/lanUrl silently default to port 80, which the relay never listens on. Rebuilds from the
 *  parsed origin only (protocol + host), discarding any path/query the user might have typed by
 *  mistake, rather than using URL#toString()'s normalization - that appends a trailing slash which
 *  would double up with the leading "/" every caller already prepends to request paths. Returns
 *  the input unchanged if it doesn't parse as a URL at all, so an actually-malformed override still
 *  surfaces as a connection failure rather than being silently "fixed" into something wrong. */
export function withPort(urlString: string, port: number): string {
  let url: URL;
  try {
    url = new URL(urlString);
  } catch {
    return urlString;
  }
  if (!url.port) {
    url.port = String(port);
  }
  return `${url.protocol}//${url.host}`;
}

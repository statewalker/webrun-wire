export interface SplitServiceUrl {
  url: string;
  key: string;
  baseUrl: string;
  path: string;
  [extra: string]: unknown;
}

/**
 * Splits a URL of the form `<base>/<separator><key>/<path>` into parts.
 * Example: `https://host/~FS/a/b` → `{ baseUrl: "https://host/~FS/", key: "FS", path: "a/b" }`.
 */
export function splitServiceUrl(url: URL | string, separator = "~"): SplitServiceUrl {
  const str = `${url}`;
  const empty = { url: str, key: "", baseUrl: "", path: "" };

  // ANCHORED TO THE PATHNAME, AND TO A SEGMENT BOUNDARY. This used to be
  // `str.indexOf(separator)` over the whole URL, so `/index.html?q=~foo` named
  // a service `foo` and a file called `a~b` named a service `b`. Harmless
  // while every service lived under `/~key/`; wrong the moment a host mounts a
  // service at the origin root and owns ordinary paths.
  let pathname: string;
  let origin: string;
  try {
    const parsed = new URL(str, "http://relay.invalid");
    pathname = parsed.pathname;
    origin = str.startsWith(parsed.origin) ? parsed.origin : "";
  } catch {
    return empty;
  }

  if (!pathname.startsWith(`/${separator}`)) return empty;
  const rest = pathname.slice(separator.length + 1);
  const slash = rest.indexOf("/");
  const key = slash < 0 ? rest : rest.slice(0, slash);
  if (key === "") return empty;

  const baseUrl = `${origin}/${separator}${key}${slash < 0 ? "" : "/"}`;
  const path = slash < 0 ? "" : rest.slice(slash + 1);
  return { url: str, key, baseUrl, path };
}

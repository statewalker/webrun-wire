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

  // Strip query and fragment to prevent false positives on `?q=~foo` or `#~FS`.
  // Extract the prefix (origin) and path from the input verbatim, preserving case
  // and form (e.g., `//host` vs. `http://host`, `HTTPS://` vs. `https://`).
  const hashIdx = str.indexOf("#");
  const queryIdx = str.indexOf("?");
  let strippedEnd = str.length;
  if (hashIdx >= 0) strippedEnd = Math.min(strippedEnd, hashIdx);
  if (queryIdx >= 0) strippedEnd = Math.min(strippedEnd, queryIdx);
  const stripped = str.slice(0, strippedEnd);

  // Identify where the path begins in the input. Three cases:
  // 1. scheme://authority/path — prefix is scheme://authority
  // 2. //authority/path — prefix is //authority
  // 3. relative path — prefix is empty
  let prefixEnd = 0;
  const schemeMatch = stripped.match(/^[a-zA-Z][a-zA-Z0-9+\-.]*:\/\//);
  if (schemeMatch) {
    // scheme://authority/path — find the next / after the scheme
    prefixEnd = schemeMatch[0].length;
    const slashIdx = stripped.indexOf("/", prefixEnd);
    if (slashIdx >= 0) {
      prefixEnd = slashIdx;
    } else {
      return empty; // No path
    }
  } else if (stripped.startsWith("//")) {
    // //authority/path — find the next / after the //
    prefixEnd = 2;
    const slashIdx = stripped.indexOf("/", prefixEnd);
    if (slashIdx >= 0) {
      prefixEnd = slashIdx;
    } else {
      return empty; // No path
    }
  }
  // else prefixEnd = 0: relative URL

  const prefix = stripped.slice(0, prefixEnd);
  const pathPart = stripped.slice(prefixEnd);

  // Check if pathPart starts with the separator, anchored at the segment boundary.
  // With an authority the path always begins with `/`, so the separator must be
  // at `/<separator>`. Without one the input is either ROOT-RELATIVE
  // (`/~FS/a/b` -- `location.pathname`, or any root-absolute href) or plain
  // relative (`~FS/a/b`), and both are accepted: treating "no authority" as
  // "relative" made every root-relative caller get nothing back.
  let keyStart: number;
  let rooted = false;
  if (prefix === "") {
    if (pathPart.startsWith(`/${separator}`)) {
      rooted = true;
      keyStart = separator.length + 1;
    } else if (pathPart.startsWith(separator)) {
      keyStart = separator.length;
    } else {
      return empty;
    }
  } else {
    if (!pathPart.startsWith(`/${separator}`)) return empty;
    keyStart = separator.length + 1;
  }

  const rest = pathPart.slice(keyStart);
  const slash = rest.indexOf("/");
  const key = slash < 0 ? rest : rest.slice(0, slash);
  if (key === "") return empty;

  // The base keeps the input's own form: `https://host/~FS/`, `//host/~FS/`,
  // `/~FS/` and `~FS/` each round-trip as written.
  const base = prefix === "" ? (rooted ? "/" : "") : `${prefix}/`;
  const baseUrl = `${base}${separator}${key}${slash < 0 ? "" : "/"}`;
  const path = slash < 0 ? "" : rest.slice(slash + 1);
  return { url: str, key, baseUrl, path };
}

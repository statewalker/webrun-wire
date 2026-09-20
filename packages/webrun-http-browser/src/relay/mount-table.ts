/**
 * Which registered service owns a URL.
 *
 * A pure lookup: no ServiceWorker, no storage, no I/O, so the routing rules
 * can be tested as arithmetic rather than through a browser.
 *
 * TWO KINDS OF MOUNT, AND WHY BOTH. A `path` is a prefix, which is all most
 * hosts need and costs nothing to match. A `match` predicate is the escape
 * hatch for anything richer -- a host that wants URLPattern brings it and pays
 * for it; this file must stay dependency-free, because it runs in a
 * ServiceWorker that has to start fast.
 *
 * SPECIFICITY, NOT REGISTRATION ORDER. Prefixes are tried longest-first, so a
 * catch-all at "/" cannot swallow "/peers/" and a host need not register in a
 * careful order. Predicates are opaque -- nothing can be said about how
 * specific they are -- so they are tried after every prefix, in the order they
 * were registered.
 */

export interface MountSpec {
  /** A path prefix, e.g. `/peers/`. `/` is the whole origin. */
  path?: string;
  /** Anything richer. Consulted only when no prefix matches. */
  match?: (url: URL) => boolean;
}

export interface MountTable {
  /** Add or replace the mount for `key`. */
  set(key: string, spec: MountSpec): void;
  remove(key: string): void;
  /** The key that owns `url`, or `undefined` — meaning "not the relay's". */
  find(url: URL): string | undefined;
  /**
   * Is `url` reserved by `exclude`? `find` already applies it, but the relay
   * has a SECOND route — the `/~<key>/` spelling, which does not go through
   * the table at all — and "an excluded path is never claimed" has to hold
   * for both. The predicate lives here so there is one copy of it.
   */
  excludes(url: URL): boolean;
}

export interface MountTableOptions {
  /**
   * Paths the relay never claims, checked BEFORE the table. A root mount
   * matches every path, so a host with files of its own (a relay page, a
   * worker, hashed assets) is unusable without this.
   */
  exclude?: (url: URL) => boolean;
}

interface Entry {
  key: string;
  /** `""` for a predicate-only mount; otherwise `/` or `/a/b/`. */
  prefix: string;
  match?: (url: URL) => boolean;
  /** Registration order, to break ties between predicates. */
  seq: number;
}

/** `/` stays `/`; `/peers` and `/peers/` both become `/peers/`. */
function normalise(path: string): string {
  if (path === "" || path === "/") return "/";
  const withSlash = path.startsWith("/") ? path : `/${path}`;
  return withSlash.endsWith("/") ? withSlash : `${withSlash}/`;
}

/** Does `prefix` own `pathname`? `/peers/` owns `/peers/`, `/peers` and `/peers/x`. */
function owns(prefix: string, pathname: string): boolean {
  if (prefix === "/") return true;
  if (pathname.startsWith(prefix)) return true;
  return `${pathname}/` === prefix;
}

export function newMountTable(options: MountTableOptions = {}): MountTable {
  const entries = new Map<string, Entry>();
  let seq = 0;

  return {
    set(key, spec) {
      entries.set(key, {
        key,
        prefix: spec.path == null ? "" : normalise(spec.path),
        match: spec.match,
        seq: seq++,
      });
    },

    remove(key) {
      entries.delete(key);
    },

    excludes(url) {
      return options.exclude?.(url) === true;
    },

    find(url) {
      if (options.exclude?.(url) === true) return undefined;

      let best: Entry | undefined;
      for (const entry of entries.values()) {
        if (entry.prefix === "" || !owns(entry.prefix, url.pathname)) continue;
        if (best == null || entry.prefix.length > best.prefix.length) best = entry;
      }
      if (best != null) return best.key;

      const predicates = [...entries.values()]
        .filter((entry) => entry.match != null)
        .sort((a, b) => a.seq - b.seq);
      for (const entry of predicates) {
        if (entry.match?.(url) === true) return entry.key;
      }
      return undefined;
    },
  };
}

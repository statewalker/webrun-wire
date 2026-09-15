---
"@statewalker/webrun-biscuit": patch
---

The parser accepts exactly the names and arities the reference does, and the package
ships its LICENSE.

- **Names are `[A-Za-z0-9_:]+`, ASCII, any character first** — for predicates and
  variables alike. `_m(true)`, `1a(1)` and `$_x` now parse, as they do in the
  reference; `ärger(1)` and `$ x` no longer do. Measured against
  `@biscuit-auth/biscuit-wasm`, which is re-asked for every recorded case and for
  generated names in the cross-reference suite.
- **A predicate takes at least one term.** `f()` was accepted; the reference rejects it.
- **`LICENSE` is in the package.** 0.2.0 was published without it, because the file
  lived only at the repository root.

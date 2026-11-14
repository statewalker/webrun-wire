---
"@statewalker/webrun-msgpack": minor
---

Extension values: the ext type is read as a signed int8, as the spec defines it (type `-2` no longer reads as `254`), and `MsgpackExtension` is now a class exported as a value that `serialize` writes back as an ext, so extension values round-trip. A plain `{ type, data }` object is still written as a map.

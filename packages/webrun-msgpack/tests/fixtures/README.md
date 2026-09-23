# Test fixtures from other MessagePack implementations

Vendored verbatim; each directory carries its source's license. None of this is published — the
package's `files` list ships `dist` and `src` only.

| Directory | Source | Commit | License |
| --- | --- | --- | --- |
| [`msgpack-test-suite/`](./msgpack-test-suite) | [kawanet/msgpack-test-suite](https://github.com/kawanet/msgpack-test-suite) `dist/msgpack-test-suite.json` — a language-neutral set of values, each with every MessagePack encoding a conforming implementation may produce or must accept | `e04f6edeaae589c768d6b70fcce80aa786b7800e` | MIT, © 2017-2018 Yusuke Kawasaki |
| [`msgpackr/`](./msgpackr) | [kriszyp/msgpackr](https://github.com/kriszyp/msgpackr) `tests/example*.json` — the sample documents its round-trip tests use | `a9b9f1aa062461b333b48e66288da00e89ca8035` | MIT, © 2020 Kris Zyp |

The tests that read them are `tests/msgpack-core.test-suite.test.ts` and
`tests/msgpack-core.adopted.test.ts`; the second also ports individual cases from msgpackr and from
[msgpack/msgpack-javascript](https://github.com/msgpack/msgpack-javascript) (ISC, © 2019 The
MessagePack Community), attributed case by case in its comments.

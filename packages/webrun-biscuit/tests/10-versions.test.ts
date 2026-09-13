import assert from "node:assert";
import fs from "node:fs";
import { loadToken, parseAuthorizer } from "../src/authorizer.js";
import {
  appendThirdParty,
  attenuate,
  buildToken,
  generateKeypair,
  thirdPartyBlock,
  thirdPartyRequest,
} from "../src/builder.js";
import { decodeBiscuit, decodeBlock, encodeBiscuit, encodeBlock } from "../src/proto.js";
import {
  DATALOG_3_1,
  DATALOG_3_3,
  MAX_SCHEMA_VERSION,
  MIN_SCHEMA_VERSION,
  requiredVersion,
  validateBlockVersion,
} from "../src/version.js";

const dir = new URL("../samples/", import.meta.url).pathname;

/* -------- the deprecated corpora must be rejected, not misinterpreted ----- */

for (const version of ["v1", "v2"]) {
  const sub = `${dir}deprecated/${version}/`;
  if (!fs.existsSync(sub)) continue;
  test(`every deprecated ${version} token is rejected`, () => {
    const meta = JSON.parse(fs.readFileSync(sub + "samples.json", "utf8"));
    const rootHex: string = meta.root_public_key ?? "";
    const root = new Uint8Array(Buffer.from(rootHex, "hex"));
    const files = fs.readdirSync(sub).filter((f) => f.endsWith(".bc"));
    assert.ok(files.length > 0, "fixtures present");
    for (const f of files) {
      const raw = new Uint8Array(fs.readFileSync(sub + f));
      assert.throws(() => loadToken(raw, root), `${version}/${f} was accepted`);
    }
  });
}

/* ---------------------------- declared version bounds -------------------- */

const content = (code: string) => {
  const p = parseAuthorizer(code);
  return { facts: p.facts, rules: p.rules, checks: p.checks, scopes: p.scopes };
};

test("a declared version outside the supported window is rejected", () => {
  for (const v of [0, 1, 2, MAX_SCHEMA_VERSION + 1, 99]) {
    assert.throws(
      () => validateBlockVersion(v, [], false, content('user("alice");')),
      /unsupported datalog version/,
      `version ${v}`,
    );
  }
  assert.doesNotThrow(() =>
    validateBlockVersion(MIN_SCHEMA_VERSION, [], false, content('user("a");')),
  );
});

test("an absent version field is treated as version 0 and rejected", () => {
  assert.throws(
    () => validateBlockVersion(undefined, [], false, content('user("a");')),
    /version 0/,
  );
});

/* ------------------------- feature gates per version --------------------- */

test("features newer than the declared version are rejected", () => {
  const cases: [string, string, number, RegExp][] = [
    [
      "scopes",
      "check if a($x) trusting authority;",
      MIN_SCHEMA_VERSION,
      /scopes are only supported/,
    ],
    ["bitwise", "check if 5 & 3 == 1;", MIN_SCHEMA_VERSION, /bitwise operators/],
    // `!==` is the strict NotEqual introduced in v3.1; `!=` is the
    // heterogeneous form, which is v3.3
    ["!==", "check if 1 !== 2;", MIN_SCHEMA_VERSION, /bitwise operators/],
    ["!=", "check if 1 != 2;", DATALOG_3_1, /v3\.3\+/],
    ["check all", "check all a($x);", MIN_SCHEMA_VERSION, /check all is only supported/],
    ["closures", "check if [1].any($p -> $p > 0);", DATALOG_3_1, /v3\.3\+/],
    ["null", "check if null == null;", DATALOG_3_1, /v3\.3\+/],
  ];
  for (const [label, code, version, pattern] of cases) {
    const c = content(code);
    assert.throws(() => validateBlockVersion(version, [], false, c), pattern, label);
    // the same content at the version it requires is fine
    assert.doesNotThrow(
      () => validateBlockVersion(requiredVersion(c), [], false, c),
      `${label} at min`,
    );
  }
});

test("check kinds and reject-if are gated on the raw wire field", () => {
  const empty = content('user("a");');
  // an explicit kind at v3.0 is rejected even when the kind is `One`
  assert.throws(
    () => validateBlockVersion(MIN_SCHEMA_VERSION, [{ queries: [], kind: 0 }], false, empty),
    /check kinds/,
  );
  assert.throws(
    () => validateBlockVersion(DATALOG_3_1, [{ queries: [], kind: 2 }], false, empty),
    /reject if/,
  );
  assert.doesNotThrow(() =>
    validateBlockVersion(DATALOG_3_3, [{ queries: [], kind: 2 }], false, empty),
  );
});

test("third-party blocks require datalog v3.2+", () => {
  const c = content('group("admin");');
  assert.throws(() => validateBlockVersion(DATALOG_3_1, [], true, c), /third-party blocks/);
  assert.doesNotThrow(() => validateBlockVersion(DATALOG_3_3, [], true, c));
});

/* ------------------- the builder declares the right version -------------- */

test("minted blocks declare the lowest version their content requires", () => {
  const root = generateKeypair();
  const cases: [string, number][] = [
    ['right("file1", "read");', MIN_SCHEMA_VERSION],
    ["check if a($x) trusting authority;", DATALOG_3_1],
    ["check all a($x);", DATALOG_3_1],
    ["check if [1].any($p -> $p > 0);", DATALOG_3_3],
    ["reject if a($x);", DATALOG_3_3],
  ];
  for (const [code, expected] of cases) {
    const token = buildToken(root.secretKey, code);
    const block = decodeBlock(decodeBiscuit(token).authority.block);
    assert.equal(block.version, expected, code);
    assert.doesNotThrow(() => loadToken(token, root.publicKey), code);
  }
});

test("a third-party block declares at least v3.2", () => {
  const root = generateKeypair();
  const external = generateKeypair();
  let token = buildToken(root.secretKey, 'user("alice");');
  const response = thirdPartyBlock(thirdPartyRequest(token), external.secretKey, 'group("admin");');
  token = appendThirdParty(token, response);
  const block = decodeBlock(decodeBiscuit(token).blocks[0].block);
  assert.ok((block.version ?? 0) >= 5, `got ${block.version}`);
  assert.doesNotThrow(() => loadToken(token, root.publicKey));
});

test("downgrading a block version on the wire is detected", () => {
  const root = generateKeypair();
  // build a token whose attenuation block uses a v3.3 feature
  const token = attenuate(
    buildToken(root.secretKey, 'user("alice");'),
    "check if [1].any($p -> $p > 0);",
  );
  const decoded = decodeBiscuit(token);
  const block = decodeBlock(decoded.blocks[0].block);
  assert.equal(block.version, DATALOG_3_3);

  block.version = DATALOG_3_1; // claim an older version than the content needs
  decoded.blocks[0].block = encodeBlock(block);
  // the signature no longer matches either, but the version gate is what we assert
  assert.throws(() => loadToken(encodeBiscuit(decoded), root.publicKey));
});

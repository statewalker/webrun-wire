import assert from "node:assert";
import fs from "node:fs";
import { type AuthorizationResult, authorize, loadToken } from "../src/authorizer.js";
import {
  appendThirdParty,
  attenuate,
  buildToken,
  generateKeypair,
  sealToken,
  thirdPartyBlock,
  thirdPartyRequest,
} from "../src/builder.js";
import { decodeBiscuit, encodeBiscuit } from "../src/proto.js";

const dir = new URL("../samples/", import.meta.url).pathname;
const samples = JSON.parse(fs.readFileSync(dir + "samples.json", "utf8"));

test("a minted token verifies and authorizes", () => {
  const root = generateKeypair();
  const token = buildToken(root.secretKey, 'right("file1", "read");');
  const loaded = loadToken(token, root.publicKey);
  assert.deepEqual(authorize(loaded, 'allow if right("file1", "read");'), {
    kind: "ok",
    policy: 0,
  });
});

test("a token minted with one root key does not verify with another", () => {
  const root = generateKeypair();
  const other = generateKeypair();
  const token = buildToken(root.secretKey, 'right("file1", "read");');
  assert.throws(() => loadToken(token, other.publicKey));
});

test("attenuation adds a block and only ever narrows access", () => {
  const root = generateKeypair();
  let token = buildToken(root.secretKey, 'right("file1", "read");\nright("file2", "read");');
  token = attenuate(token, 'check if resource("file1");');

  assert.equal(decodeBiscuit(token).blocks.length, 1);
  const loaded = loadToken(token, root.publicKey);
  assert.deepEqual(authorize(loaded, 'resource("file1");\nallow if true;'), {
    kind: "ok",
    policy: 0,
  });

  const denied = authorize(loaded, 'resource("file2");\nallow if true;');
  assert.equal(denied.kind, "unauthorized");
  assert.deepEqual((denied as any).checks, [{ source: "block", blockId: 1, checkId: 0 }]);
});

test("attenuation chains, and every block keeps its own symbols", () => {
  const root = generateKeypair();
  let token = buildToken(root.secretKey, 'user("alice");');
  token = attenuate(token, 'check if user("alice");');
  token = attenuate(token, 'check if operation("read");');
  const loaded = loadToken(token, root.publicKey);
  assert.equal(loaded.blocks.length, 3);
  assert.deepEqual(authorize(loaded, 'operation("read");\nallow if true;'), {
    kind: "ok",
    policy: 0,
  });
});

test("sealing prevents further attenuation but keeps the token valid", () => {
  const root = generateKeypair();
  const token = sealToken(
    attenuate(buildToken(root.secretKey, 'user("bob");'), 'check if user("bob");'),
  );
  const loaded = loadToken(token, root.publicKey);
  assert.deepEqual(authorize(loaded, 'allow if user("bob");'), { kind: "ok", policy: 0 });
  assert.throws(() => attenuate(token, "check if true;"), /sealed/);
});

test("tampering with a sealed token is detected", () => {
  const root = generateKeypair();
  const token = sealToken(buildToken(root.secretKey, 'user("bob");'));
  const tampered = decodeBiscuit(token);
  tampered.authority.block[tampered.authority.block.length - 1] ^= 0xff;
  assert.throws(() => loadToken(token.slice(), root.publicKey) && loadToken(token, root.publicKey));
});

test("third-party blocks are signed without holding the token", () => {
  const root = generateKeypair();
  const external = generateKeypair();
  const hex = Array.from(external.publicKey, (x) => x.toString(16).padStart(2, "0")).join("");

  let token = buildToken(root.secretKey, `check if group("admin") trusting ed25519/${hex};`);
  const request = thirdPartyRequest(token);
  const response = thirdPartyBlock(request, external.secretKey, 'group("admin");');
  token = appendThirdParty(token, response);

  const loaded = loadToken(token, root.publicKey);
  assert.equal(loaded.blocks[1].externalKey, `ed25519/${hex}`);
  assert.deepEqual(authorize(loaded, "allow if true;"), { kind: "ok", policy: 0 });
});

test("a third-party fact is not trusted without the trusting annotation", () => {
  const root = generateKeypair();
  const external = generateKeypair();
  let token = buildToken(root.secretKey, 'check if group("admin");');
  const response = thirdPartyBlock(thirdPartyRequest(token), external.secretKey, 'group("admin");');
  token = appendThirdParty(token, response);
  const result = authorize(loadToken(token, root.publicKey), "allow if true;");
  assert.equal(result.kind, "unauthorized");
});

/* ----------------------------------------------- the corpus, backwards ---- */

/** rebuild each first-party sample from its Datalog source and re-authorize it */
const rebuildable = samples.testcases.filter(
  (tc: any) =>
    tc.token.every((b: any) => b.external_key === null) &&
    Object.values<any>(tc.validations).every((v) => {
      const r = v.result;
      return "Ok" in r || ("Err" in r && "FailedLogic" in r.Err);
    }),
);

test("the sample corpus can be rebuilt from source and gives the same answers", () => {
  assert.ok(rebuildable.length >= 20, `expected a broad corpus, got ${rebuildable.length}`);
  const externs = new Map([
    [
      "test",
      (left: any, right?: any) =>
        right === undefined
          ? left
          : { t: "str", v: left.v === right.v ? "equal strings" : "different strings" },
    ],
  ]) as any;
  for (const tc of rebuildable) {
    const root = generateKeypair();
    let token: Uint8Array;
    try {
      token = buildToken(root.secretKey, tc.token[0].code);
      for (const block of tc.token.slice(1)) token = attenuate(token, block.code);
    } catch (e) {
      assert.fail(`${tc.filename}: rebuild failed: ${(e as Error).message}`);
    }

    const loaded = loadToken(token, root.publicKey);
    for (const [, validation] of Object.entries<any>(tc.validations)) {
      const got: AuthorizationResult = authorize(loaded, validation.authorizer_code, { externs });
      const want = validation.result;
      if ("Ok" in want) {
        assert.deepEqual(got, { kind: "ok", policy: want.Ok }, `${tc.filename}`);
      } else if ("FailedLogic" in want.Err && "Unauthorized" in want.Err.FailedLogic) {
        assert.equal(got.kind, "unauthorized", `${tc.filename}`);
        assert.deepEqual(
          (got as any).checks,
          want.Err.FailedLogic.Unauthorized.checks.map((c: any) =>
            "Block" in c
              ? { source: "block", blockId: c.Block.block_id, checkId: c.Block.check_id }
              : { source: "authorizer", checkId: c.Authorizer.check_id },
          ),
          `${tc.filename} failed checks`,
        );
      } else if ("FailedLogic" in want.Err && "NoMatchingPolicy" in want.Err.FailedLogic) {
        assert.equal(got.kind, "noMatchingPolicy", `${tc.filename}`);
      }
    }
  }
});

test("a forged seal signature is rejected", () => {
  const root = generateKeypair();
  const sealed = sealToken(buildToken(root.secretKey, 'user("gwen");'));

  // the seal is the only thing binding a sealed token; corrupting it must be
  // detected, otherwise anyone could present a token as sealed
  const decoded = decodeBiscuit(sealed);
  assert.equal(decoded.proof.kind, "finalSignature");
  const forged = decoded.proof.value.slice();
  forged[0] ^= 0xff;
  const tampered = encodeBiscuit({ ...decoded, proof: { kind: "finalSignature", value: forged } });
  assert.throws(() => loadToken(tampered, root.publicKey), /seal/i);

  // and a sealed token may not be downgraded back to an attenuable one by
  // swapping the proof for an unrelated secret key
  const other = generateKeypair();
  const downgraded = encodeBiscuit({
    ...decoded,
    proof: { kind: "nextSecret", value: other.secretKey },
  });
  assert.throws(() => loadToken(downgraded, root.publicKey));
});

test("a matching deny policy refuses the request", () => {
  const root = generateKeypair();
  const token = buildToken(root.secretKey, 'user("heidi");');
  const loaded = loadToken(token, root.publicKey);

  // deny comes first, so it wins even though the allow below it would match
  const denied = authorize(
    loaded,
    'banned("heidi");\ndeny if banned($u), user($u);\nallow if true;',
  );
  assert.equal(denied.kind, "unauthorized");
  assert.deepEqual((denied as any).policy, { deny: 0 });

  // the same program without the banned fact reaches the allow
  assert.deepEqual(authorize(loaded, "deny if banned($u), user($u);\nallow if true;"), {
    kind: "ok",
    policy: 1,
  });
});

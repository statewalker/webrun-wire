/**
 * The token shapes exercised in both directions. Each case is minted by one
 * implementation and authorized by the other.
 *
 * `feature` marks cases that need a Datalog version the pinned reference build
 * may predate; those are skipped rather than failed, and reported.
 */
export interface CrossCase {
  name: string;
  authority: string;
  blocks?: string[];
  authorizer: string;
  seal?: boolean;
  expect: "ok" | "unauthorized" | "noMatchingPolicy";
  feature?: "v3.3";
}

export const CASES: CrossCase[] = [
  {
    name: "basic",
    authority: 'right("file1", "read");',
    authorizer: 'allow if right("file1", "read");',
    expect: "ok",
  },
  {
    name: "attenuated-allowed",
    authority: 'right("file1", "read");\nright("file2", "read");',
    blocks: ['check if resource("file1");'],
    authorizer: 'resource("file1");\nallow if true;',
    expect: "ok",
  },
  {
    name: "attenuated-denied",
    authority: 'right("file1", "read");\nright("file2", "read");',
    blocks: ['check if resource("file1");'],
    authorizer: 'resource("file2");\nallow if true;',
    expect: "unauthorized",
  },
  {
    name: "rule-derivation",
    authority:
      'user_id("alice");\nowner("alice", "file1");\nright($f, "read") <- owner($u, $f), user_id($u);',
    authorizer: 'allow if right("file1", "read");',
    expect: "ok",
  },
  {
    // a rule in an attenuation block may read authority facts, but the fact it
    // derives carries origin {0,1} — which the authorizer does not trust by
    // default. An attenuation block therefore cannot grant rights, even
    // indirectly through a rule. Both implementations agree on this.
    name: "scoped-rule-cannot-grant",
    authority: 'user_id("alice");\nowner("alice", "file1");',
    blocks: ['right($f, "read") <- owner($u, $f), user_id($u) trusting authority;'],
    authorizer: 'allow if right("file1", "read");',
    expect: "noMatchingPolicy",
  },
  {
    // the same property for plain facts: a block cannot satisfy an authority
    // check by asserting the fact the check looks for
    name: "block-facts-are-not-trusted",
    authority: 'check if right("file1", "read");',
    blocks: ['right("file1", "read");'],
    authorizer: "allow if true;",
    expect: "unauthorized",
  },
  {
    name: "sealed",
    authority: 'user("bob");',
    blocks: ['check if user("bob");'],
    authorizer: 'allow if user("bob");',
    seal: true,
    expect: "ok",
  },
  {
    name: "expressions",
    authority: 'value(3);\nname("hello world");',
    authorizer:
      'allow if value($v), $v > 2, $v < 10, name($n), $n.starts_with("hello"), $n.length() == 11;',
    expect: "ok",
  },
  {
    name: "sets-and-dates",
    authority: 'tags({"a", "b", "c"});\nexpiry(2030-01-01T00:00:00Z);',
    authorizer: 'allow if tags($t), $t.contains("b"), expiry($e), $e > 2020-01-01T00:00:00Z;',
    expect: "ok",
  },
  {
    name: "bytes-and-bitwise",
    authority: "digest(hex:0011ff);\nflags(6);",
    authorizer: "allow if digest(hex:0011ff), flags($f), $f & 2 == 2;",
    expect: "ok",
  },
  {
    name: "regex",
    authority: 'path("/a/b/c.txt");',
    authorizer: 'allow if path($p), $p.matches("^/a/.*\\\\.txt$");',
    expect: "ok",
  },
  {
    name: "multi-block",
    authority: 'user("dave");',
    blocks: ['check if user("dave");', 'check if operation("read");'],
    authorizer: 'operation("read");\nallow if true;',
    expect: "ok",
  },
  {
    name: "deny-policy",
    authority: 'user("eve");',
    authorizer: 'banned("eve");\ndeny if banned("eve");\nallow if true;',
    expect: "unauthorized",
  },
  {
    name: "no-matching-policy",
    authority: 'user("frank");',
    authorizer: 'allow if user("nobody");',
    expect: "noMatchingPolicy",
  },
  {
    name: "check-all",
    authority: 'path("/a/x");\npath("/a/y");',
    blocks: ['check all path($p), $p.starts_with("/a/");'],
    authorizer: "allow if true;",
    expect: "ok",
  },
  {
    name: "closures",
    authority: "scores([1, 2, 3]);",
    authorizer: "allow if scores($s), $s.all($x -> $x > 0);",
    expect: "ok",
    feature: "v3.3",
  },
  {
    name: "maps",
    authority: 'meta({"k": "v"});',
    authorizer: 'allow if meta($m), $m.get("k") == "v";',
    expect: "ok",
    feature: "v3.3",
  },
  {
    name: "reject-if",
    authority: 'user("carol");',
    blocks: ['reject if banned("carol");'],
    authorizer: 'allow if user("carol");',
    expect: "ok",
    feature: "v3.3",
  },
];

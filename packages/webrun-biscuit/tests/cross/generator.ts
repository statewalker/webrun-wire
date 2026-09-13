/**
 * Random Biscuit program generator for differential testing.
 *
 * Programs are built around a chosen (resource, operation, user) scenario and
 * then perturbed, rather than sampled uniformly. Uniform sampling produces
 * mostly `noMatchingPolicy` — programs where nothing lines up and the engine
 * barely runs. Anchoring on a scenario and deviating from it deliberately puts
 * the generator where the interesting behaviour is: checks that nearly pass,
 * rules that nearly fire, policies that nearly match.
 */

export interface Random {
  int: (n: number) => number;
  pick: <T>(xs: readonly T[]) => T;
  chance: (p: number) => boolean;
}

/** xorshift32 — deterministic, so any failure is reproducible from its seed */
export function rng(seed: number): Random {
  let s = seed >>> 0 || 1;
  const next = () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
  return {
    int: (n) => Math.floor(next() * n),
    pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)],
    chance: (p) => next() < p,
  };
}

const RESOURCES = ["file1", "file2", "/a/x", "/b/z"] as const;
const OPERATIONS = ["read", "write", "delete"] as const;
const USERS = ["alice", "bob", "carol"] as const;
const GROUPS = ["admin", "staff", "guest"] as const;

export interface Program {
  authority: string;
  blocks: string[];
  authorizer: string;
  seal: boolean;
  /** true when the program uses Datalog 3.3 syntax */
  v33: boolean;
}

export function randomProgram(r: Random): Program {
  // the scenario the program is built around; each use may deviate from it
  const resource = r.pick(RESOURCES);
  const operation = r.pick(OPERATIONS);
  const user = r.pick(USERS);
  const group = r.pick(GROUPS);
  const level = r.int(10);
  const other = <T>(xs: readonly T[], v: T): T => {
    const rest = xs.filter((x) => x !== v);
    return rest[r.int(rest.length)];
  };
  /** the scenario value most of the time, a different one otherwise */
  const maybe = <T>(xs: readonly T[], v: T, p = 0.75): T => (r.chance(p) ? v : other(xs, v));

  let v33 = false;
  const authority: string[] = [
    `user("${user}");`,
    `group("${group}");`,
    `level(${level});`,
    `right("${resource}", "${operation}");`,
  ];
  if (r.chance(0.5)) authority.push(`right("${other(RESOURCES, resource)}", "${operation}");`);
  if (r.chance(0.4)) authority.push(`owner("${user}", "${resource}");`);

  // a derivation rule: the authorizer can only see what it derives if the rule
  // lives in the authority block
  if (r.chance(0.4)) {
    authority.push(`user_id("${maybe(USERS, user)}");`);
    authority.push(
      `right($f, "${maybe(OPERATIONS, operation)}") <- owner($u, $f), user_id($u)${
        r.chance(0.25) ? " trusting authority" : ""
      };`,
    );
  }
  if (r.chance(0.2)) {
    authority.push(`tags({"${group}", "${other(GROUPS, group)}"});`);
  }
  if (r.chance(0.15)) {
    authority.push(`scores([${r.int(5)}, ${r.int(5) + 5}]);`);
    v33 = true;
  }

  const blocks: string[] = [];
  for (let i = 0, n = r.int(4); i < n; i++) {
    switch (r.int(8)) {
      case 0:
        blocks.push(`check if resource("${maybe(RESOURCES, resource)}");`);
        break;
      case 1:
        blocks.push(`check if operation("${maybe(OPERATIONS, operation)}");`);
        break;
      case 2:
        blocks.push(`check if user("${maybe(USERS, user)}") or group("${maybe(GROUPS, group)}");`);
        break;
      case 3:
        blocks.push(`check if level($l), $l ${r.pick([">=", "<=", ">", "<"])} ${level};`);
        break;
      case 4:
        blocks.push(
          r.chance(0.5)
            ? `check all resource($x), $x.starts_with("${r.pick(["file", "/a/", "/b/"])}");`
            : `check all operation($o), $o != "${r.pick(OPERATIONS)}";`,
        );
        break;
      case 5:
        blocks.push(`check if right($f, $o), resource($f), operation($o);`);
        break;
      case 6:
        blocks.push(`reject if banned("${maybe(USERS, user)}");`);
        v33 = true;
        break;
      default:
        // a block asserting a fact: it must NOT become visible to the
        // authorizer, which trusts only the authority block by default
        blocks.push(
          r.chance(0.5)
            ? `right("${r.pick(RESOURCES)}", "${r.pick(OPERATIONS)}");`
            : `user("${r.pick(USERS)}");`,
        );
    }
  }

  const authorizer: string[] = [];
  // several resource facts, sometimes, so that `check all` has more than one
  // combination to quantify over — otherwise `all` and `if` are the same test
  const resourceCount = r.chance(0.4) ? 2 + r.int(2) : 1;
  const offered = new Set<string>([maybe(RESOURCES, resource, 0.85)]);
  while (offered.size < resourceCount) offered.add(r.pick(RESOURCES));
  for (const value of offered) authorizer.push(`resource("${value}");`);

  authorizer.push(`operation("${maybe(OPERATIONS, operation, 0.85)}");`);
  if (r.chance(0.3)) authorizer.push(`operation("${other(OPERATIONS, operation)}");`);
  if (r.chance(0.5)) authorizer.push(`level(${r.chance(0.7) ? level : r.int(10)});`);
  if (r.chance(0.25)) authorizer.push(`banned("${maybe(USERS, user, 0.5)}");`);
  if (r.chance(0.2)) authorizer.push(`client("mobile");`);

  if (r.chance(0.25)) authorizer.push(`deny if banned($u), user($u);`);
  switch (r.int(6)) {
    case 0:
      authorizer.push("allow if true;");
      break;
    case 1:
      authorizer.push(`allow if user("${maybe(USERS, user, 0.85)}");`);
      break;
    case 2:
      authorizer.push("allow if right($r, $o), resource($r), operation($o);");
      break;
    case 3:
      authorizer.push(`allow if level($l), $l >= ${r.chance(0.7) ? level : r.int(10)};`);
      break;
    case 4:
      authorizer.push(`allow if group($g), $g.length() > ${r.int(6)};`);
      break;
    default:
      authorizer.push(`allow if user($u), $u.starts_with("${user.slice(0, 1 + r.int(3))}");`);
  }

  return {
    authority: authority.join("\n"),
    blocks,
    authorizer: authorizer.join("\n"),
    seal: r.chance(0.2),
    v33,
  };
}

export const describeProgram = (p: Program, seed: number, algorithm: string): string =>
  [
    `seed ${seed} (${algorithm})`,
    "--- authority ---",
    p.authority,
    "--- blocks ---",
    p.blocks.join("\n~~~\n") || "(none)",
    "--- authorizer ---",
    p.authorizer,
    `--- sealed: ${p.seal}`,
  ].join("\n");

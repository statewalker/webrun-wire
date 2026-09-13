//! Cross-reference helper: drives the *reference* Rust implementation so the
//! TypeScript one can be checked against it in both directions.
//!
//!   crossref generate <outdir>              mint tokens, write a manifest
//!   crossref verify <file> <root_hex> <alg> <authorizer_file>
//!
//! Everything is reported as JSON on stdout so the Node test suite can parse it.
//!
//! NOTE: `biscuit-auth` at HEAD requires rustc >= 1.79. This helper is not used
//! by `pnpm test:cross`, which drives the WASM build of the same crate instead
//! and therefore needs no Rust toolchain at all. Kept for anyone who wants a
//! genuinely native binary in the loop.
use biscuit_auth::builder::{Algorithm, AuthorizerBuilder, BlockBuilder};
use biscuit_auth::{Biscuit, KeyPair, PublicKey};
use serde_json::json;
use std::fs;
use std::path::Path;

/// the token shapes we exchange; each is (name, authority code, extra blocks, authorizer, seal)
fn cases() -> Vec<(&'static str, &'static str, Vec<&'static str>, &'static str, bool)> {
    vec![
        ("basic", "right(\"file1\", \"read\");", vec![], "allow if right(\"file1\", \"read\");", false),
        (
            "attenuated",
            "right(\"file1\", \"read\");\nright(\"file2\", \"read\");",
            vec!["check if resource(\"file1\");"],
            "resource(\"file1\");\nallow if true;",
            false,
        ),
        (
            "attenuated_denied",
            "right(\"file1\", \"read\");\nright(\"file2\", \"read\");",
            vec!["check if resource(\"file1\");"],
            "resource(\"file2\");\nallow if true;",
            false,
        ),
        (
            "rule_derivation",
            "user_id(\"alice\");\nowner(\"alice\", \"file1\");\nright($f, \"read\") <- owner($u, $f), user_id($u);",
            vec![],
            "allow if right(\"file1\", \"read\");",
            false,
        ),
        (
            "scoped_rule",
            "user_id(\"alice\");\nowner(\"alice\", \"file1\");",
            vec!["right($f, \"read\") <- owner($u, $f), user_id($u) trusting authority;"],
            "allow if right(\"file1\", \"read\");",
            false,
        ),
        ("sealed", "user(\"bob\");", vec!["check if user(\"bob\");"], "allow if user(\"bob\");", true),
        (
            "expressions",
            "value(3);\nname(\"hello world\");",
            vec![],
            "allow if value($v), $v > 2, $v < 10, name($n), $n.starts_with(\"hello\"), $n.length() == 11;",
            false,
        ),
        (
            "sets_and_dates",
            "tags({\"a\", \"b\", \"c\"});\nexpiry(2030-01-01T00:00:00Z);",
            vec![],
            "allow if tags($t), $t.contains(\"b\"), expiry($e), $e > 2020-01-01T00:00:00Z;",
            false,
        ),
        (
            "check_all",
            "path(\"/a/x\");\npath(\"/a/y\");",
            vec!["check all path($p), $p.starts_with(\"/a/\");"],
            "allow if true;",
            false,
        ),
        (
            "reject_if",
            "user(\"carol\");",
            vec!["reject if banned(\"carol\");"],
            "allow if user(\"carol\");",
            false,
        ),
        (
            "closures_v33",
            "scores([1, 2, 3]);\nmeta({\"k\": \"v\"});",
            vec![],
            "allow if scores($s), $s.all($x -> $x > 0), meta($m), $m.get(\"k\") == \"v\";",
            false,
        ),
        (
            "multi_block",
            "user(\"dave\");",
            vec!["check if user(\"dave\");", "check if operation(\"read\");"],
            "operation(\"read\");\nallow if true;",
            false,
        ),
        (
            "deny_policy",
            "user(\"eve\");",
            vec![],
            "banned(\"eve\");\ndeny if banned(\"eve\");\nallow if true;",
            false,
        ),
        ("no_matching_policy", "user(\"frank\");", vec![], "allow if user(\"nobody\");", false),
    ]
}

fn describe(result: &Result<usize, biscuit_auth::error::Token>) -> serde_json::Value {
    match result {
        Ok(index) => json!({ "kind": "ok", "policy": index }),
        Err(biscuit_auth::error::Token::FailedLogic(logic)) => match logic {
            biscuit_auth::error::Logic::Unauthorized { .. } => json!({ "kind": "unauthorized" }),
            biscuit_auth::error::Logic::NoMatchingPolicy { .. } => json!({ "kind": "noMatchingPolicy" }),
            other => json!({ "kind": "failedLogic", "detail": format!("{:?}", other) }),
        },
        Err(e) => json!({ "kind": "error", "detail": format!("{:?}", e) }),
    }
}

fn generate(outdir: &str) {
    let dir = Path::new(outdir);
    fs::create_dir_all(dir).expect("create outdir");
    let mut manifest = vec![];

    for (name, authority, blocks, authorizer, seal) in cases() {
        for algorithm in [Algorithm::Ed25519, Algorithm::Secp256r1] {
            let suffix = if algorithm == Algorithm::Ed25519 { "ed25519" } else { "secp256r1" };
            let root = KeyPair::new_with_algorithm(algorithm);

            let mut token = Biscuit::builder()
                .code(authority)
                .expect("authority code")
                .build(&root)
                .expect("build");

            for code in &blocks {
                let block = BlockBuilder::new().code(code).expect("block code");
                token = token.append(block).expect("append");
            }
            if seal {
                token = token.seal().expect("seal");
            }

            let bytes = token.to_vec().expect("serialize");
            let filename = format!("{}_{}.bc", name, suffix);
            fs::write(dir.join(&filename), &bytes).expect("write token");

            // what the reference itself decides, so the TS side has a target
            let parsed = Biscuit::from(&bytes, root.public()).expect("reparse");
            let mut auth = AuthorizerBuilder::new()
                .code(authorizer)
                .expect("authorizer code")
                .build(&parsed)
                .expect("authorizer build");
            let outcome = auth.authorize();

            manifest.push(json!({
                "name": format!("{}_{}", name, suffix),
                "file": filename,
                "algorithm": suffix,
                "root_public_key": hex::encode(root.public().to_bytes()),
                "authorizer_code": authorizer,
                "expected": describe(&outcome),
                "base64": token.to_base64().expect("base64"),
                "revocation_ids": parsed
                    .revocation_identifiers()
                    .into_iter()
                    .map(hex::encode)
                    .collect::<Vec<_>>(),
            }));
        }
    }

    let out = json!({ "generator": "biscuit-auth (reference)", "tokens": manifest });
    fs::write(dir.join("manifest.json"), serde_json::to_string_pretty(&out).unwrap())
        .expect("write manifest");
    println!("{}", json!({ "generated": out["tokens"].as_array().unwrap().len() }));
}

fn verify(file: &str, root_hex: &str, algorithm: &str, authorizer_file: &str) {
    let bytes = fs::read(file).expect("read token");
    let alg = if algorithm == "secp256r1" { Algorithm::Secp256r1 } else { Algorithm::Ed25519 };
    let root = match PublicKey::from_bytes(&hex::decode(root_hex).expect("hex"), alg) {
        Ok(k) => k,
        Err(e) => {
            println!("{}", json!({ "kind": "error", "detail": format!("{:?}", e) }));
            return;
        }
    };

    let token = match Biscuit::from(&bytes, root) {
        Ok(t) => t,
        Err(e) => {
            println!("{}", json!({ "kind": "invalidToken", "detail": format!("{:?}", e) }));
            return;
        }
    };

    let code = fs::read_to_string(authorizer_file).expect("read authorizer");
    let builder = match AuthorizerBuilder::new().code(&code) {
        Ok(b) => b,
        Err(e) => {
            println!("{}", json!({ "kind": "error", "detail": format!("{:?}", e) }));
            return;
        }
    };
    let mut auth = match builder.build(&token) {
        Ok(a) => a,
        Err(e) => {
            println!("{}", json!({ "kind": "error", "detail": format!("{:?}", e) }));
            return;
        }
    };
    let outcome = auth.authorize();
    let mut value = describe(&outcome);
    value["revocation_ids"] = json!(token
        .revocation_identifiers()
        .into_iter()
        .map(hex::encode)
        .collect::<Vec<_>>());
    value["block_count"] = json!(token.block_count());
    println!("{}", value);
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("generate") => generate(args.get(2).expect("outdir")),
        Some("verify") => verify(
            args.get(2).expect("token file"),
            args.get(3).expect("root public key hex"),
            args.get(4).expect("algorithm"),
            args.get(5).expect("authorizer file"),
        ),
        _ => {
            eprintln!("usage: crossref generate <outdir> | crossref verify <file> <root_hex> <alg> <authorizer_file>");
            std::process::exit(2);
        }
    }
}

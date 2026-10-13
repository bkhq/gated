use schemars::schema_for;

#[allow(
    clippy::unwrap_used,
    reason = "dev-only bin: fails loudly if the schema can't serialize"
)]
fn main() {
    let schema = schema_for!(gated_common::GatedConfigStore);
    println!("{}", serde_json::to_string_pretty(&schema).unwrap());
}

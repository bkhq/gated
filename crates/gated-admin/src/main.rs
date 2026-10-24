#![forbid(unsafe_code)]

#[allow(
    clippy::unwrap_used,
    reason = "dev-only bin: serializing the document cannot fail"
)]
pub fn main() {
    let version = env!("CARGO_PKG_VERSION");
    let router = if std::env::args().nth(1).as_deref() == Some("user") {
        gated_admin::user_api_router(version)
    } else {
        gated_admin::admin_api_router(version)
    };
    let spec = router.into_openapi().to_pretty_json().unwrap();

    println!("{spec}");
}

use poem_openapi::OpenApiService;
use regex::Regex;

#[allow(
    clippy::unwrap_used,
    reason = "dev-only bin: static regex literal is known-valid"
)]
pub fn main() {
    let spec = if std::env::args().nth(1).as_deref() == Some("user") {
        OpenApiService::new(
            gated_admin::http_service::api::get(),
            "Gated user API",
            env!("CARGO_PKG_VERSION"),
        )
        .server("/api")
        .spec()
    } else {
        OpenApiService::new(
            gated_admin::api::get(),
            "Gated admin API",
            env!("CARGO_PKG_VERSION"),
        )
        .server("/admin/api")
        .spec()
    };
    let re = Regex::new(r"PaginatedResponse<(?P<name>\w+)>").unwrap();
    let spec = re.replace_all(&spec, "Paginated$name");

    println!("{spec}");
}

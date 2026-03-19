use poem_openapi::OpenApiService;
use regex::Regex;
use gated_common::version::gated_version;
use gated_protocol_http::api;

#[allow(clippy::unwrap_used)]
pub fn main() {
    let api_service = OpenApiService::new(api::get(), "Gated HTTP proxy", gated_version())
        .server("/@gated/api");

    let spec = api_service.spec();
    let re = Regex::new(r"PaginatedResponse<(?P<name>\w+)>").unwrap();
    let spec = re.replace_all(&spec, "Paginated$name");

    println!("{spec}");
}

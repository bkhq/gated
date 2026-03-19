mod api;
use poem_openapi::OpenApiService;
use regex::Regex;
use gated_common::version::gated_version;

#[allow(clippy::unwrap_used)]
pub fn main() {
    let api_service = OpenApiService::new(api::get(), "Gated Web Admin", gated_version())
        .server("/@gated/admin/api");

    let spec = api_service.spec();
    let re = Regex::new(r"PaginatedResponse<(?P<name>\w+)>").unwrap();
    let spec = re.replace_all(&spec, "Paginated$name");

    println!("{spec}");
}

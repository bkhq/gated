use poem_openapi::OpenApi;

mod api_tokens;
pub mod auth;
mod common;
mod credentials;
pub(crate) mod db_query;
pub mod encryption;
pub mod info;
mod sessions;
pub mod sso_provider_detail;
pub mod sso_provider_list;
pub mod targets_list;
mod tickets;
// Not part of OpenAPI — WebSocket upgrade is not representable in poem-openapi.
// These endpoints are mounted with raw `#[handler]` in `lib.rs`:
//   /api/ssh/terminal/:target_name
//   /api/mysql/terminal/:target_name
//   /api/postgres/terminal/:target_name
// The read-only session monitor WS is mounted inside `admin_api_app` (lib.rs)
// at `/admin/api/sessions/:id/monitor`, inheriting the admin-only nest gate:
pub(crate) mod db_terminal;
pub(crate) mod session_monitor;
pub(crate) mod sql_validation;
pub(crate) mod ssh_terminal;

pub use gated_common::api::AnySecurityScheme;

pub fn get() -> impl OpenApi {
    (
        auth::Api,
        info::Api,
        targets_list::Api,
        sso_provider_list::Api,
        sso_provider_detail::Api,
        credentials::Api,
        api_tokens::Api,
        tickets::Api,
        sessions::Api,
        db_query::Api,
    )
}

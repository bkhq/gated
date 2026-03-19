use poem_openapi::OpenApi;

mod api_tokens;
pub mod auth;
mod common;
mod credentials;
pub mod info;
pub mod sso_provider_detail;
pub mod sso_provider_list;
// Not part of OpenAPI — uses raw WebSocket handler instead of poem-openapi
pub(crate) mod ssh_terminal;
pub mod targets_list;

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
    )
}

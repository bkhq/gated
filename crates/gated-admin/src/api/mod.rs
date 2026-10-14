use utoipa_axum::router::OpenApiRouter;

mod accounts;
mod api_tokens;
mod certificate_credentials;
pub mod command_acl;
pub mod command_records;
pub mod command_review;
mod known_hosts_detail;
mod known_hosts_list;
mod logs;
mod management_sessions;
mod otp_credentials;
mod pagination;
mod parameters;
mod password_credentials;
mod public_key_credentials;
pub mod recordings_detail;
mod reveal_guard;
mod roles;
mod sessions_detail;
pub mod sessions_list;
mod ssh_connection_test;
mod ssh_keys;
mod sso_credentials;
mod target_groups;
mod targets;
mod tickets_detail;
mod tickets_list;
pub mod users;

pub use gated_common::web::AnySecurityScheme;

pub fn router() -> OpenApiRouter {
    OpenApiRouter::new()
        .merge(sessions_list::router())
        .merge(sessions_detail::router())
        .merge(recordings_detail::router())
        .merge(roles::router())
        .merge(tickets_list::router())
        .merge(tickets_detail::router())
        .merge(known_hosts_list::router())
        .merge(known_hosts_detail::router())
        .merge(ssh_keys::router())
        .merge(logs::router())
        .merge(targets::router())
        .merge(target_groups::router())
        .merge(users::router())
        .merge(password_credentials::router())
        .merge(sso_credentials::router())
        .merge(public_key_credentials::router())
        .merge(otp_credentials::router())
        .merge(parameters::router())
        .merge(ssh_connection_test::router())
        .merge(certificate_credentials::router())
        .merge(api_tokens::router())
        .merge(accounts::router())
        .merge(command_acl::router())
        .merge(command_records::router())
        .merge(command_review::router())
        .merge(management_sessions::router())
}

#![forbid(unsafe_code)]
pub mod api;
pub mod http_service;

use axum::http::header::CONTENT_TYPE;
use axum::response::Html;
use axum::routing::get;
use axum::{Extension, Router};
use gated_common::version::gated_version;
use gated_common::web::security_schemes;
use gated_core::Services;
use utoipa::openapi::{Components, Info, OpenApi, OpenApiBuilder, Server};
use utoipa_axum::router::OpenApiRouter;

pub use http_service::HTTPProtocolServer;

const PLAYGROUND_TEMPLATE: &str = include_str!("playground.html");

/// Document skeleton shared by the admin and user API.
fn openapi_document(title: &str, version: &str, server: &str) -> OpenApi {
    let mut components = Components::new();
    for (name, scheme) in security_schemes() {
        components.add_security_scheme(name, scheme);
    }
    OpenApiBuilder::new()
        .info(Info::new(title, version))
        .servers(Some(vec![Server::new(server)]))
        .components(Some(components))
        .build()
}

pub fn admin_api_router(version: &str) -> OpenApiRouter {
    OpenApiRouter::with_openapi(openapi_document("Gated admin API", version, "/admin/api"))
        .merge(crate::api::router())
}

pub fn user_api_router(version: &str) -> OpenApiRouter {
    OpenApiRouter::with_openapi(openapi_document("Gated user API", version, "/api"))
        .merge(crate::http_service::api::router())
}

/// Adds the document and its interactive viewer to an API router.
pub(crate) fn with_openapi_routes(router: OpenApiRouter) -> Router {
    let (router, document) = router.split_for_parts();
    let spec = document.to_json().unwrap_or_default();
    // The document is embedded in a script element.
    let playground = PLAYGROUND_TEMPLATE.replace("'{:spec}'", &spec.replace("</", "<\\/"));
    router
        .route(
            "/openapi.json",
            get(move || {
                let spec = spec.clone();
                async move { ([(CONTENT_TYPE, "application/json; charset=utf-8")], spec) }
            }),
        )
        .route(
            "/playground",
            get(move || {
                let playground = playground.clone();
                async move { Html(playground) }
            }),
        )
}

pub fn admin_api_app(services: &Services) -> Router {
    with_openapi_routes(admin_api_router(gated_version()))
        .route(
            "/recordings/{id}/cast",
            get(crate::api::recordings_detail::api_get_recording_cast),
        )
        .route(
            "/recordings/{id}/stream",
            get(crate::api::recordings_detail::api_get_recording_stream),
        )
        .route(
            "/recordings/{id}/tcpdump",
            get(crate::api::recordings_detail::api_get_recording_tcpdump),
        )
        .route(
            "/sessions/changes",
            get(crate::api::sessions_list::api_get_sessions_changes_stream),
        )
        .route(
            "/sessions/{id}/monitor",
            get(crate::http_service::api::session_monitor::api_session_monitor),
        )
        .layer(Extension(services.db.clone()))
        .layer(Extension(services.config_provider.clone()))
        .layer(Extension(services.state.clone()))
        .layer(Extension(services.recordings.clone()))
        .layer(Extension(services.config.clone()))
        .layer(Extension(services.command_review_store.clone()))
}

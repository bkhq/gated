//! Shared axum plumbing: extractors, OpenAPI documentation helpers and the
//! connection server.

mod doc;
mod extract;
mod security;
pub mod server;

pub use doc::{ApiArgument, ApiHandler, ApiPayload, ApiResponse, Schemas, description, route};
pub use extract::{Data, Json, PlainText};
pub use security::{AnySecurityScheme, security_schemes};

#[doc(hidden)]
pub mod __private {
    pub use pastey::paste;
    pub use {axum, utoipa, utoipa_axum};

    pub use super::doc::{body_response, empty_response, field_schema, status};
}

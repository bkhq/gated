use axum::extract::{Query, Request};
use axum::http::StatusCode;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use gated_common::Secret;
use gated_core::{Services, authorize_ticket, consume_ticket};
use serde::Deserialize;

use crate::http_service::common::{SessionAuthorization, SessionExt};
use crate::http_service::session::Session;

#[derive(Deserialize)]
struct QueryParams {
    #[serde(rename = "gated-ticket")]
    ticket: Option<String>,
}

/// Authorizes the session from a ticket passed in the query string or in an
/// `Authorization: Gated <secret>` header.
pub async fn ticket_middleware(request: Request, next: Next) -> Response {
    let mut session_is_temporary = false;
    let Some(session) = request.extensions().get::<Session>().cloned() else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };

    {
        let Ok(Query(params)) = Query::<QueryParams>::try_from_uri(request.uri()) else {
            return StatusCode::BAD_REQUEST.into_response();
        };

        let mut ticket_value = None;
        if let Some(t) = params.ticket {
            ticket_value = Some(t);
        }
        for h in request.headers().get_all(http::header::AUTHORIZATION) {
            let header_value = h.to_str().unwrap_or("").to_string();
            if let Some((token_type, token_value)) = header_value.split_once(' ')
                && &token_type.to_lowercase() == "gated"
            {
                ticket_value = Some(token_value.to_string());
                session_is_temporary = true;
            }
        }

        if let Some(ticket) = ticket_value {
            let Some(services) = request.extensions().get::<Services>().cloned() else {
                return StatusCode::INTERNAL_SERVER_ERROR.into_response();
            };

            let ticket_secret = Secret::new(ticket);
            let authorized = match authorize_ticket(&services.db, &ticket_secret).await {
                Ok(authorized) => authorized,
                Err(error) => return error.into_response(),
            };
            if let Some((ticket_model, _user_info)) = authorized {
                if let Err(error) = consume_ticket(&services.db, &ticket_model.id).await {
                    return error.into_response();
                }
                session.set_auth(SessionAuthorization::Ticket {
                    username: ticket_model.username,
                    target_name: ticket_model.target,
                });
            }
        }
    }

    let response = next.run(request).await;

    if session_is_temporary {
        session.clear();
    }

    response
}

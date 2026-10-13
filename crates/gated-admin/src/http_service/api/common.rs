use gated_common::GatedError;
use gated_db_entities as entities;
use poem::session::Session;
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use tracing::info;

use crate::http_service::common::{RequestAuthorization, SessionAuthorization};
use crate::http_service::session::SessionStore;

pub fn logout(session: &Session, session_middleware: &mut SessionStore) {
    session_middleware.remove_session(session);
    session.clear();
    info!("Logged out");
}

pub async fn get_user(
    auth: &RequestAuthorization,
    db: &DatabaseConnection,
) -> Result<Option<entities::User::Model>, GatedError> {
    let Some(username) = auth.username() else {
        return Ok(None);
    };

    let Some(user_model) = entities::User::Entity::find()
        .filter(entities::User::Column::Username.eq(username))
        .one(db)
        .await?
    else {
        return Ok(None);
    };

    Ok(Some(user_model))
}

/// Tickets are narrow, target-scoped, expiring credentials whose scope is
/// enforced by `authorize_target` on the connection/terminal routes. They
/// must never be accepted on self-service account- or credential-management
/// endpoints: a leaked ticket secret would otherwise grant full, persistent
/// account takeover (change password, add key/OTP, mint a fresh ticket).
/// Returns `true` when the request is authenticated via a
/// Ticket and must therefore be rejected by those endpoints.
pub fn is_ticket_auth(auth: &RequestAuthorization) -> bool {
    matches!(
        auth,
        RequestAuthorization::Session(SessionAuthorization::Ticket { .. })
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // The credential-management and
    // ticket-creation handlers gate on `is_ticket_auth`. A Ticket-backed
    // session must be flagged for rejection, while an interactive user
    // session, a user token, and an admin token must not be — otherwise a
    // leaked ticket secret would grant full account takeover.
    #[tokio::test]
    async fn terminal_close_wakes_a_bridge_that_starts_later() {
        use gated_core::SessionHandle;
        let notify = std::sync::Arc::new(tokio::sync::Notify::new());
        let mut handle = TerminalSessionHandle(notify.clone());
        handle.close();
        tokio::time::timeout(std::time::Duration::from_secs(1), notify.notified())
            .await
            .expect("close() must be observed by a later waiter");
    }

    #[test]
    fn ticket_session_is_rejected_other_auth_kinds_are_not() {
        let ticket = RequestAuthorization::Session(SessionAuthorization::Ticket {
            username: "victim".to_owned(),
            target_name: "prod-db".to_owned(),
        });
        assert!(is_ticket_auth(&ticket));

        let user = RequestAuthorization::Session(SessionAuthorization::User("victim".to_owned()));
        assert!(!is_ticket_auth(&user));

        let token = RequestAuthorization::UserToken {
            username: "victim".to_owned(),
        };
        assert!(!is_ticket_auth(&token));

        assert!(!is_ticket_auth(&RequestAuthorization::AdminToken));
    }
}

/// Status message sent to a web terminal client when its session is closed
/// from the gateway side (admin close, credential revocation, lost
/// authorization).
pub(crate) const TERMINAL_CLOSED_MESSAGE: &str = "Session closed by the gateway";

/// Session handle for web terminals. `close()` wakes the terminal bridge,
/// which then tears down the upstream connection and the WebSocket. A close
/// requested before the bridge starts is remembered and ends it immediately.
pub(crate) struct TerminalSessionHandle(pub(crate) std::sync::Arc<tokio::sync::Notify>);

impl gated_core::SessionHandle for TerminalSessionHandle {
    fn close(&mut self) {
        self.0.notify_one();
    }
}

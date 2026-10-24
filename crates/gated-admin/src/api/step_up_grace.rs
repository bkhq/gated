//! Sliding step-up window kept in the server-side browser session.
//!
//! A successful password/OTP confirmation opens the window; every
//! step-up-protected operation inside it extends the window to `GRACE` from
//! that operation. The window is bound to the confirming username and ends
//! with the session (logout clears it).

use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};

use crate::http_service::session::Session;

const SESSION_KEY: &str = "step_up_grace";
pub const GRACE: Duration = Duration::minutes(15);

#[derive(Serialize, Deserialize)]
struct Grace {
    username: String,
    until: DateTime<Utc>,
}

/// End of the open window for `username`, if any.
pub fn active_until(
    session: &Session,
    username: &str,
    now: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    session
        .get::<Grace>(SESSION_KEY)
        .filter(|grace| grace.username == username && grace.until > now)
        .map(|grace| grace.until)
}

/// Open or extend the window for `username` to `GRACE` from `now`.
pub fn extend(session: &Session, username: &str, now: DateTime<Utc>) {
    session.set(
        SESSION_KEY,
        Grace {
            username: username.to_owned(),
            until: now + GRACE,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session() -> Session {
        Session::new(Default::default())
    }

    #[test]
    fn window_opens_extends_and_expires() {
        let session = session();
        let t0 = Utc::now();
        assert_eq!(active_until(&session, "alice", t0), None);

        extend(&session, "alice", t0);
        assert_eq!(
            active_until(&session, "alice", t0 + Duration::minutes(14)),
            Some(t0 + GRACE)
        );

        // An operation at minute 10 pushes the end to minute 25.
        extend(&session, "alice", t0 + Duration::minutes(10));
        assert_eq!(
            active_until(&session, "alice", t0 + Duration::minutes(24)),
            Some(t0 + Duration::minutes(25))
        );
        assert_eq!(
            active_until(&session, "alice", t0 + Duration::minutes(25)),
            None
        );
    }

    #[test]
    fn window_is_bound_to_the_confirming_user_and_session() {
        let session = session();
        let now = Utc::now();
        extend(&session, "alice", now);
        assert_eq!(active_until(&session, "bob", now), None);
        assert_eq!(active_until(&self::session(), "alice", now), None);

        session.clear();
        assert_eq!(active_until(&session, "alice", now), None);
    }
}

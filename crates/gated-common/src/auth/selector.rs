use std::fmt::Debug;

use crate::Secret;
use crate::consts::TICKET_SELECTOR_PREFIX;

pub enum AuthSelector {
    User {
        username: String,
        target_name: String,
        /// Account to sign in with when the user may use several.
        account: Option<String>,
    },
    Ticket {
        secret: Secret<String>,
    },
}

impl<T: AsRef<str>> From<T> for AuthSelector {
    fn from(selector: T) -> Self {
        if let Some(secret) = selector.as_ref().strip_prefix(TICKET_SELECTOR_PREFIX) {
            let secret = Secret::new(secret.into());
            return AuthSelector::Ticket { secret };
        }

        let separator = if selector.as_ref().contains('#') {
            '#'
        } else {
            ':'
        };

        let mut parts = selector.as_ref().splitn(3, separator);
        let username = parts.next().unwrap_or("").to_string();
        let target_name = parts.next().unwrap_or("").to_string();
        let account = parts.next().filter(|a| !a.is_empty()).map(str::to_string);
        AuthSelector::User {
            username,
            target_name,
            account,
        }
    }
}

impl Debug for AuthSelector {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthSelector::User {
                username,
                target_name,
                account: None,
            } => write!(f, "<{username} for {target_name}>"),
            AuthSelector::User {
                username,
                target_name,
                account: Some(account),
            } => write!(f, "<{username} for {target_name} as {account}>"),
            AuthSelector::Ticket { .. } => write!(f, "<ticket>"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn user(selector: &str) -> (String, String, Option<String>) {
        match AuthSelector::from(selector) {
            AuthSelector::User {
                username,
                target_name,
                account,
            } => (username, target_name, account),
            AuthSelector::Ticket { .. } => panic!("not a user selector"),
        }
    }

    #[test]
    fn an_optional_third_part_names_the_account() {
        assert_eq!(user("alice:web"), ("alice".into(), "web".into(), None));
        assert_eq!(
            user("alice:web:deploy"),
            ("alice".into(), "web".into(), Some("deploy".into()))
        );
        assert_eq!(
            user("alice#web#deploy"),
            ("alice".into(), "web".into(), Some("deploy".into()))
        );
        assert_eq!(user("alice:web:"), ("alice".into(), "web".into(), None));
    }
}

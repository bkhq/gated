use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// Longest minimum length an administrator can ask for.
pub const MAX_MIN_LENGTH: u32 = 128;

/// Rules a new password must satisfy.
#[derive(Debug, Clone, Default, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
pub struct PasswordPolicy {
    /// Minimum number of characters, 0 to 128 (0 = no requirement).
    pub min_length: u32,
    pub require_uppercase: bool,
    pub require_lowercase: bool,
    pub require_digits: bool,
    /// An ASCII character that is neither a letter nor a digit.
    pub require_special: bool,
}

impl PasswordPolicy {
    /// What `password` lacks, as one sentence; `None` when it is accepted.
    pub fn violation(&self, password: &str) -> Option<String> {
        let mut missing = Vec::new();
        if (password.chars().count() as u64) < u64::from(self.min_length) {
            missing.push(format!("at least {} characters", self.min_length));
        }
        if self.require_uppercase && !password.chars().any(char::is_uppercase) {
            missing.push("an uppercase letter".into());
        }
        if self.require_lowercase && !password.chars().any(char::is_lowercase) {
            missing.push("a lowercase letter".into());
        }
        if self.require_digits && !password.chars().any(|c| c.is_ascii_digit()) {
            missing.push("a digit".into());
        }
        if self.require_special
            && !password
                .chars()
                .any(|c| c.is_ascii() && !c.is_ascii_alphanumeric() && !c.is_ascii_control())
        {
            missing.push("a special character".into());
        }
        (!missing.is_empty()).then(|| format!("the password needs {}", missing.join(", ")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> PasswordPolicy {
        PasswordPolicy {
            min_length: 8,
            require_uppercase: true,
            require_lowercase: true,
            require_digits: true,
            require_special: true,
        }
    }

    #[test]
    fn a_password_that_meets_every_rule_is_accepted() {
        assert_eq!(policy().violation("Str0ng!Pass"), None);
    }

    #[test]
    fn each_broken_rule_is_named() {
        let cases = [
            ("Ab1!", "at least 8 characters"),
            ("str0ng!pass", "an uppercase letter"),
            ("STR0NG!PASS", "a lowercase letter"),
            ("Strong!Pass", "a digit"),
            ("Str0ngPass", "a special character"),
            ("Str0ngPass\u{e9}\n", "a special character"),
        ];
        for (password, expected) in cases {
            assert_eq!(
                policy().violation(password),
                Some(format!("the password needs {expected}")),
                "{password:?}"
            );
        }
        assert_eq!(
            policy().violation("abc"),
            Some(
                "the password needs at least 8 characters, an uppercase letter, a digit, a special character"
                    .into()
            )
        );
    }

    #[test]
    fn length_is_counted_in_characters_and_an_empty_policy_accepts_anything() {
        let policy = PasswordPolicy {
            min_length: 4,
            ..Default::default()
        };
        assert_eq!(policy.violation("\u{5bc6}\u{7801}\u{5f88}\u{957f}"), None);
        assert_eq!(PasswordPolicy::default().violation(""), None);
    }
}

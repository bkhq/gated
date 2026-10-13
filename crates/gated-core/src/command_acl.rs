//! Reusable command-ACL matcher.
//!
//! This is the pure, DB-free heart of the command-filtering feature consumed
//! by the DB and SSH command-review paths. It evaluates a preloaded ruleset
//! against a single command and returns a decision. It performs no I/O, so it
//! is fully unit-testable and safe to call on a hot path.
//!
//! **Default OFF:** an empty ruleset — or one where nothing matches — yields
//! [`AclAction::Allow`]. Filtering only takes effect once an administrator
//! adds matching rules.
//!
//! Loading entity rows into [`CommandAclRuleView`] is left to the caller (see
//! `gated-admin`) so this crate stays free of the entity/DB layer.

use regex::Regex;
use uuid::Uuid;

/// The verdict for a command.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AclAction {
    Allow,
    Deny,
    Review,
}

/// Outcome of [`evaluate`]. `rule_id`/`rule_name` identify the deciding rule,
/// and are `None` when no rule matched (the default-allow case).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AclDecision {
    pub action: AclAction,
    pub rule_id: Option<i64>,
    pub rule_name: Option<String>,
}

/// Everything the matcher needs about the command being evaluated.
pub struct AclContext<'a> {
    /// "ssh" | "mysql" | "postgres" (the concrete protocol of this command).
    pub protocol: &'a str,
    /// The raw command text.
    pub command: &'a str,
    /// The target this command runs against, if known.
    pub target_id: Option<Uuid>,
    /// The roles held by the acting user.
    pub role_ids: &'a [Uuid],
}

/// A single ACL rule, decoupled from the SeaORM entity so the matcher does not
/// depend on the DB layer. Map an entity `Model` into this where rules are
/// loaded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommandAclRuleView {
    pub id: i64,
    pub name: String,
    pub enabled: bool,
    /// Lower is evaluated first.
    pub priority: i32,
    /// "ssh" | "mysql" | "postgres" | "any".
    pub protocol: String,
    /// "regex" | "keyword".
    pub match_type: String,
    pub pattern: String,
    /// "allow" | "deny" | "review".
    pub action: String,
    /// `None` = applies to all targets.
    pub target_id: Option<Uuid>,
    /// `None` = applies to all roles.
    pub role_id: Option<Uuid>,
}

/// Evaluate `ctx` against `rules`.
///
/// Only enabled rules whose protocol matches (or is `"any"`), whose target
/// scope is unset or equals `ctx.target_id`, and whose role scope is unset or
/// is one of `ctx.role_ids` are considered. Candidates are ordered by
/// ascending `priority` (ties broken by ascending `id`); the first whose
/// pattern matches the command decides. If nothing matches, the result is
/// [`AclAction::Allow`] with no rule (default OFF).
pub fn evaluate(rules: &[CommandAclRuleView], ctx: &AclContext) -> AclDecision {
    let mut candidates: Vec<&CommandAclRuleView> =
        rules.iter().filter(|r| rule_applies(r, ctx)).collect();
    candidates.sort_by(|a, b| a.priority.cmp(&b.priority).then_with(|| a.id.cmp(&b.id)));

    for rule in candidates {
        if pattern_matches(rule, ctx.command) {
            return AclDecision {
                action: parse_action(&rule.action),
                rule_id: Some(rule.id),
                rule_name: Some(rule.name.clone()),
            };
        }
    }

    AclDecision {
        action: AclAction::Allow,
        rule_id: None,
        rule_name: None,
    }
}

/// Scope predicate: protocol, target, and role gating (not the pattern).
fn rule_applies(rule: &CommandAclRuleView, ctx: &AclContext) -> bool {
    if !rule.enabled {
        return false;
    }
    if rule.protocol != "any" && rule.protocol != ctx.protocol {
        return false;
    }
    let target_ok = match rule.target_id {
        None => true,
        Some(t) => ctx.target_id == Some(t),
    };
    if !target_ok {
        return false;
    }
    match rule.role_id {
        None => true,
        Some(rid) => ctx.role_ids.contains(&rid),
    }
}

/// An unknown action string is treated as `Allow` (fail-open, consistent with
/// the default-OFF policy). The CRUD layer validates the enum on write, so this
/// only guards against manually-tampered rows.
fn parse_action(action: &str) -> AclAction {
    match action {
        "deny" => AclAction::Deny,
        "review" => AclAction::Review,
        _ => AclAction::Allow,
    }
}

/// Does this rule's pattern match `command`? An invalid stored regex never
/// matches (it cannot panic and cannot decide), so evaluation falls through to
/// the default. CRUD validation rejects invalid regex on write.
fn pattern_matches(rule: &CommandAclRuleView, command: &str) -> bool {
    match rule.match_type.as_str() {
        "regex" => Regex::new(&rule.pattern).is_ok_and(|re| re.is_match(command)),
        "keyword" => keyword_matches(&rule.pattern, command),
        _ => false,
    }
}

/// Case-insensitive keyword match. A single-word keyword (letters, digits,
/// `_`) matches as a whole token — reusing the alpha-run tokenizer approach
/// from `sql_validation` so `drop` does not match `eavesdrop`. A keyword
/// containing other characters (e.g. `rm -rf`) falls back to substring match.
fn keyword_matches(pattern: &str, command: &str) -> bool {
    let pat = pattern.trim().to_ascii_lowercase();
    if pat.is_empty() {
        return false;
    }
    let cmd = command.to_ascii_lowercase();
    if pat.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        tokenize(&cmd).contains(&pat)
    } else {
        cmd.contains(&pat)
    }
}

/// Emit every contiguous run of ASCII alphanumerics (plus `_`) as one token.
/// Punctuation and whitespace are boundaries. Mirrors `sql_validation`'s
/// tokenizer intent; the input is already lower-cased by the caller.
fn tokenize(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in s.chars() {
        if ch.is_ascii_alphanumeric() || ch == '_' {
            cur.push(ch);
        } else if !cur.is_empty() {
            out.push(std::mem::take(&mut cur));
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(id: i64, action: &str, match_type: &str, pattern: &str) -> CommandAclRuleView {
        CommandAclRuleView {
            id,
            name: format!("rule-{id}"),
            enabled: true,
            priority: 100,
            protocol: "any".into(),
            match_type: match_type.into(),
            pattern: pattern.into(),
            action: action.into(),
            target_id: None,
            role_id: None,
        }
    }

    fn ctx<'a>(command: &'a str) -> AclContext<'a> {
        AclContext {
            protocol: "ssh",
            command,
            target_id: None,
            role_ids: &[],
        }
    }

    #[test]
    fn empty_ruleset_allows() {
        let decision = evaluate(&[], &ctx("rm -rf /"));
        assert_eq!(decision.action, AclAction::Allow);
        assert_eq!(decision.rule_id, None);
        assert_eq!(decision.rule_name, None);
    }

    #[test]
    fn no_match_allows() {
        let rules = vec![rule(1, "deny", "keyword", "shutdown")];
        assert_eq!(evaluate(&rules, &ctx("ls -la")).action, AclAction::Allow);
    }

    #[test]
    fn deny_match() {
        let rules = vec![rule(7, "deny", "keyword", "drop")];
        let d = evaluate(&rules, &ctx("DROP TABLE users"));
        assert_eq!(d.action, AclAction::Deny);
        assert_eq!(d.rule_id, Some(7));
        assert_eq!(d.rule_name.as_deref(), Some("rule-7"));
    }

    #[test]
    fn review_match() {
        let rules = vec![rule(1, "review", "keyword", "sudo")];
        assert_eq!(
            evaluate(&rules, &ctx("sudo reboot")).action,
            AclAction::Review
        );
    }

    #[test]
    fn allow_match_is_explicit() {
        let rules = vec![rule(1, "allow", "keyword", "ls")];
        let d = evaluate(&rules, &ctx("ls -la"));
        assert_eq!(d.action, AclAction::Allow);
        assert_eq!(d.rule_id, Some(1));
    }

    #[test]
    fn priority_lower_wins() {
        // Both match; the lower-priority (evaluated first) rule decides.
        let mut deny = rule(1, "deny", "keyword", "cat");
        deny.priority = 10;
        let mut allow = rule(2, "allow", "keyword", "cat");
        allow.priority = 5;
        let d = evaluate(&[deny, allow], &ctx("cat /etc/passwd"));
        assert_eq!(d.action, AclAction::Allow);
        assert_eq!(d.rule_id, Some(2));
    }

    #[test]
    fn priority_tie_breaks_on_id() {
        let mut a = rule(9, "deny", "keyword", "cat");
        a.priority = 5;
        let mut b = rule(3, "allow", "keyword", "cat");
        b.priority = 5;
        // Lower id (3) wins the tie.
        let d = evaluate(&[a, b], &ctx("cat file"));
        assert_eq!(d.rule_id, Some(3));
        assert_eq!(d.action, AclAction::Allow);
    }

    #[test]
    fn protocol_scoping() {
        let mut ssh_only = rule(1, "deny", "keyword", "drop");
        ssh_only.protocol = "mysql".into();
        // ctx protocol is "ssh" -> mysql-scoped rule does not apply.
        assert_eq!(
            evaluate(&[ssh_only.clone()], &ctx("drop x")).action,
            AclAction::Allow
        );

        // "any" always applies.
        let anyp = rule(2, "deny", "keyword", "drop");
        assert_eq!(evaluate(&[anyp], &ctx("drop x")).action, AclAction::Deny);

        // Matching concrete protocol applies.
        let mysql_ctx = AclContext {
            protocol: "mysql",
            command: "drop x",
            target_id: None,
            role_ids: &[],
        };
        assert_eq!(evaluate(&[ssh_only], &mysql_ctx).action, AclAction::Deny);
    }

    #[test]
    fn target_scoping() {
        let target = Uuid::from_u128(42);
        let mut scoped = rule(1, "deny", "keyword", "drop");
        scoped.target_id = Some(target);

        // No target in context -> scoped rule does not apply.
        assert_eq!(
            evaluate(&[scoped.clone()], &ctx("drop x")).action,
            AclAction::Allow
        );

        // Different target -> does not apply.
        let other = AclContext {
            protocol: "ssh",
            command: "drop x",
            target_id: Some(Uuid::from_u128(1)),
            role_ids: &[],
        };
        assert_eq!(evaluate(&[scoped.clone()], &other).action, AclAction::Allow);

        // Matching target -> applies.
        let matching = AclContext {
            protocol: "ssh",
            command: "drop x",
            target_id: Some(target),
            role_ids: &[],
        };
        assert_eq!(evaluate(&[scoped], &matching).action, AclAction::Deny);
    }

    #[test]
    fn role_scoping() {
        let role = Uuid::from_u128(5);
        let mut scoped = rule(1, "deny", "keyword", "drop");
        scoped.role_id = Some(role);

        // User lacks the role -> rule does not apply.
        assert_eq!(
            evaluate(&[scoped.clone()], &ctx("drop x")).action,
            AclAction::Allow
        );

        // User has the role -> applies.
        let held = [Uuid::from_u128(1), role, Uuid::from_u128(9)];
        let with_role = AclContext {
            protocol: "ssh",
            command: "drop x",
            target_id: None,
            role_ids: &held,
        };
        assert_eq!(evaluate(&[scoped], &with_role).action, AclAction::Deny);
    }

    #[test]
    fn keyword_is_case_insensitive() {
        let rules = vec![rule(1, "deny", "keyword", "ShUtDoWn")];
        assert_eq!(
            evaluate(&rules, &ctx("SHUTDOWN now")).action,
            AclAction::Deny
        );
    }

    #[test]
    fn keyword_matches_whole_token_only() {
        // "drop" must not match inside "eavesdrop".
        let rules = vec![rule(1, "deny", "keyword", "drop")];
        assert_eq!(
            evaluate(&rules, &ctx("eavesdropping tool")).action,
            AclAction::Allow
        );
    }

    #[test]
    fn keyword_multiword_uses_substring() {
        let rules = vec![rule(1, "deny", "keyword", "rm -rf")];
        assert_eq!(
            evaluate(&rules, &ctx("sudo rm -rf /")).action,
            AclAction::Deny
        );
        assert_eq!(evaluate(&rules, &ctx("rm file")).action, AclAction::Allow);
    }

    #[test]
    fn regex_match() {
        let rules = vec![rule(1, "review", "regex", r"^\s*shutdown\b")];
        assert_eq!(
            evaluate(&rules, &ctx("shutdown -h now")).action,
            AclAction::Review
        );
        assert_eq!(
            evaluate(&rules, &ctx("please shutdown")).action,
            AclAction::Allow
        );
    }

    #[test]
    fn invalid_regex_never_matches() {
        // An unclosed group is an invalid pattern; it must not panic and must
        // not decide, so evaluation falls through to the default allow.
        let rules = vec![rule(1, "deny", "regex", r"(unclosed")];
        assert_eq!(evaluate(&rules, &ctx("anything")).action, AclAction::Allow);
    }

    #[test]
    fn disabled_rules_are_ignored() {
        let mut disabled = rule(1, "deny", "keyword", "drop");
        disabled.enabled = false;
        assert_eq!(
            evaluate(&[disabled], &ctx("drop table")).action,
            AclAction::Allow
        );
    }

    #[test]
    fn unknown_action_treated_as_allow() {
        let rules = vec![rule(1, "bogus", "keyword", "drop")];
        assert_eq!(evaluate(&rules, &ctx("drop x")).action, AclAction::Allow);
    }
}

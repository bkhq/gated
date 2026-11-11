//! Tokenizer-based readonly validation for SQL sent to a read-only database
//! target: the allowlist used by the SQL console and the guard the native
//! proxies apply on top of a read-only upstream session.
//!
//! This is strictly stricter than a `starts_with("SELECT")` check and
//! catches the common bypass shapes we've seen in bug reports:
//!
//! - **Multi-statement**: `SELECT 1; UPDATE t SET x = 1;`
//! - **Writable CTEs**: `WITH w AS (DELETE FROM t RETURNING *) SELECT * FROM w`
//! - **Dangerous server-side functions**: `SELECT pg_read_server_files(...)`,
//!   `SELECT lo_import(...)`, `SELECT load_file(...)`, etc.
//! - **Comment-wrapped writes** (already handled by comment stripping)
//!
//! It is not a full SQL parser. It runs a small state machine that
//! strips string literals, quoted identifiers, line/block/dollar
//! comments, then scans the remaining alpha-only tokens against two
//! small allow/deny lists.

use std::fmt;

/// Quoting and comment rules differ between the engines; lexing a statement
/// with the wrong ones can hide code from the validator.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SqlDialect {
    MySql,
    Postgres,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadonlyViolation {
    Empty,
    NotReadOnly,
    MultipleStatements,
    WriteKeyword(String),
    DangerousFunction(String),
}

impl fmt::Display for ReadonlyViolation {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Empty => f.write_str("SQL is empty"),
            Self::NotReadOnly => f.write_str(
                "Target is read-only: only SELECT / SHOW / EXPLAIN / WITH / DESC are allowed",
            ),
            Self::MultipleStatements => {
                f.write_str("Target is read-only: multiple statements are not allowed")
            }
            Self::WriteKeyword(k) => {
                write!(f, "Target is read-only: '{k}' is a write statement")
            }
            Self::DangerousFunction(k) => {
                write!(f, "Target is read-only: function '{k}' is not allowed")
            }
        }
    }
}

/// Keywords that unambiguously mutate server state. Presence anywhere
/// in the tokenised SQL (outside strings / comments / quoted idents)
/// rejects the query. `SET` is intentionally omitted — it is common
/// for session-local options and does not persist across sessions.
const WRITE_KEYWORDS: &[&str] = &[
    "INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "CREATE", "DROP", "ALTER", "TRUNCATE",
    "GRANT", "REVOKE", "CALL", "EXEC", "EXECUTE", "COPY", "VACUUM", "LOCK", "RENAME", "COMMENT",
    "REINDEX", "CLUSTER", "REFRESH", "ATTACH", "DETACH", "UPSERT",
    // File-write exfiltration: `SELECT ... INTO OUTFILE/DUMPFILE '/path'`.
    // The tokeniser treats `_` as part of a token, so column names like
    // `into_x` tokenise to `INTO_X` and do not trip these entries.
    "OUTFILE", "DUMPFILE",
];

/// Server-side functions that read or write host resources, execute
/// shell commands, or cause disproportionate CPU/sleep. Matched by
/// identifier name regardless of schema qualification.
const DANGEROUS_FUNCTIONS: &[&str] = &[
    "pg_read_server_files",
    "pg_read_binary_file",
    "pg_write_server_files",
    "pg_ls_dir",
    "pg_read_file",
    "pg_sleep",
    "pg_sleep_for",
    "pg_sleep_until",
    "pg_exec",
    "lo_import",
    "lo_export",
    "xp_cmdshell",
    "sys_exec",
    "sys_eval",
    "load_file",
    "sleep",
    "benchmark",
];

const ALLOWED_FIRST_KEYWORDS: &[&str] = &["SELECT", "SHOW", "EXPLAIN", "DESCRIBE", "DESC", "WITH"];

/// Reject anything that is not an obviously safe read statement.
pub fn validate_readonly_sql(sql: &str, dialect: SqlDialect) -> Result<(), ReadonlyViolation> {
    let stripped = strip_comments_and_strings(sql, dialect, false);
    if stripped.trim().is_empty() {
        return Err(ReadonlyViolation::Empty);
    }

    // Count real statements. A trailing `;` is fine; two
    // substantive statements are not.
    let non_empty = stripped
        .split(';')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .count();
    if non_empty > 1 {
        return Err(ReadonlyViolation::MultipleStatements);
    }

    let tokens = tokenize(&stripped);
    let Some(first) = tokens.first() else {
        return Err(ReadonlyViolation::Empty);
    };
    if !ALLOWED_FIRST_KEYWORDS.contains(&first.as_str()) {
        return Err(ReadonlyViolation::NotReadOnly);
    }

    for t in &tokens {
        if WRITE_KEYWORDS.contains(&t.as_str()) {
            return Err(ReadonlyViolation::WriteKeyword(t.clone()));
        }
    }

    if tokens.iter().any(|token| token == "INTO") {
        return Err(ReadonlyViolation::WriteKeyword("INTO".to_string()));
    }

    let identifiers = tokenize(&strip_comments_and_strings(sql, dialect, true));
    // Dangerous functions are matched case-insensitively. They are
    // lowercase in the blacklist; uppercase the token and compare.
    for t in &identifiers {
        let lower = t.to_ascii_lowercase();
        if DANGEROUS_FUNCTIONS.contains(&lower.as_str()) {
            return Err(ReadonlyViolation::DangerousFunction(lower));
        }
    }

    Ok(())
}

/// Statements a read-only native session may not run: the ones that switch the
/// upstream session back to read-write, and the writes a read-only
/// transaction does not stop. The upstream session mode is the enforcement;
/// this only keeps it in place, and dynamic SQL can still get around it.
const ESCAPE_TOKENS: &[&str] = &[
    "TRANSACTION_READ_ONLY",
    "DEFAULT_TRANSACTION_READ_ONLY",
    "TX_READ_ONLY",
    "SET_CONFIG",
    "OUTFILE",
    "DUMPFILE",
];

const ESCAPE_FIRST_KEYWORDS: &[&str] = &[
    "DISCARD",
    "DO",
    "PREPARE",
    "RESET",
    "FLUSH",
    "PURGE",
    "SHUTDOWN",
    "INSTALL",
    "UNINSTALL",
    "CHANGE",
];

/// Whether `sql` would take a read-only native session out of read-only mode
/// or write despite it.
pub fn escapes_readonly_session(sql: &str, dialect: SqlDialect) -> bool {
    let raw = sql.to_ascii_lowercase();
    if raw.contains("transaction_read_only") || raw.contains("tx_read_only") {
        return true;
    }
    let stripped = strip_comments_and_strings(sql, dialect, true);
    stripped.split(';').any(|statement| {
        let tokens = tokenize(statement);
        let Some(first) = tokens.first() else {
            return false;
        };
        ESCAPE_FIRST_KEYWORDS.contains(&first.as_str())
            || tokens
                .iter()
                .any(|token| ESCAPE_TOKENS.contains(&token.as_str()))
            || tokens
                .windows(2)
                .any(|pair| matches!(pair, [a, b] if a == "READ" && b == "WRITE"))
            || (first == "SET"
                && tokens
                    .iter()
                    .any(|token| matches!(token.as_str(), "GLOBAL" | "PERSIST" | "PERSIST_ONLY")))
    })
}

/// Replace every string literal, quoted identifier, and comment with
/// a single space. This preserves statement structure (boundaries,
/// keyword positions) so the tokeniser runs over sanitized input.
fn strip_comments_and_strings(
    sql: &str,
    dialect: SqlDialect,
    preserve_identifiers: bool,
) -> String {
    enum State {
        Normal,
        Single { backslash: bool }, // '...'
        Double,                     // "..."
        Backtick,                   // MySQL `...`
        LineComment,                // -- ... \n
        BlockComment,               // /* ... */
        DollarQuote(String),        // $tag$ ... $tag$
    }
    let mut state = State::Normal;
    let mut out = String::with_capacity(sql.len());
    let bytes = sql.as_bytes();
    let mut i = 0;
    while let Some(&b) = bytes.get(i) {
        let ch = b as char;
        match &state {
            State::Normal => {
                // PostgreSQL Unicode identifiers need decoding before function checks.
                // Reject this optional spelling rather than treating escaped function names as safe.
                if matches!(ch, 'U' | 'u') && bytes.get(i + 1..i + 3) == Some(b"&\"") {
                    out.push_str(" EXECUTE ");
                }
                // Line comment -- ... (MySQL needs whitespace after the dashes)
                if ch == '-'
                    && bytes.get(i + 1) == Some(&b'-')
                    && (dialect == SqlDialect::Postgres
                        || bytes.get(i + 2).is_none_or(|b| b.is_ascii_whitespace()))
                {
                    state = State::LineComment;
                    out.push(' ');
                    i += 2;
                    continue;
                }
                if ch == '#' && dialect == SqlDialect::MySql {
                    state = State::LineComment;
                    out.push(' ');
                    i += 1;
                    continue;
                }
                // Block comment /* ... */
                if ch == '/' && bytes.get(i + 1) == Some(&b'*') {
                    if bytes.get(i + 2) == Some(&b'!') || bytes.get(i + 2..i + 4) == Some(b"M!") {
                        out.push_str(" EXECUTE ");
                    }
                    state = State::BlockComment;
                    out.push(' ');
                    i += 2;
                    continue;
                }
                // Dollar-quoted string $tag$...$tag$
                if ch == '$'
                    && dialect == SqlDialect::Postgres
                    && let Some(tag) = parse_dollar_tag(&sql[i..])
                {
                    out.push(' ');
                    i += tag.len();
                    state = State::DollarQuote(tag);
                    continue;
                }
                match ch {
                    '\'' => {
                        // Backslash escapes: always in MySQL, only in E'...' in Postgres.
                        let prefix = |back: usize| i.checked_sub(back).and_then(|j| bytes.get(j));
                        let backslash = dialect == SqlDialect::MySql
                            || (matches!(prefix(1), Some(b'E' | b'e'))
                                && !prefix(2)
                                    .is_some_and(|b| b.is_ascii_alphanumeric() || *b == b'_'));
                        state = State::Single { backslash };
                        out.push(' ');
                    }
                    '"' => {
                        state = State::Double;
                        out.push(' ');
                    }
                    '`' if dialect == SqlDialect::MySql => {
                        state = State::Backtick;
                        out.push(' ');
                    }
                    _ => out.push(ch),
                }
                i += 1;
            }
            State::Single { backslash } => {
                if *backslash && ch == '\\' && bytes.get(i + 1).is_some() {
                    i += 2;
                    continue;
                }
                // '' inside '...' means literal '
                if ch == '\'' && bytes.get(i + 1) == Some(&b'\'') {
                    i += 2;
                    continue;
                }
                if ch == '\'' {
                    state = State::Normal;
                    out.push(' ');
                }
                i += 1;
            }
            State::Double => {
                if dialect == SqlDialect::MySql && ch == '\\' && bytes.get(i + 1).is_some() {
                    i += 2;
                    continue;
                }
                if ch == '"' && bytes.get(i + 1) == Some(&b'"') {
                    i += 2;
                    continue;
                }
                if ch == '"' {
                    state = State::Normal;
                    out.push(' ');
                }
                if preserve_identifiers {
                    out.push(ch);
                }
                i += 1;
            }
            State::Backtick => {
                if ch == '`' {
                    state = State::Normal;
                    out.push(' ');
                }
                if preserve_identifiers {
                    out.push(ch);
                }
                i += 1;
            }
            State::LineComment => {
                if ch == '\n' {
                    state = State::Normal;
                    out.push('\n');
                }
                i += 1;
            }
            State::BlockComment => {
                if ch == '*' && bytes.get(i + 1) == Some(&b'/') {
                    state = State::Normal;
                    out.push(' ');
                    i += 2;
                    continue;
                }
                i += 1;
            }
            State::DollarQuote(tag) => {
                if ch == '$' && sql[i..].starts_with(tag.as_str()) {
                    i += tag.len();
                    state = State::Normal;
                    continue;
                }
                i += 1;
            }
        }
    }
    out
}

/// Parse `$<ident>?$` from the start of `s`. Returns the full tag
/// (`$tag$` or `$$`) when present, or `None` otherwise.
fn parse_dollar_tag(s: &str) -> Option<String> {
    // The leading `$` is bytes[0] == '$' guaranteed by caller.
    let bytes = s.as_bytes();
    if bytes.first() != Some(&b'$') {
        return None;
    }
    let mut end = 1;
    while let Some(&b) = bytes.get(end) {
        if b == b'$' {
            return s.get(..=end).map(str::to_string);
        }
        if !(b.is_ascii_alphanumeric() || b == b'_') {
            return None;
        }
        end += 1;
    }
    None
}

/// Emit every contiguous run of ASCII-alphabetic (plus `_`) as one
/// upper-cased token. Numbers and punctuation are boundaries.
fn tokenize(stripped: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    for ch in stripped.chars() {
        if ch.is_ascii_alphabetic() || ch == '_' {
            cur.push(ch.to_ascii_uppercase());
        } else {
            if !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
            }
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

    const DIALECTS: [SqlDialect; 2] = [SqlDialect::MySql, SqlDialect::Postgres];

    fn ok(sql: &str) {
        for dialect in DIALECTS {
            assert_eq!(
                validate_readonly_sql(sql, dialect),
                Ok(()),
                "should pass: {sql}"
            );
        }
    }
    fn rejected(sql: &str, matcher: impl Fn(&ReadonlyViolation) -> bool) {
        for dialect in DIALECTS {
            let r =
                validate_readonly_sql(sql, dialect).expect_err(&format!("should reject: {sql}"));
            assert!(matcher(&r), "wrong violation {r:?} for: {sql}");
        }
    }

    #[test]
    fn strings_follow_the_engine_escape_rules() {
        use SqlDialect::{MySql, Postgres};
        // Postgres ends the string at the quote after the backslash; MySQL does not.
        let sql = r"SELECT '\' ; DELETE FROM t; --'";
        assert!(validate_readonly_sql(sql, Postgres).is_err());
        assert_eq!(validate_readonly_sql(sql, MySql), Ok(()));
        let sql = r"SELECT '\' , ' ; DELETE FROM t; -- '";
        assert!(validate_readonly_sql(sql, MySql).is_err());
        let sql = r"SELECT E'\' , ' ; DELETE FROM t; -- '";
        assert!(validate_readonly_sql(sql, Postgres).is_err());
        let sql = r#"SELECT "\" , " , sleep(9) , ""#;
        assert!(validate_readonly_sql(sql, MySql).is_err());
    }

    #[test]
    fn mysql_comment_and_identifier_rules() {
        use SqlDialect::MySql;
        assert_eq!(
            validate_readonly_sql("SELECT 1 # DELETE FROM t", MySql),
            Ok(())
        );
        assert!(validate_readonly_sql("SELECT 1 # x\n, sleep(9)", MySql).is_err());
        assert!(validate_readonly_sql("SELECT 1 # x\n; DELETE FROM t", MySql).is_err());
        // `--` without a following space is arithmetic in MySQL, not a comment.
        assert!(validate_readonly_sql("SELECT 1 --sleep(9)", MySql).is_err());
        // `$` is an identifier character in MySQL, not a quote.
        assert!(validate_readonly_sql("SELECT 1 AS $a$ , sleep(9) AS $a$", MySql).is_err());
    }

    #[test]
    fn detects_statements_that_leave_a_readonly_session() {
        use SqlDialect::{MySql, Postgres};
        for sql in [
            "SET SESSION TRANSACTION READ WRITE",
            "set session transaction read  write",
            "START TRANSACTION READ WRITE",
            "SET @@session.tx_read_only = 0",
            "SET transaction_read_only = OFF",
            "SELECT 1; SET SESSION TRANSACTION READ /* x */ WRITE",
            "PREPARE s FROM @q",
            "SET GLOBAL read_only = 0",
            "SELECT 1 INTO OUTFILE '/tmp/x'",
            "FLUSH PRIVILEGES",
        ] {
            assert!(escapes_readonly_session(sql, MySql), "accepted: {sql}");
        }
        for sql in [
            "SET default_transaction_read_only = off",
            "BEGIN READ WRITE",
            "SET SESSION CHARACTERISTICS AS TRANSACTION READ WRITE",
            "RESET ALL",
            "DISCARD ALL",
            "SELECT set_config('default_transaction_' || 'read_only', 'off', false)",
            "DO $$ BEGIN EXECUTE 'SET x'; END $$",
            "SELECT 'default_transaction_read_only'",
        ] {
            assert!(escapes_readonly_session(sql, Postgres), "accepted: {sql}");
        }
        for sql in [
            "SELECT 1",
            "SET NAMES utf8mb4",
            "SET autocommit = 1",
            "BEGIN",
            "START TRANSACTION READ ONLY",
            "SHOW TABLES",
            "SELECT 'read write' AS note",
            "INSERT INTO t VALUES (1)",
        ] {
            assert!(!escapes_readonly_session(sql, MySql), "rejected: {sql}");
            assert!(!escapes_readonly_session(sql, Postgres), "rejected: {sql}");
        }
    }

    #[test]
    fn rejects_quoted_functions_and_select_into() {
        for sql in [
            r#"SELECT "pg_read_file"('/etc/hostname')"#,
            "SELECT 1 INTO audit_created_table",
            "SELECT /*!50000 SLEEP(5) */ 1",
            r#"SELECT U&"pg_\0072ead_file"('/etc/hostname')"#,
        ] {
            assert!(
                DIALECTS
                    .iter()
                    .all(|d| validate_readonly_sql(sql, *d).is_err()),
                "accepted: {sql}"
            );
        }
    }

    #[test]
    fn accepts_basic_selects() {
        ok("SELECT 1");
        ok("select 1");
        ok(" select 1 ");
        ok("SELECT * FROM t WHERE x = 1");
        ok("SELECT 1;");
        ok("SHOW TABLES");
        ok("EXPLAIN SELECT 1");
        ok("DESC t");
        ok("DESCRIBE t");
        ok("WITH x AS (SELECT 1) SELECT * FROM x");
        ok("-- leading comment\nSELECT 1");
        ok("/* leading */ SELECT 1");
    }

    #[test]
    fn rejects_prefix_writes() {
        rejected("UPDATE t SET x=1", |v| {
            matches!(v, ReadonlyViolation::NotReadOnly)
        });
        rejected("DELETE FROM t", |v| {
            matches!(v, ReadonlyViolation::NotReadOnly)
        });
        rejected("INSERT INTO t VALUES (1)", |v| {
            matches!(v, ReadonlyViolation::NotReadOnly)
        });
        rejected("DROP TABLE t", |v| {
            matches!(v, ReadonlyViolation::NotReadOnly)
        });
        rejected("CREATE TABLE t(x INT)", |v| {
            matches!(v, ReadonlyViolation::NotReadOnly)
        });
        rejected("ALTER TABLE t ADD COLUMN y INT", |v| {
            matches!(v, ReadonlyViolation::NotReadOnly)
        });
        rejected("TRUNCATE t", |v| {
            matches!(v, ReadonlyViolation::NotReadOnly)
        });
        rejected("GRANT SELECT ON t TO u", |v| {
            matches!(v, ReadonlyViolation::NotReadOnly)
        });
    }

    #[test]
    fn rejects_multi_statement() {
        rejected("SELECT 1; UPDATE t SET x=1", |v| {
            matches!(v, ReadonlyViolation::MultipleStatements)
        });
        rejected("SELECT 1; SELECT 2;", |v| {
            matches!(v, ReadonlyViolation::MultipleStatements)
        });
    }

    #[test]
    fn rejects_writable_cte() {
        rejected(
            "WITH w AS (DELETE FROM t RETURNING *) SELECT * FROM w",
            |v| matches!(v, ReadonlyViolation::WriteKeyword(k) if k == "DELETE"),
        );
        rejected(
            "WITH x AS (INSERT INTO t VALUES (1) RETURNING *) SELECT * FROM x",
            |v| matches!(v, ReadonlyViolation::WriteKeyword(k) if k == "INSERT"),
        );
    }

    #[test]
    fn rejects_dangerous_functions() {
        rejected(
            "SELECT pg_read_server_files('/etc/passwd')",
            |v| matches!(v, ReadonlyViolation::DangerousFunction(k) if k == "pg_read_server_files"),
        );
        rejected(
            "SELECT xp_cmdshell('whoami')",
            |v| matches!(v, ReadonlyViolation::DangerousFunction(k) if k == "xp_cmdshell"),
        );
        rejected(
            "SELECT load_file('/etc/passwd')",
            |v| matches!(v, ReadonlyViolation::DangerousFunction(k) if k == "load_file"),
        );
        rejected(
            "SELECT PG_SLEEP(10)",
            |v| matches!(v, ReadonlyViolation::DangerousFunction(k) if k == "pg_sleep"),
        );
    }

    #[test]
    fn comments_cannot_hide_writes() {
        // Write keyword inside a comment must be stripped and the
        // remaining statement honored.
        ok("/* UPDATE t SET x=1 */ SELECT 1");
        ok("SELECT 1 -- UPDATE t SET x=1\n");
    }

    #[test]
    fn strings_and_identifiers_are_stripped() {
        // Literal 'UPDATE' inside a string does not trip the check.
        ok("SELECT 'UPDATE t SET x=1' AS s");
        ok("SELECT \"UPDATE\" FROM t");
        assert_eq!(
            validate_readonly_sql("SELECT `UPDATE` FROM t", SqlDialect::MySql),
            Ok(())
        );
        assert_eq!(
            validate_readonly_sql(
                "SELECT $tag$ UPDATE t SET x=1 $tag$ AS doc",
                SqlDialect::Postgres
            ),
            Ok(())
        );
    }

    #[test]
    fn rejects_into_outfile_dumpfile() {
        // Read-only console must reject file-write exfiltration.
        rejected(
            "SELECT * FROM t INTO OUTFILE '/tmp/x'",
            |v| matches!(v, ReadonlyViolation::WriteKeyword(k) if k == "OUTFILE"),
        );
        rejected(
            "SELECT * INTO OUTFILE '/tmp/x' FROM t",
            |v| matches!(v, ReadonlyViolation::WriteKeyword(k) if k == "OUTFILE"),
        );
        rejected(
            "SELECT * FROM t INTO DUMPFILE '/tmp/x'",
            |v| matches!(v, ReadonlyViolation::WriteKeyword(k) if k == "DUMPFILE"),
        );
        // Column names containing the substring must not be false positives.
        ok("SELECT into_x FROM t");
        ok("SELECT outfile_path FROM t");
    }

    #[test]
    fn rejects_copy_from_program() {
        rejected("COPY t FROM PROGRAM 'whoami'", |v| {
            matches!(v, ReadonlyViolation::NotReadOnly)
        });
        rejected("SELECT 1; COPY t FROM PROGRAM 'whoami'", |v| {
            matches!(v, ReadonlyViolation::MultipleStatements)
        });
    }

    #[test]
    fn empty_returns_empty() {
        rejected("", |v| matches!(v, ReadonlyViolation::Empty));
        rejected("  \t\n", |v| matches!(v, ReadonlyViolation::Empty));
        rejected("-- only a comment", |v| {
            matches!(v, ReadonlyViolation::Empty)
        });
    }

    #[test]
    fn tokenizer_handles_schema_qualified() {
        // Without explicit handling the whole `pg_catalog.pg_tables`
        // splits into tokens "PG_CATALOG" and "PG_TABLES"; neither
        // is blacklisted so the query is accepted.
        ok("SELECT * FROM pg_catalog.pg_tables");
    }
}

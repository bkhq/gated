//! Integration with the lode supervisor (<https://lode.bk.io>).
//!
//! lode launches gated with `LODE_DIR`, `LODE_INSTANCE` and `LODE_READINESS`
//! set and talks to it through `$LODE_DIR/state.json`: lode writes its status
//! (`current`, `available`, `status`, …), gated writes requests (`ready`,
//! `check_nonce`, `target`, `restart_nonce`). The file is shared with lode, so
//! writes hold `state.json.lock` and replace the file atomically while keeping
//! every field lode wrote.

use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

use serde::Deserialize;
use serde_json::{Map, Value};
use tracing::*;

/// Report readiness to lode when it waits for it; a no-op otherwise.
pub fn mark_ready() {
    if std::env::var("LODE_READINESS").as_deref() != Ok("state") {
        return;
    }
    let (Ok(dir), Ok(instance)) = (std::env::var("LODE_DIR"), std::env::var("LODE_INSTANCE"))
    else {
        warn!("LODE_READINESS=state without LODE_DIR/LODE_INSTANCE; not reporting readiness");
        return;
    };
    match write_ready(Path::new(&dir), &instance) {
        Ok(()) => info!(%instance, "Reported readiness to lode"),
        Err(error) => error!(?error, "Failed to report readiness to lode"),
    }
}

fn write_ready(dir: &Path, instance: &str) -> io::Result<()> {
    modify(dir, |state| {
        state.insert("ready".into(), Value::String(instance.into()));
    })
    .map(|_| ())
}

/// lode's status as last written to `state.json`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct LodeState {
    pub current: Option<String>,
    pub last_good: Option<String>,
    pub available: Option<String>,
    /// `starting|running|held|updating|rolling-back|stopping|stopped|error`
    pub status: Option<String>,
    pub last_check: Option<String>,
    pub last_error: Option<String>,
    /// The highest `check_nonce` lode has answered.
    #[serde(default)]
    pub checked_nonce: u64,
    /// Why the last requested check failed.
    pub check_error: Option<String>,
}

/// The lode instance supervising this process.
#[derive(Debug, Clone)]
pub struct Supervisor {
    dir: PathBuf,
    instance: String,
}

/// The supervising lode instance, when gated runs under lode.
pub fn supervisor() -> Option<Supervisor> {
    let dir = std::env::var_os("LODE_DIR")?;
    let instance = std::env::var("LODE_INSTANCE").ok()?;
    Some(Supervisor::new(dir, instance))
}

impl Supervisor {
    pub fn new(dir: impl Into<PathBuf>, instance: impl Into<String>) -> Self {
        Self {
            dir: dir.into(),
            instance: instance.into(),
        }
    }

    pub fn instance(&self) -> &str {
        &self.instance
    }

    /// lode's current status; empty before lode first writes the file.
    pub fn state(&self) -> io::Result<LodeState> {
        match fs::read(self.dir.join("state.json")) {
            Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(LodeState::default()),
            Err(error) => Err(error),
        }
    }

    /// Ask lode to check for a newer version now. Returns the nonce that
    /// `checked_nonce` reaches once the check is done.
    pub fn request_check(&self) -> io::Result<u64> {
        bump(&self.dir, "check_nonce")
    }

    /// Ask lode to switch to `version`.
    pub fn request_update(&self, version: &str) -> io::Result<()> {
        modify(&self.dir, |state| {
            state.insert("target".into(), Value::String(version.into()));
        })
        .map(|_| ())
    }

    /// Ask lode to restart the current version.
    pub fn request_restart(&self) -> io::Result<u64> {
        bump(&self.dir, "restart_nonce")
    }
}

fn bump(dir: &Path, field: &str) -> io::Result<u64> {
    let state = modify(dir, |state| {
        let next = state.get(field).and_then(Value::as_u64).unwrap_or(0) + 1;
        state.insert(field.into(), Value::from(next));
    })?;
    Ok(state.get(field).and_then(Value::as_u64).unwrap_or(0))
}

/// Read-modify-write `state.json` under `state.json.lock`, keeping every
/// field lode wrote.
fn modify(
    dir: &Path,
    edit: impl FnOnce(&mut Map<String, Value>),
) -> io::Result<Map<String, Value>> {
    let lock = File::create(dir.join("state.json.lock"))?;
    lock.lock()?;

    let path = dir.join("state.json");
    let mut state = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<Map<String, Value>>(&bytes)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => Map::new(),
        Err(error) => return Err(error),
    };
    edit(&mut state);

    let tmp = dir.join(format!("state.json.tmp.{}", std::process::id()));
    fs::write(&tmp, serde_json::to_vec_pretty(&state)?)?;
    fs::rename(&tmp, &path)?;
    Ok(state)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("gated-lode-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).expect("create temp dir");
        dir
    }

    fn read_raw(dir: &Path) -> Value {
        serde_json::from_slice(&fs::read(dir.join("state.json")).expect("read")).expect("json")
    }

    #[test]
    fn ready_keeps_lode_fields() {
        let dir = temp_dir("keep");
        fs::write(
            dir.join("state.json"),
            r#"{"current":"1.2.0","status":"observing","future_field":1}"#,
        )
        .expect("seed state");

        write_ready(&dir, "42-abc").expect("write ready");

        let state = read_raw(&dir);
        assert_eq!(state["ready"], "42-abc");
        assert_eq!(state["current"], "1.2.0");
        assert_eq!(state["status"], "observing");
        assert_eq!(state["future_field"], 1);
    }

    #[test]
    fn ready_creates_missing_state() {
        let dir = temp_dir("missing");
        write_ready(&dir, "7-x").expect("write ready");
        assert_eq!(read_raw(&dir)["ready"], "7-x");
    }

    #[test]
    fn state_reads_lode_status_and_defaults_when_absent() {
        let dir = temp_dir("state");
        let lode = Supervisor::new(&dir, "1-a");
        assert_eq!(lode.state().expect("empty state"), LodeState::default());

        fs::write(
            dir.join("state.json"),
            r#"{"current":"0.23.0","available":"0.24.0","status":"running",
                "checked_nonce":3,"history":[{"version":"0.23.0"}],"pid":7}"#,
        )
        .expect("seed state");
        let state = lode.state().expect("state");
        assert_eq!(state.current.as_deref(), Some("0.23.0"));
        assert_eq!(state.available.as_deref(), Some("0.24.0"));
        assert_eq!(state.status.as_deref(), Some("running"));
        assert_eq!(state.checked_nonce, 3);
    }

    #[test]
    fn requests_bump_nonces_and_set_target_without_touching_lode_fields() {
        let dir = temp_dir("requests");
        fs::write(
            dir.join("state.json"),
            r#"{"current":"0.23.0","check_nonce":4,"ready":"1-a"}"#,
        )
        .expect("seed state");
        let lode = Supervisor::new(&dir, "1-a");

        assert_eq!(lode.request_check().expect("check"), 5);
        assert_eq!(lode.request_restart().expect("restart"), 1);
        assert_eq!(lode.request_restart().expect("restart"), 2);
        lode.request_update("0.24.0").expect("update");

        let state = read_raw(&dir);
        assert_eq!(state["check_nonce"], 5);
        assert_eq!(state["restart_nonce"], 2);
        assert_eq!(state["target"], "0.24.0");
        assert_eq!(state["current"], "0.23.0");
        assert_eq!(state["ready"], "1-a");
    }
}

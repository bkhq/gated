//! Integration with the lode supervisor (<https://lode.bk.io>).
//!
//! lode launches gated with `LODE_DIR`, `LODE_INSTANCE` and `LODE_READINESS`
//! set. With `readiness = "state"` it commits a new version only after the
//! app writes its instance id to `ready` in `$LODE_DIR/state.json`. The file
//! is shared with lode, so writes hold `state.json.lock` and replace the file
//! atomically while keeping every field lode wrote.

use std::fs::{self, File};
use std::io;
use std::path::Path;

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
    let lock = File::create(dir.join("state.json.lock"))?;
    lock.lock()?;

    let path = dir.join("state.json");
    let mut state = match fs::read(&path) {
        Ok(bytes) => serde_json::from_slice::<Map<String, Value>>(&bytes)?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => Map::new(),
        Err(error) => return Err(error),
    };
    state.insert("ready".into(), Value::String(instance.into()));

    let tmp = dir.join(format!("state.json.tmp.{}", std::process::id()));
    fs::write(&tmp, serde_json::to_vec_pretty(&state)?)?;
    fs::rename(&tmp, &path)
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

    #[test]
    fn ready_keeps_lode_fields() {
        let dir = temp_dir("keep");
        fs::write(
            dir.join("state.json"),
            r#"{"current":"1.2.0","status":"observing","future_field":1}"#,
        )
        .expect("seed state");

        write_ready(&dir, "42-abc").expect("write ready");

        let state: Value =
            serde_json::from_slice(&fs::read(dir.join("state.json")).expect("read")).expect("json");
        assert_eq!(state["ready"], "42-abc");
        assert_eq!(state["current"], "1.2.0");
        assert_eq!(state["status"], "observing");
        assert_eq!(state["future_field"], 1);
    }

    #[test]
    fn ready_creates_missing_state() {
        let dir = temp_dir("missing");
        write_ready(&dir, "7-x").expect("write ready");
        let state: Value =
            serde_json::from_slice(&fs::read(dir.join("state.json")).expect("read")).expect("json");
        assert_eq!(state["ready"], "7-x");
    }
}

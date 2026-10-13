use std::os::unix::prelude::PermissionsExt;
use std::path::Path;

use tracing::*;

fn maybe_apply_permissions<P: AsRef<Path>>(
    path: P,
    permissions: std::fs::Permissions,
) -> std::io::Result<()> {
    let current = std::fs::metadata(&path)?.permissions();
    if (current.mode() & 0o777) != permissions.mode() {
        std::fs::set_permissions(path, permissions)?;
    }
    Ok(())
}

fn warn_failure(e: &std::io::Error) {
    error!("Warning: failed to tighten file permissions: {}", e);
    error!(
        "If you are managing file permissions externally and do not need Gated to change them, you can pass --skip-securing-files"
    )
}

pub fn secure_directory<P: AsRef<Path>>(path: P) -> std::io::Result<()> {
    maybe_apply_permissions(path.as_ref(), std::fs::Permissions::from_mode(0o700))
        .inspect_err(warn_failure)
}

pub fn secure_file<P: AsRef<Path>>(path: P) -> std::io::Result<()> {
    maybe_apply_permissions(path.as_ref(), std::fs::Permissions::from_mode(0o600))
        .inspect_err(warn_failure)
}

/// Tighten a file to `0o600` and then verify it is actually safe, failing
/// closed otherwise.
///
/// Unlike [`secure_file`], a "could not tighten" error is not the only way this
/// fails: even if tightening reports success (or was skipped), the file's final
/// mode is re-checked, and if it is still group- or world-accessible (e.g. it
/// is owned by another user and could not be modified) an error is returned so
/// callers can refuse to read secrets from an insecure file rather than
/// reading them anyway.
pub fn ensure_file_secure<P: AsRef<Path>>(path: P) -> std::io::Result<()> {
    let path = path.as_ref();
    maybe_apply_permissions(path, std::fs::Permissions::from_mode(0o600))
        .inspect_err(warn_failure)?;

    let mode = std::fs::metadata(path)?.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        error!(
            "Refusing to use group/world-accessible file {} (mode {:#o}). Secure it to 0o600, or pass --skip-securing-files if you manage permissions externally.",
            path.display(),
            mode
        );
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "file {} has insecure permissions {:#o} and could not be secured",
                path.display(),
                mode
            ),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ensure_file_secure_tightens_open_perms() {
        let dir = std::env::temp_dir().join(format!("gated-fs-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("open.conf");
        std::fs::write(&path, b"secret").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();

        // Owner can tighten 0o644 -> 0o600, so this succeeds and leaves the
        // file secure.
        ensure_file_secure(&path).unwrap();
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);

        std::fs::remove_file(&path).ok();
        std::fs::remove_dir(&dir).ok();
    }

    #[test]
    fn ensure_file_secure_accepts_already_secure() {
        let dir = std::env::temp_dir().join(format!("gated-fs-test2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("locked.conf");
        std::fs::write(&path, b"secret").unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();

        ensure_file_secure(&path).unwrap();

        std::fs::remove_file(&path).ok();
        std::fs::remove_dir(&dir).ok();
    }
}

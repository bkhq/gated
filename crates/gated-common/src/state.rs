use std::path::{Path, PathBuf};

use anyhow::Context;

/// Name of the config file inside a `--data-dir`.
pub const DATA_DIR_CONFIG_FILE: &str = "config.yaml";

#[derive(Clone)]
pub struct GlobalParams {
    config_path: PathBuf,
    should_secure_files: bool,
    paths_relative_to: PathBuf,
    data_dir: Option<PathBuf>,
}

impl GlobalParams {
    pub fn new(config_path: PathBuf, should_secure_files: bool) -> anyhow::Result<Self> {
        Ok(Self {
            paths_relative_to: config_path
                .parent()
                .context("Failed to determine config parent directory")?
                .to_path_buf(),
            config_path,
            should_secure_files,
            data_dir: None,
        })
    }

    /// Everything lives in `data_dir`: the config defaults to
    /// `<data_dir>/config.yaml` and relative paths resolve against `data_dir`.
    pub fn with_data_dir(
        data_dir: &Path,
        config_path: Option<PathBuf>,
        should_secure_files: bool,
    ) -> anyhow::Result<Self> {
        let data_dir = std::path::absolute(data_dir).context("Failed to resolve data directory")?;
        Ok(Self {
            config_path: config_path.unwrap_or_else(|| data_dir.join(DATA_DIR_CONFIG_FILE)),
            should_secure_files,
            paths_relative_to: data_dir.clone(),
            data_dir: Some(data_dir),
        })
    }

    pub fn config_path(&self) -> &PathBuf {
        &self.config_path
    }

    pub fn paths_relative_to(&self) -> &PathBuf {
        &self.paths_relative_to
    }

    /// Whether `--data-dir` was given.
    pub fn has_data_dir(&self) -> bool {
        self.data_dir.is_some()
    }

    /// Directory for state that has no config option (encryption metadata,
    /// the bootstrap token): `--data-dir`, else `data/` next to the config.
    pub fn data_dir(&self) -> PathBuf {
        self.data_dir
            .clone()
            .unwrap_or_else(|| self.paths_relative_to.join("data"))
    }

    pub fn encryption_dir(&self) -> PathBuf {
        self.data_dir().join("encryption")
    }

    pub fn should_secure_files(&self) -> bool {
        self.should_secure_files
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn without_data_dir_paths_follow_the_config_file() {
        let params = GlobalParams::new("/etc/gated/gated.yaml".into(), false).unwrap();
        assert_eq!(params.paths_relative_to(), Path::new("/etc/gated"));
        assert_eq!(
            params.encryption_dir(),
            Path::new("/etc/gated/data/encryption")
        );
        assert!(!params.has_data_dir());
    }

    #[test]
    fn data_dir_holds_the_config_and_all_state() {
        let params = GlobalParams::with_data_dir(Path::new("/var/lib/gated"), None, false).unwrap();
        assert_eq!(
            params.config_path(),
            Path::new("/var/lib/gated/config.yaml")
        );
        assert_eq!(params.paths_relative_to(), Path::new("/var/lib/gated"));
        assert_eq!(
            params.encryption_dir(),
            Path::new("/var/lib/gated/encryption")
        );
        assert!(params.has_data_dir());
    }

    #[test]
    fn explicit_config_keeps_paths_in_the_data_dir() {
        let params = GlobalParams::with_data_dir(
            Path::new("/var/lib/gated"),
            Some("/etc/gated.yaml".into()),
            false,
        )
        .unwrap();
        assert_eq!(params.config_path(), Path::new("/etc/gated.yaml"));
        assert_eq!(params.paths_relative_to(), Path::new("/var/lib/gated"));
    }

    #[test]
    fn relative_data_dir_is_made_absolute() {
        let params = GlobalParams::with_data_dir(Path::new("data"), None, false).unwrap();
        assert!(params.paths_relative_to().is_absolute());
        assert!(params.config_path().ends_with("data/config.yaml"));
    }
}

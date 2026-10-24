use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use tracing::{info, warn};

#[derive(Clone, Debug)]
pub struct BootstrapToken {
    digest: [u8; 32],
    file_path: Option<PathBuf>,
}

impl BootstrapToken {
    #[doc(hidden)]
    pub fn from_token_for_tests(token: &str, file_path: Option<PathBuf>) -> Self {
        Self {
            digest: Sha256::digest(token.as_bytes()).into(),
            file_path,
        }
    }

    pub fn verify(&self, token: &str) -> bool {
        let digest = Sha256::digest(token.as_bytes());
        self.digest.ct_eq(digest.as_slice()).into()
    }

    pub async fn delete_file(&self) -> Result<()> {
        let Some(path) = &self.file_path else {
            return Ok(());
        };
        match tokio::fs::remove_file(path).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(error).context("failed to delete bootstrap token file"),
        }
    }
}

pub fn generate_bootstrap_token(data_dir: &Path) -> Result<BootstrapToken> {
    let mut raw = [0_u8; 32];
    OsRng.fill_bytes(&mut raw);
    let token = hex::encode(raw);
    let digest = Sha256::digest(token.as_bytes()).into();

    if write_tty(&token).is_ok() {
        info!("Encryption bootstrap token was written to /dev/tty");
        return Ok(BootstrapToken {
            digest,
            file_path: None,
        });
    }

    let dir = data_dir.join("db");
    std::fs::create_dir_all(&dir).context("failed to create bootstrap token directory")?;
    let path = dir.join("bootstrap-token.txt");
    write_secret_file(&path, &token)?;
    info!(
        path = %path.display(),
        "Encryption bootstrap token was written to a local file"
    );
    Ok(BootstrapToken {
        digest,
        file_path: Some(path),
    })
}

fn write_tty(token: &str) -> Result<()> {
    use std::io::Write;

    let mut tty = std::fs::OpenOptions::new()
        .write(true)
        .open("/dev/tty")
        .context("open /dev/tty")?;
    writeln!(tty, "\nGated encryption bootstrap token:\n{token}\n")
        .context("write bootstrap token to /dev/tty")?;
    Ok(())
}

fn write_secret_file(path: &Path, token: &str) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        let mut options = std::fs::OpenOptions::new();
        options.write(true).create(true).truncate(true).mode(0o600);
        std::io::Write::write_all(&mut options.open(path)?, token.as_bytes())?;
    }

    #[cfg(not(unix))]
    {
        std::fs::write(path, token)?;
        warn!("bootstrap token file permissions are not hardened on this platform");
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }

    warn!(
        path = %path.display(),
        "Use this token once to initialize encryption; the file will be deleted after init"
    );
    Ok(())
}

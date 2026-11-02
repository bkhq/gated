use chrono::{DateTime, Utc};
use gated_common::GatedError;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use gated_core::Services;
use gated_protocol_ssh::KeyKind;
use russh::keys::{HashAlg, PrivateKey, PublicKeyBase64, decode_secret_key};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;

#[derive(Serialize, ToSchema)]
struct SSHKey {
    pub kind: String,
    pub public_key_base64: String,
}

api_response! {
    enum GetSSHOwnKeysResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<SSHKey>>),
    }
}

#[utoipa::path(get, path = "/ssh/own-keys", operation_id = "get_ssh_own_keys")]
async fn api_ssh_get_own_keys(
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetSSHOwnKeysResponse, GatedError> {
    let db = services.db_required().await?;
    let keys = gated_protocol_ssh::load_keys(&db, gated_protocol_ssh::KeyKind::Client).await?;

    let keys = keys
        .into_iter()
        .map(|k| SSHKey {
            kind: k.algorithm().to_string(),
            public_key_base64: k.public_key_base64(),
        })
        .collect();
    Ok(GetSSHOwnKeysResponse::Ok(Json(keys)))
}

#[derive(Serialize, Deserialize, ToSchema, Clone, Copy)]
#[serde(rename_all = "lowercase")]
enum SSHKeyKind {
    /// Presented to SSH clients connecting to gated.
    Host,
    /// Used to authenticate to SSH targets.
    Client,
}

impl From<SSHKeyKind> for KeyKind {
    fn from(kind: SSHKeyKind) -> Self {
        match kind {
            SSHKeyKind::Host => KeyKind::Host,
            SSHKeyKind::Client => KeyKind::Client,
        }
    }
}

#[derive(Serialize, ToSchema)]
struct StoredSSHKey {
    id: Uuid,
    kind: String,
    algorithm: String,
    public_key_openssh: String,
    fingerprint: String,
    created: DateTime<Utc>,
}

fn stored_key(row: gated_db_entities::SshKey::Model, key: &PrivateKey) -> StoredSSHKey {
    StoredSSHKey {
        id: row.id,
        kind: row.kind,
        algorithm: row.algorithm,
        public_key_openssh: key.public_key().to_openssh().unwrap_or_default(),
        fingerprint: key.public_key().fingerprint(HashAlg::Sha256).to_string(),
        created: row.created,
    }
}

async fn stored_keys(services: &Services) -> Result<Vec<StoredSSHKey>, GatedError> {
    let db = services.db_required().await?;
    Ok(gated_protocol_ssh::list_keys(&db)
        .await?
        .into_iter()
        .map(|(row, key)| stored_key(row, &key))
        .collect())
}

api_response! {
    enum GetSSHKeysResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<StoredSSHKey>>),
    }
}

/// The gateway's stored SSH host and client keys (public parts only).
#[utoipa::path(get, path = "/ssh/keys", operation_id = "get_ssh_keys")]
async fn api_ssh_get_keys(
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetSSHKeysResponse, GatedError> {
    Ok(GetSSHKeysResponse::Ok(Json(stored_keys(&services).await?)))
}

/// Generates Ed25519 and RSA keys for each kind (host, client) that has no
/// keys yet. Existing keys are kept.
#[utoipa::path(post, path = "/ssh/keys/generate", operation_id = "generate_ssh_keys")]
async fn api_ssh_generate_keys(
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetSSHKeysResponse, GatedError> {
    let db = services.db_required().await?;
    if gated_protocol_ssh::generate_keys(&db).await? {
        services.ssh_keys_ready.notify_one();
    }
    Ok(GetSSHKeysResponse::Ok(Json(stored_keys(&services).await?)))
}

#[derive(Deserialize, ToSchema)]
struct ImportSSHKeyRequest {
    kind: SSHKeyKind,
    /// OpenSSH or PKCS#8 PEM private key.
    private_key_pem: String,
    /// Passphrase of an encrypted key; the key is stored decrypted, protected
    /// by the database encryption when it is enabled.
    passphrase: Option<String>,
}

api_response! {
    enum ImportSSHKeyResponse {
        #[oai(status = 200)]
        Ok(Json<StoredSSHKey>),

        #[oai(status = 400)]
        BadRequest(Json<String>),
    }
}

/// Stores a private key of the given kind, replacing a stored key with the
/// same algorithm.
#[utoipa::path(post, path = "/ssh/keys/import", operation_id = "import_ssh_key")]
async fn api_ssh_import_key(
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
    body: Json<ImportSSHKeyRequest>,
) -> Result<ImportSSHKeyResponse, GatedError> {
    let key = match decode_secret_key(body.private_key_pem.trim(), body.passphrase.as_deref()) {
        Ok(key) => key,
        Err(error) => {
            return Ok(ImportSSHKeyResponse::BadRequest(Json(format!(
                "invalid private key: {error}"
            ))));
        }
    };
    let db = services.db_required().await?;
    let row = gated_protocol_ssh::import_key(&db, body.kind.into(), &key).await?;
    if matches!(body.kind, SSHKeyKind::Host) {
        services.ssh_keys_ready.notify_one();
    }
    Ok(ImportSSHKeyResponse::Ok(Json(stored_key(row, &key))))
}

pub fn router() -> OpenApiRouter {
    api_routes!(
        api_ssh_get_own_keys,
        api_ssh_get_keys,
        api_ssh_generate_keys,
        api_ssh_import_key,
    )
}

#[cfg(test)]
mod tests {
    use gated_common::{GatedConfig, GlobalParams, Secret};
    use gated_protocol_ssh::{generate_keys, import_key, list_keys, load_keys};
    use russh::keys::Algorithm;

    use super::*;

    async fn test_db() -> (Services, sea_orm::DatabaseConnection) {
        let root = std::env::temp_dir().join(format!("gated-ssh-keys-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp root");
        let config_path = root.join("config.yaml");
        std::fs::write(&config_path, "").expect("write config");
        let mut config = GatedConfig {
            store: Default::default(),
        };
        config.store.database_url = Secret::new("sqlite:data/db".to_owned());
        let params = GlobalParams::new(config_path, false).expect("global params");
        let services = Services::new(config, None, params, None)
            .await
            .expect("services");
        services.open_db_legacy().await.expect("open db");
        let db = services.db_required().await.expect("db");
        (services, db)
    }

    fn random_key(algorithm: Algorithm) -> PrivateKey {
        PrivateKey::random(&mut russh::keys::key::safe_rng(), algorithm).expect("key")
    }

    #[tokio::test]
    async fn generate_fills_only_missing_kinds_and_import_replaces_same_algorithm() {
        let (services, db) = test_db().await;
        assert!(
            load_keys(&db, KeyKind::Host)
                .await
                .expect("load")
                .is_empty()
        );

        // An imported client key keeps generation from touching client keys.
        let imported = random_key(Algorithm::Ed25519);
        import_key(&db, KeyKind::Client, &imported)
            .await
            .expect("import");
        assert!(generate_keys(&db).await.expect("generate"));
        assert_eq!(load_keys(&db, KeyKind::Host).await.expect("load").len(), 2);
        let client = load_keys(&db, KeyKind::Client).await.expect("load");
        assert_eq!(client.len(), 1);
        assert_eq!(client[0].public_key(), imported.public_key());

        // Nothing is missing any more.
        assert!(!generate_keys(&db).await.expect("generate"));

        // Importing a host Ed25519 key replaces the generated one.
        let host = random_key(Algorithm::Ed25519);
        import_key(&db, KeyKind::Host, &host).await.expect("import");
        let hosts = load_keys(&db, KeyKind::Host).await.expect("load");
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].public_key(), host.public_key());
        assert_eq!(list_keys(&db).await.expect("list").len(), 3);

        services.close_db().await;
    }
}

use chrono::{DateTime, Utc};
use gated_common::GatedError;
use gated_common::helpers::pem::normalize_pem;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use gated_core::Services;
use russh::keys::{HashAlg, PrivateKey, decode_secret_key};
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;

/// A stored SSH host key (public part).
#[derive(Serialize, ToSchema)]
struct StoredSSHKey {
    id: Uuid,
    algorithm: String,
    public_key_openssh: String,
    fingerprint: String,
    created: DateTime<Utc>,
}

fn stored_key(row: gated_db_entities::SshKey::Model, key: &PrivateKey) -> StoredSSHKey {
    StoredSSHKey {
        id: row.id,
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

/// The gateway's stored SSH host keys (public parts only).
#[utoipa::path(get, path = "/ssh/keys", operation_id = "get_ssh_keys")]
async fn api_ssh_get_keys(
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetSSHKeysResponse, GatedError> {
    Ok(GetSSHKeysResponse::Ok(Json(stored_keys(&services).await?)))
}

/// Generates Ed25519 and RSA host keys unless host keys exist, and starts
/// the SSH listener.
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

/// Stores a host key, replacing a stored host key with the same algorithm.
#[utoipa::path(post, path = "/ssh/keys/import", operation_id = "import_ssh_key")]
async fn api_ssh_import_key(
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
    body: Json<ImportSSHKeyRequest>,
) -> Result<ImportSSHKeyResponse, GatedError> {
    let pem = normalize_pem(&body.private_key_pem);
    let key = match decode_secret_key(&pem, body.passphrase.as_deref()) {
        Ok(key) => key,
        Err(error) => {
            return Ok(ImportSSHKeyResponse::BadRequest(Json(format!(
                "invalid private key: {error}"
            ))));
        }
    };
    let db = services.db_required().await?;
    let row = gated_protocol_ssh::import_key(&db, &key).await?;
    services.ssh_keys_ready.notify_one();
    Ok(ImportSSHKeyResponse::Ok(Json(stored_key(row, &key))))
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_ssh_get_keys, api_ssh_generate_keys, api_ssh_import_key)
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
    async fn generate_creates_host_keys_once_and_import_replaces_same_algorithm() {
        let (services, db) = test_db().await;
        assert!(load_keys(&db).await.expect("load").is_empty());

        assert!(generate_keys(&db).await.expect("generate"));
        assert_eq!(load_keys(&db).await.expect("load").len(), 2);
        assert!(!generate_keys(&db).await.expect("generate"));

        // Importing an Ed25519 key replaces the generated one.
        let host = random_key(Algorithm::Ed25519);
        import_key(&db, &host).await.expect("import");
        let hosts = load_keys(&db).await.expect("load");
        assert_eq!(hosts.len(), 2);
        assert_eq!(hosts[0].public_key(), host.public_key());
        assert_eq!(list_keys(&db).await.expect("list").len(), 2);

        services.close_db().await;
    }
}

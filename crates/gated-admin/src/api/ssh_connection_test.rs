use gated_common::web::{Data, Json, PlainText};
use gated_common::{GatedError, SSHTargetAuth, SshTargetPasswordAuth, TargetSSHOptions};
use gated_common::{api_response, api_routes};
use gated_core::Services;
use gated_protocol_ssh::{RCCommand, RCEvent, RemoteClient};
use russh::keys::PublicKeyBase64;
use serde::{Deserialize, Serialize};
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;

#[derive(Deserialize, ToSchema)]
struct CheckSshHostKeyRequest {
    host: String,
    port: u16,
}

#[derive(Serialize, ToSchema)]
struct CheckSshHostKeyResponseBody {
    remote_key_type: String,
    remote_key_base64: String,
}

api_response! {
    enum CheckSshHostKeyResponse {
        #[oai(status = 200)]
        Ok(Json<CheckSshHostKeyResponseBody>),
        #[oai(status = 500)]
        Error(PlainText<String>),
    }
}

#[utoipa::path(
    post,
    path = "/ssh/check-host-key",
    operation_id = "check_ssh_host_key"
)]
async fn api_ssh_check_host_key(
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
    body: Json<CheckSshHostKeyRequest>,
) -> Result<CheckSshHostKeyResponse, GatedError> {
    let mut handles = RemoteClient::create(Uuid::new_v4(), services.0.clone())?;

    let _ = handles.command_tx.send((
        RCCommand::Connect(TargetSSHOptions {
            host: body.host.clone(),
            port: body.port,
            username: "".into(),
            allow_insecure_algos: None,
            auth: SSHTargetAuth::Password(SshTargetPasswordAuth {
                password: "".to_string().into(),
            }),
        }),
        None,
    ));

    let fut = async move {
        let key = loop {
            match handles.event_rx.recv().await {
                Some(RCEvent::HostKeyReceived(key)) => break key,
                Some(RCEvent::ConnectionError(err)) => return Err(anyhow::Error::from(err)),
                Some(RCEvent::Error(err)) => return Err(err),
                None => anyhow::bail!("Failed to connect to target"),
                _ => (),
            }
        };
        anyhow::Ok(key)
    };

    // Result is matched manually since we need to manually format
    // the error message with :# to included the nested errors here
    match fut.await {
        Ok(key) => Ok(CheckSshHostKeyResponse::Ok(Json(
            CheckSshHostKeyResponseBody {
                remote_key_type: key.algorithm().as_str().into(),
                remote_key_base64: key.public_key_base64(),
            },
        ))),
        Err(err) => Ok(CheckSshHostKeyResponse::Error(PlainText(format!(
            "{err:#}"
        )))),
    }
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_ssh_check_host_key,)
}

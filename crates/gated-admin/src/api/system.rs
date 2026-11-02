//! Gateway lifecycle backed by the lode supervisor: update status, update
//! check, update and restart. Every endpoint answers `409` when gated does
//! not run under lode.

use chrono::Utc;
use gated_common::web::{Data, Json};
use gated_common::{GatedError, api_response, api_routes};
use gated_core::Services;
use gated_core::lode;
use gated_db_entities::ManagementAudit;
use sea_orm::{ActiveModelTrait, ConnectionTrait, Set};
use serde::{Deserialize, Serialize};
use serde_json::json;
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;
use super::accounts::{StepUp, StepUpFailure, require_step_up};
use super::reveal_guard::RevealConfirmation;
use crate::http_service::common::RequestAuthorization;
use crate::http_service::session::Session;

#[derive(Serialize, ToSchema)]
struct UpdateStatus {
    /// True when gated runs under lode; every other field is null otherwise.
    supervised: bool,
    instance: Option<String>,
    current: Option<String>,
    last_good: Option<String>,
    /// Newer version found by the last check.
    available: Option<String>,
    /// lode status: `starting|running|held|updating|rolling-back|stopping|stopped|error`.
    status: Option<String>,
    last_check: Option<String>,
    last_error: Option<String>,
    /// The highest update check lode has answered.
    checked_nonce: u64,
    /// Why the last update check failed.
    check_error: Option<String>,
}

#[derive(Serialize, ToSchema)]
struct UpdateCheck {
    /// The check is done once `checked_nonce` reaches this value.
    nonce: u64,
}

/// Password or OTP confirmation; may be omitted while the browser session's
/// step-up window is open.
#[derive(Deserialize, ToSchema)]
struct LifecycleRequest {
    /// Version to switch to; defaults to the available update.
    version: Option<String>,
    password: Option<String>,
    otp: Option<String>,
    reason: Option<String>,
}

impl LifecycleRequest {
    fn confirmation(&self) -> RevealConfirmation {
        RevealConfirmation {
            reason: self.reason.clone(),
            password: self.password.clone(),
            otp: self.otp.clone(),
        }
    }
}

api_response! {
    enum GetUpdateStatusResponse {
        #[oai(status = 200)]
        Ok(Json<UpdateStatus>),
    }
}

api_response! {
    enum CheckUpdateResponse {
        #[oai(status = 202)]
        Accepted(Json<UpdateCheck>),
        #[oai(status = 409)]
        NotSupervised,
    }
}

api_response! {
    enum LifecycleResponse {
        #[oai(status = 202)]
        Accepted,
        #[oai(status = 400)]
        BadRequest(Json<String>),
        #[oai(status = 401)]
        Unauthorized,
        #[oai(status = 409)]
        NotSupervised,
        #[oai(status = 429)]
        RateLimited,
    }
}

#[utoipa::path(get, path = "/system/update", operation_id = "get_update_status")]
async fn api_get_update_status(
    _sec_scheme: AnySecurityScheme,
) -> Result<GetUpdateStatusResponse, GatedError> {
    let Some(lode) = lode::supervisor() else {
        return Ok(GetUpdateStatusResponse::Ok(Json(UpdateStatus {
            supervised: false,
            instance: None,
            current: None,
            last_good: None,
            available: None,
            status: None,
            last_check: None,
            last_error: None,
            checked_nonce: 0,
            check_error: None,
        })));
    };
    let state = lode.state().map_err(GatedError::other)?;
    Ok(GetUpdateStatusResponse::Ok(Json(UpdateStatus {
        supervised: true,
        instance: Some(lode.instance().to_owned()),
        current: state.current,
        last_good: state.last_good,
        available: state.available,
        status: state.status,
        last_check: state.last_check,
        last_error: state.last_error,
        checked_nonce: state.checked_nonce,
        check_error: state.check_error,
    })))
}

#[utoipa::path(post, path = "/system/update/check", operation_id = "check_for_update")]
async fn api_check_for_update(
    _sec_scheme: AnySecurityScheme,
) -> Result<CheckUpdateResponse, GatedError> {
    let Some(lode) = lode::supervisor() else {
        return Ok(CheckUpdateResponse::NotSupervised);
    };
    let nonce = lode.request_check().map_err(GatedError::other)?;
    Ok(CheckUpdateResponse::Accepted(Json(UpdateCheck { nonce })))
}

#[utoipa::path(post, path = "/system/update", operation_id = "apply_update")]
async fn api_apply_update(
    services: Data<Services>,
    auth: Data<RequestAuthorization>,
    session: Session,
    _sec_scheme: AnySecurityScheme,
    body: Json<LifecycleRequest>,
) -> Result<LifecycleResponse, GatedError> {
    let Some(lode) = lode::supervisor() else {
        return Ok(LifecycleResponse::NotSupervised);
    };
    let version = match body.version.as_deref().map(str::trim) {
        Some(version) if !version.is_empty() => version.to_owned(),
        _ => match lode.state().map_err(GatedError::other)?.available {
            Some(available) => available,
            None => {
                return Ok(LifecycleResponse::BadRequest(Json(
                    "no update is available".into(),
                )));
            }
        },
    };
    let db = services.db_required().await?;
    let step_up = match confirm(&services, &db, &auth, &session, &body).await? {
        Ok(step_up) => step_up,
        Err(response) => return Ok(response),
    };
    insert_audit(&db, &auth, step_up, "system.update", Some(&version)).await?;
    lode.request_update(&version).map_err(GatedError::other)?;
    Ok(LifecycleResponse::Accepted)
}

#[utoipa::path(post, path = "/system/restart", operation_id = "restart_gateway")]
async fn api_restart(
    services: Data<Services>,
    auth: Data<RequestAuthorization>,
    session: Session,
    _sec_scheme: AnySecurityScheme,
    body: Json<LifecycleRequest>,
) -> Result<LifecycleResponse, GatedError> {
    let Some(lode) = lode::supervisor() else {
        return Ok(LifecycleResponse::NotSupervised);
    };
    let db = services.db_required().await?;
    let step_up = match confirm(&services, &db, &auth, &session, &body).await? {
        Ok(step_up) => step_up,
        Err(response) => return Ok(response),
    };
    insert_audit(&db, &auth, step_up, "system.restart", None).await?;
    lode.request_restart().map_err(GatedError::other)?;
    Ok(LifecycleResponse::Accepted)
}

async fn confirm(
    services: &Services,
    db: &impl ConnectionTrait,
    auth: &RequestAuthorization,
    session: &Session,
    body: &LifecycleRequest,
) -> Result<Result<Option<StepUp>, LifecycleResponse>, GatedError> {
    Ok(
        match require_step_up(auth, session, services, db, 0, Some(&body.confirmation())).await? {
            Ok(step_up) => Ok(step_up),
            Err(StepUpFailure::BadRequest) => Err(LifecycleResponse::BadRequest(Json(
                "confirmation is required".into(),
            ))),
            Err(StepUpFailure::Unauthorized) => Err(LifecycleResponse::Unauthorized),
            Err(StepUpFailure::RateLimited) => Err(LifecycleResponse::RateLimited),
        },
    )
}

async fn insert_audit(
    db: &impl ConnectionTrait,
    auth: &RequestAuthorization,
    step_up: Option<StepUp>,
    event: &str,
    version: Option<&str>,
) -> Result<(), GatedError> {
    let actor = step_up
        .as_ref()
        .map(|s| s.username.clone())
        .or_else(|| auth.username().cloned())
        .unwrap_or_else(|| "admin-token".into());
    // `confirmation` doubles as the durable OTP single-use record checked by
    // the step-up verification.
    let values = json!({
        "event": event,
        "actor": actor,
        "version": version,
        "confirmation": step_up.as_ref().map(|s| s.factor).unwrap_or("token"),
        "reason": step_up.as_ref().map(|s| s.reason.as_str()).unwrap_or_default(),
    });
    ManagementAudit::ActiveModel {
        id: Set(Uuid::new_v4()),
        text: Set(match event {
            "system.update" => "Admin requested a gateway update".into(),
            _ => "Admin requested a gateway restart".into(),
        }),
        values: Set(values),
        timestamp: Set(Utc::now()),
        session_id: Set(Uuid::nil()),
        username: Set(Some(actor)),
    }
    .insert(db)
    .await?;
    Ok(())
}

pub fn router() -> OpenApiRouter {
    api_routes!(
        api_get_update_status,
        api_check_for_update,
        api_apply_update,
        api_restart,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lifecycle_request_carries_the_confirmation() {
        let request: LifecycleRequest =
            serde_json::from_str(r#"{"password":"pw","reason":"maintenance"}"#).expect("parse");
        let confirmation = request.confirmation();
        assert!(confirmation.credential().is_some());
        assert_eq!(confirmation.reason.as_deref(), Some("maintenance"));
        assert!(request.version.is_none());
    }
}

use axum::extract::Path;
use gated_common::GatedError;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use gated_core::{Services, login_protection};
use gated_db_entities::{IpBlock, UserLockout};
use utoipa_axum::router::OpenApiRouter;

use super::AnySecurityScheme;

api_response! {
    enum GetIpBlocksResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<IpBlock::Model>>),
    }
}

api_response! {
    enum GetUserLockoutsResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<UserLockout::Model>>),
    }
}

api_response! {
    enum LiftLoginProtectionResponse {
        #[oai(status = 204)]
        Deleted,
        #[oai(status = 404)]
        NotFound,
    }
}

impl From<bool> for LiftLoginProtectionResponse {
    fn from(lifted: bool) -> Self {
        if lifted {
            Self::Deleted
        } else {
            Self::NotFound
        }
    }
}

#[utoipa::path(
    get,
    path = "/login-protection/ip-blocks",
    operation_id = "get_ip_blocks"
)]
async fn get_ip_blocks(
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetIpBlocksResponse, GatedError> {
    let db = services.db_required().await?;
    Ok(GetIpBlocksResponse::Ok(Json(
        login_protection::list_ip_blocks(&db).await?,
    )))
}

#[utoipa::path(
    delete,
    path = "/login-protection/ip-blocks/{ip}",
    operation_id = "delete_ip_block"
)]
async fn delete_ip_block(
    ip: Path<String>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<LiftLoginProtectionResponse, GatedError> {
    let db = services.db_required().await?;
    Ok(login_protection::unblock_ip(&db, &ip).await?.into())
}

#[utoipa::path(
    get,
    path = "/login-protection/user-lockouts",
    operation_id = "get_user_lockouts"
)]
async fn get_user_lockouts(
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetUserLockoutsResponse, GatedError> {
    let db = services.db_required().await?;
    Ok(GetUserLockoutsResponse::Ok(Json(
        login_protection::list_user_lockouts(&db).await?,
    )))
}

#[utoipa::path(
    delete,
    path = "/login-protection/user-lockouts/{username}",
    operation_id = "delete_user_lockout"
)]
async fn delete_user_lockout(
    username: Path<String>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<LiftLoginProtectionResponse, GatedError> {
    let db = services.db_required().await?;
    Ok(login_protection::unlock_user(&db, &username).await?.into())
}

pub fn router() -> OpenApiRouter {
    api_routes!(
        get_ip_blocks,
        delete_ip_block,
        get_user_lockouts,
        delete_user_lockout,
    )
}

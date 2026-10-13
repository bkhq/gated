use gated_common::GatedError;
use gated_core::{Services, SessionSnapshot};
use gated_db_entities::Session;
use poem::web::Data;
use poem_openapi::payload::Json;
use poem_openapi::{ApiResponse, OpenApi};
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};

use super::common::get_user;
use crate::http_service::api::AnySecurityScheme;
use crate::http_service::common::{RequestAuthorization, endpoint_auth};

pub struct Api;

/// Upper bound on the rows returned by the self-service session list.
const MAX_OWN_SESSIONS: u64 = 500;

#[derive(ApiResponse)]
enum GetMySessionsResponse {
    #[oai(status = 200)]
    Ok(Json<Vec<SessionSnapshot>>),
    #[oai(status = 401)]
    Unauthorized,
}

#[OpenApi]
impl Api {
    /// Sessions owned by the calling user, newest first. Management HTTP
    /// sessions are excluded, as in the admin list.
    #[oai(
        path = "/profile/sessions",
        method = "get",
        operation_id = "get_my_sessions",
        transform = "endpoint_auth"
    )]
    async fn api_get_my_sessions(
        &self,
        auth: Data<&RequestAuthorization>,
        services: Data<&Services>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<GetMySessionsResponse, GatedError> {
        let db = services.db_required().await?;

        let Some(user_model) = get_user(*auth, &db).await? else {
            return Ok(GetMySessionsResponse::Unauthorized);
        };

        let sessions = Session::Entity::find()
            .filter(Session::Column::Username.eq(user_model.username))
            .filter(Session::Column::Protocol.ne("ManagementHTTP"))
            .order_by_desc(Session::Column::Started)
            .limit(MAX_OWN_SESSIONS)
            .all(&db)
            .await?;

        Ok(GetMySessionsResponse::Ok(Json(
            sessions.into_iter().map(Into::into).collect(),
        )))
    }
}

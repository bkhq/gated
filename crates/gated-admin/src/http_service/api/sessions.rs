use axum::middleware::from_fn;
use gated_common::GatedError;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use gated_core::{Services, SessionSnapshot};
use gated_db_entities::Session;
use sea_orm::{ColumnTrait, EntityTrait, QueryFilter, QueryOrder, QuerySelect};
use utoipa_axum::router::OpenApiRouter;

use super::common::get_user;
use crate::http_service::api::AnySecurityScheme;
use crate::http_service::common::{RequestAuthorization, require_auth};

/// Upper bound on the rows returned by the self-service session list.
const MAX_OWN_SESSIONS: u64 = 500;

api_response! {
    enum GetMySessionsResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<SessionSnapshot>>),
        #[oai(status = 401)]
        Unauthorized,
    }
}

/// Sessions owned by the calling user, newest first. Management HTTP
/// sessions are excluded, as in the admin list.
#[utoipa::path(get, path = "/profile/sessions", operation_id = "get_my_sessions")]
async fn api_get_my_sessions(
    auth: Data<RequestAuthorization>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetMySessionsResponse, GatedError> {
    let db = services.db_required().await?;

    let Some(user_model) = get_user(&auth, &db).await? else {
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

pub fn router() -> OpenApiRouter {
    api_routes!(api_get_my_sessions,).route_layer(from_fn(require_auth))
}

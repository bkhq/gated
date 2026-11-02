use axum::extract::Query;
use axum::middleware::from_fn;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use serde::Deserialize;
use std::collections::HashMap;
use utoipa::{IntoParams, ToSchema};
use utoipa_axum::router::OpenApiRouter;

use futures::{StreamExt, stream};
use gated_common::{GatedError, TargetOptions};
use gated_core::{ConfigProvider, Services};
use gated_db_entities::TargetGroup::BootstrapThemeColor;
use gated_db_entities::{Target, TargetGroup};
use sea_orm::EntityTrait;
use serde::Serialize;

use crate::http_service::api::AnySecurityScheme;
use crate::http_service::common::{RequestAuthorization, SessionAuthorization, require_auth};

#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct GroupInfo {
    pub id: uuid::Uuid,
    pub name: String,
    pub color: Option<BootstrapThemeColor>,
}

#[derive(Debug, Serialize, Clone, ToSchema)]
pub struct TargetSnapshot {
    pub name: String,
    pub description: String,
    pub kind: Target::TargetKind,
    pub group: Option<GroupInfo>,
    pub default_database_name: Option<String>,
}

api_response! {
    enum GetTargetsResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<TargetSnapshot>>),
    }
}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
struct GetAllTargetsQuery {
    search: Option<String>,
}

#[utoipa::path(
    get,
    path = "/targets",
    operation_id = "get_targets",
    params(GetAllTargetsQuery)
)]
async fn api_get_all_targets(
    services: Data<Services>,
    auth: Data<RequestAuthorization>,
    _sec_scheme: AnySecurityScheme,
    Query(query): Query<GetAllTargetsQuery>,
) -> Result<GetTargetsResponse, GatedError> {
    let GetAllTargetsQuery { search } = query;
    // Fetch target groups for group information
    let groups: Vec<TargetGroup::Model> = {
        let db = services.db_required().await?;
        TargetGroup::Entity::find().all(&db).await
    }?;

    let group_map: HashMap<uuid::Uuid, &TargetGroup::Model> =
        groups.iter().map(|g| (g.id, g)).collect();

    let mut targets = {
        let mut config_provider = services.config_provider.lock().await;
        config_provider.list_targets().await?
    };

    if let Some(ref search) = search {
        let search = search.to_lowercase();
        targets.retain(|t| {
            let group = t.group_id.and_then(|group_id| group_map.get(&group_id));
            t.name.to_lowercase().contains(&search)
                || group
                    .map(|g| g.name.to_lowercase().contains(&search))
                    .unwrap_or(false)
        })
    }

    let targets = stream::iter(targets)
        .filter(|t| {
            let services = services.clone();
            let auth = auth.0.clone();
            let name = t.name.clone();
            async move {
                match auth {
                    RequestAuthorization::Session(SessionAuthorization::Ticket {
                        target_name,
                        ..
                    }) => target_name == name,
                    _ => {
                        let mut config_provider = services.config_provider.lock().await;
                        let Some(username) = auth.username() else {
                            return false;
                        };
                        matches!(
                            config_provider.authorize_target(username, &name).await,
                            Ok(true)
                        )
                    }
                }
            }
        })
        .collect::<Vec<_>>()
        .await;

    let result: Vec<TargetSnapshot> = targets
        .into_iter()
        .map(|t| {
            let group = t.group_id.and_then(|group_id| {
                group_map.get(&group_id).map(|group| GroupInfo {
                    id: group.id,
                    name: group.name.clone(),
                    color: group.color.clone(),
                })
            });

            TargetSnapshot {
                name: t.name.clone(),
                description: t.description.clone(),
                kind: (&t.options).into(),
                default_database_name: match t.options {
                    TargetOptions::Postgres(ref opt) => opt.default_database_name.clone(),
                    TargetOptions::MySql(ref opt) => opt.default_database_name.clone(),
                    _ => None,
                },
                group,
            }
        })
        .collect();

    Ok(GetTargetsResponse::Ok(Json(result)))
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_get_all_targets,).route_layer(from_fn(require_auth))
}

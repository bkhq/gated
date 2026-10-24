use axum::extract::Path;
use gated_common::GatedError;
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use gated_core::SharedDatabaseConnection;
use gated_db_entities::TargetGroup;
use gated_db_entities::TargetGroup::BootstrapThemeColor;
use sea_orm::prelude::Expr;
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, ModelTrait, QueryFilter, QueryOrder, Set,
};
use serde::Deserialize;
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;

#[derive(Deserialize, ToSchema)]
struct TargetGroupDataRequest {
    name: String,
    description: Option<String>,
    color: Option<BootstrapThemeColor>,
}

api_response! {
    enum GetTargetGroupsResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<TargetGroup::Model>>),
    }
}

api_response! {
    enum CreateTargetGroupResponse {
        #[oai(status = 201)]
        Created(Json<TargetGroup::Model>),

        #[oai(status = 409)]
        Conflict(Json<String>),

        #[oai(status = 400)]
        BadRequest(Json<String>),
    }
}

#[utoipa::path(get, path = "/target-groups", operation_id = "list_target_groups")]
async fn api_list_target_groups(
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetTargetGroupsResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;
    let groups = TargetGroup::Entity::find()
        .order_by_asc(TargetGroup::Column::Name)
        .all(&db)
        .await?;

    Ok(GetTargetGroupsResponse::Ok(Json(groups)))
}

#[utoipa::path(post, path = "/target-groups", operation_id = "create_target_group")]
async fn api_create_target_group(
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    body: Json<TargetGroupDataRequest>,
) -> Result<CreateTargetGroupResponse, GatedError> {
    if body.name.is_empty() {
        return Ok(CreateTargetGroupResponse::BadRequest(Json("name".into())));
    }

    let db = gated_core::db_required(&db).await?;
    let existing = TargetGroup::Entity::find()
        .filter(TargetGroup::Column::Name.eq(body.name.clone()))
        .one(&db)
        .await?;
    if existing.is_some() {
        return Ok(CreateTargetGroupResponse::Conflict(Json(
            "Name already exists".into(),
        )));
    }

    let values = TargetGroup::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set(body.name.clone()),
        description: Set(body.description.clone().unwrap_or_default()),
        color: Set(body.color.clone()),
    };

    let group = values.insert(&db).await?;

    Ok(CreateTargetGroupResponse::Created(Json(group)))
}

api_response! {
    enum GetTargetGroupResponse {
        #[oai(status = 200)]
        Ok(Json<TargetGroup::Model>),
        #[oai(status = 404)]
        NotFound,
    }
}

api_response! {
    enum UpdateTargetGroupResponse {
        #[oai(status = 200)]
        Ok(Json<TargetGroup::Model>),
        #[oai(status = 400)]
        BadRequest,
        #[oai(status = 404)]
        NotFound,
    }
}

api_response! {
    enum DeleteTargetGroupResponse {
        #[oai(status = 204)]
        Deleted,

        #[oai(status = 404)]
        NotFound,
    }
}

#[utoipa::path(get, path = "/target-groups/{id}", operation_id = "get_target_group")]
async fn api_get_target_group(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetTargetGroupResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;
    let group = TargetGroup::Entity::find_by_id(id.0).one(&db).await?;

    match group {
        Some(group) => Ok(GetTargetGroupResponse::Ok(Json(group))),
        None => Ok(GetTargetGroupResponse::NotFound),
    }
}

#[utoipa::path(
    put,
    path = "/target-groups/{id}",
    operation_id = "update_target_group"
)]
async fn api_update_target_group(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    body: Json<TargetGroupDataRequest>,
) -> Result<UpdateTargetGroupResponse, GatedError> {
    if body.name.is_empty() {
        return Ok(UpdateTargetGroupResponse::BadRequest);
    }

    let db = gated_core::db_required(&db).await?;
    let group = TargetGroup::Entity::find_by_id(id.0).one(&db).await?;

    let Some(group) = group else {
        return Ok(UpdateTargetGroupResponse::NotFound);
    };

    // Check if name is already taken by another group
    let existing = TargetGroup::Entity::find()
        .filter(TargetGroup::Column::Name.eq(body.name.clone()))
        .filter(TargetGroup::Column::Id.ne(id.0))
        .one(&db)
        .await?;
    if existing.is_some() {
        return Ok(UpdateTargetGroupResponse::BadRequest);
    }

    let mut group: TargetGroup::ActiveModel = group.into();
    group.name = Set(body.name.clone());
    group.description = Set(body.description.clone().unwrap_or_default());
    group.color = Set(body.color.clone());

    let group = group.update(&db).await?;
    Ok(UpdateTargetGroupResponse::Ok(Json(group)))
}

#[utoipa::path(
    delete,
    path = "/target-groups/{id}",
    operation_id = "delete_target_group"
)]
async fn api_delete_target_group(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<DeleteTargetGroupResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;
    let group = TargetGroup::Entity::find_by_id(id.0).one(&db).await?;

    let Some(group) = group else {
        return Ok(DeleteTargetGroupResponse::NotFound);
    };

    // First, unassign all targets from this group by setting their group_id to NULL
    use gated_db_entities::Target;
    Target::Entity::update_many()
        .col_expr(Target::Column::GroupId, Expr::value(Option::<Uuid>::None))
        .filter(Target::Column::GroupId.eq(id.0))
        .exec(&db)
        .await?;

    // Then delete the group
    group.delete(&db).await?;
    Ok(DeleteTargetGroupResponse::Deleted)
}

pub fn router() -> OpenApiRouter {
    api_routes!(
        api_list_target_groups,
        api_create_target_group,
        api_get_target_group,
        api_update_target_group,
        api_delete_target_group,
    )
}

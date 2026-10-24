use axum::extract::{Path, Query};
use gated_common::api::types as api_types;
use gated_common::web::{Data, Json};
use gated_common::{GatedError, Role as RoleConfig, Target as TargetConfig, User as UserConfig};
use gated_common::{api_response, api_routes};
use gated_core::consts::BUILTIN_ADMIN_ROLE_NAME;
use gated_core::{Services, SharedDatabaseConnection};
use gated_db_entities::{Role, Target, User};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, ModelTrait, QueryFilter, QueryOrder, Set,
};
use serde::{Deserialize, Serialize};
use utoipa::{IntoParams, ToSchema};
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use super::AnySecurityScheme;

#[derive(Deserialize, ToSchema)]
struct RoleDataRequest {
    name: String,
    description: Option<String>,
    /// Defaults to `true` on create; unchanged on update when omitted.
    allow_file_transfer: Option<bool>,
}

#[derive(Serialize, ToSchema)]
struct RoleResponse {
    #[serde(flatten)]
    role: RoleConfig,
    /// True for the built-in admin role, which cannot be edited or deleted.
    builtin: bool,
}

impl From<Role::Model> for RoleResponse {
    fn from(role: Role::Model) -> Self {
        let role: RoleConfig = role.into();
        Self {
            builtin: role.name == BUILTIN_ADMIN_ROLE_NAME,
            role,
        }
    }
}

api_response! {
    enum GetRolesResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<RoleResponse>>),
    }
}
api_response! {
    enum CreateRoleResponse {
        #[oai(status = 201)]
        Created(Json<RoleResponse>),

        #[oai(status = 400)]
        BadRequest(Json<String>),
    }
}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
struct GetAllRolesQuery {
    search: Option<String>,
}

#[utoipa::path(
    get,
    path = "/roles",
    operation_id = "get_roles",
    params(GetAllRolesQuery)
)]
async fn api_get_all_roles(
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    Query(query): Query<GetAllRolesQuery>,
) -> Result<GetRolesResponse, GatedError> {
    let GetAllRolesQuery { search } = query;
    let db = gated_core::db_required(&db).await?;

    let mut roles = Role::Entity::find().order_by_asc(Role::Column::Name);

    if let Some(ref search) = search {
        let search = format!("%{search}%");
        roles = roles.filter(Role::Column::Name.like(search));
    }

    let roles = roles.all(&db).await?;

    Ok(GetRolesResponse::Ok(Json(
        roles.into_iter().map(Into::into).collect(),
    )))
}

#[utoipa::path(post, path = "/roles", operation_id = "create_role")]
async fn api_create_role(
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    body: Json<RoleDataRequest>,
) -> Result<CreateRoleResponse, GatedError> {
    use gated_db_entities::Role;

    if body.name.is_empty() {
        return Ok(CreateRoleResponse::BadRequest(Json("name".into())));
    }

    let db = gated_core::db_required(&db).await?;

    let values = Role::ActiveModel {
        id: Set(Uuid::new_v4()),
        name: Set(body.name.clone()),
        description: Set(body.description.clone().unwrap_or_default()),
        allow_file_transfer: Set(body.allow_file_transfer.unwrap_or(true)),
    };

    let role = values.insert(&db).await.map_err(GatedError::from)?;

    Ok(CreateRoleResponse::Created(Json(role.into())))
}

api_response! {
    enum GetRoleResponse {
        #[oai(status = 200)]
        Ok(Json<RoleResponse>),
        #[oai(status = 404)]
        NotFound,
    }
}

api_response! {
    enum UpdateRoleResponse {
        #[oai(status = 200)]
        Ok(Json<RoleResponse>),
        #[oai(status = 403)]
        Forbidden,
        #[oai(status = 404)]
        NotFound,
    }
}

api_response! {
    enum DeleteRoleResponse {
        #[oai(status = 204)]
        Deleted,
        #[oai(status = 403)]
        Forbidden,
        #[oai(status = 404)]
        NotFound,
    }
}

api_response! {
    enum GetRoleTargetsResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<api_types::Target>>),
        #[oai(status = 404)]
        NotFound,
    }
}

api_response! {
    enum GetRoleUsersResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<api_types::User>>),
        #[oai(status = 404)]
        NotFound,
    }
}

#[utoipa::path(get, path = "/role/{id}", operation_id = "get_role")]
async fn api_get_role(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetRoleResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let role = Role::Entity::find_by_id(id.0).one(&db).await?;

    Ok(match role {
        Some(role) => GetRoleResponse::Ok(Json(role.into())),
        None => GetRoleResponse::NotFound,
    })
}

#[utoipa::path(put, path = "/role/{id}", operation_id = "update_role")]
async fn api_update_role(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    body: Json<RoleDataRequest>,
) -> Result<UpdateRoleResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let Some(role) = Role::Entity::find_by_id(id.0).one(&db).await? else {
        return Ok(UpdateRoleResponse::NotFound);
    };

    if role.name == BUILTIN_ADMIN_ROLE_NAME {
        return Ok(UpdateRoleResponse::Forbidden);
    }

    let mut model: Role::ActiveModel = role.into();
    model.name = Set(body.name.clone());
    model.description = Set(body.description.clone().unwrap_or_default());
    if let Some(allow_file_transfer) = body.allow_file_transfer {
        model.allow_file_transfer = Set(allow_file_transfer);
    }
    let role = model.update(&db).await?;

    Ok(UpdateRoleResponse::Ok(Json(role.into())))
}

#[utoipa::path(delete, path = "/role/{id}", operation_id = "delete_role")]
async fn api_delete_role(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<DeleteRoleResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let Some(role) = Role::Entity::find_by_id(id.0).one(&db).await? else {
        return Ok(DeleteRoleResponse::NotFound);
    };

    if role.name == BUILTIN_ADMIN_ROLE_NAME {
        return Ok(DeleteRoleResponse::Forbidden);
    }

    role.delete(&db).await?;
    services.notify_authorization_changed();
    Ok(DeleteRoleResponse::Deleted)
}

#[utoipa::path(get, path = "/role/{id}/targets", operation_id = "get_role_targets")]
async fn api_get_role_targets(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetRoleTargetsResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let Some(role) = Role::Entity::find_by_id(id.0).one(&db).await? else {
        return Ok(GetRoleTargetsResponse::NotFound);
    };

    let targets = role.find_related(Target::Entity).all(&db).await?;

    Ok(GetRoleTargetsResponse::Ok(Json(
        targets
            .into_iter()
            .map(|target| TargetConfig::try_from(target).map(Into::into))
            .collect::<Result<Vec<_>, serde_json::Error>>()?,
    )))
}

#[utoipa::path(get, path = "/role/{id}/users", operation_id = "get_role_users")]
async fn api_get_role_users(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetRoleUsersResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let Some(role) = Role::Entity::find_by_id(id.0).one(&db).await? else {
        return Ok(GetRoleUsersResponse::NotFound);
    };

    let users = role.find_related(User::Entity).all(&db).await?;

    Ok(GetRoleUsersResponse::Ok(Json(
        users
            .into_iter()
            .map(|user| UserConfig::try_from(user).map(Into::into))
            .collect::<Result<Vec<_>, GatedError>>()?,
    )))
}

pub fn router() -> OpenApiRouter {
    api_routes!(
        api_get_all_roles,
        api_create_role,
        api_get_role,
        api_update_role,
        api_delete_role,
        api_get_role_targets,
        api_get_role_users,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn role(name: &str) -> Role::Model {
        Role::Model {
            id: Uuid::new_v4(),
            name: name.into(),
            description: String::new(),
            allow_file_transfer: true,
        }
    }

    #[test]
    fn role_response_flags_only_the_admin_role_as_builtin() {
        let admin = serde_json::to_value(RoleResponse::from(role(BUILTIN_ADMIN_ROLE_NAME)))
            .expect("serialize");
        assert_eq!(admin["name"], BUILTIN_ADMIN_ROLE_NAME);
        assert_eq!(admin["allow_file_transfer"], true);
        assert_eq!(admin["builtin"], true);

        let ops = serde_json::to_value(RoleResponse::from(role("ops"))).expect("serialize");
        assert_eq!(ops["name"], "ops");
        assert_eq!(ops["builtin"], false);
    }
}

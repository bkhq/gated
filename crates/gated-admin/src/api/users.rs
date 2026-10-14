use axum::extract::{Path, Query};
use gated_common::web::{Data, Json};
use gated_common::{
    GatedError, Role as RoleConfig, User as UserConfig, UserRequireCredentialsPolicy,
};
use gated_common::{api_response, api_routes};
use gated_core::Services;
use gated_core::SharedDatabaseConnection;
use gated_db_entities::{Role, User, UserRoleAssignment};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, ModelTrait, QueryFilter, QueryOrder, Set,
};
use serde::Deserialize;
use utoipa::{IntoParams, ToSchema};
use utoipa_axum::router::OpenApiRouter;
use uuid::Uuid;

use gated_common::api::types as api_types;

use super::AnySecurityScheme;

#[derive(Deserialize, ToSchema)]
struct CreateUserRequest {
    username: String,
    description: Option<String>,
}

#[derive(Deserialize, ToSchema)]
struct UserDataRequest {
    username: String,
    credential_policy: Option<api_types::UserRequireCredentialsPolicy>,
    description: Option<String>,
    rate_limit_bytes_per_second: Option<u32>,
}

api_response! {
    enum GetUsersResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<api_types::User>>),
    }
}
api_response! {
    enum CreateUserResponse {
        #[oai(status = 201)]
        Created(Json<api_types::User>),

        #[oai(status = 400)]
        BadRequest(Json<String>),
    }
}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
struct GetAllUsersQuery {
    search: Option<String>,
}

#[utoipa::path(
    get,
    path = "/users",
    operation_id = "get_users",
    params(GetAllUsersQuery)
)]
async fn api_get_all_users(
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    Query(query): Query<GetAllUsersQuery>,
) -> Result<GetUsersResponse, GatedError> {
    let GetAllUsersQuery { search } = query;
    let db = gated_core::db_required(&db).await?;

    let mut users = User::Entity::find().order_by_asc(User::Column::Username);

    if let Some(ref search) = search {
        let search = format!("%{search}%");
        users = users.filter(User::Column::Username.like(search));
    }

    let users = users.all(&db).await.map_err(GatedError::from)?;

    let users = users
        .into_iter()
        .map(|user| UserConfig::try_from(user).map(Into::into))
        .collect::<Result<Vec<_>, _>>()?;

    Ok(GetUsersResponse::Ok(Json(users)))
}

#[utoipa::path(post, path = "/users", operation_id = "create_user")]
async fn api_create_user(
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
    body: Json<CreateUserRequest>,
) -> Result<CreateUserResponse, GatedError> {
    if body.username.is_empty() {
        return Ok(CreateUserResponse::BadRequest(Json("name".into())));
    }

    let db = gated_core::db_required(&db).await?;

    if username_taken(&db, &body.username, None).await? {
        return Ok(CreateUserResponse::BadRequest(Json(
            "Username already exists".into(),
        )));
    }

    let values = User::ActiveModel {
        id: Set(Uuid::new_v4()),
        username: Set(body.username.clone()),
        credential_policy: Set(
            serde_json::to_value(UserRequireCredentialsPolicy::default())
                .map_err(GatedError::from)?,
        ),
        description: Set(body.description.clone().unwrap_or_default()),
        rate_limit_bytes_per_second: Set(None),
    };

    let user = match values.insert(&db).await {
        Ok(user) => user,
        Err(error)
            if matches!(
                error.sql_err(),
                Some(sea_orm::SqlErr::UniqueConstraintViolation(_))
            ) =>
        {
            return Ok(CreateUserResponse::BadRequest(Json(
                "Username already exists".into(),
            )));
        }
        Err(error) => return Err(error.into()),
    };

    Ok(CreateUserResponse::Created(Json(
        UserConfig::try_from(user)?.into(),
    )))
}

api_response! {
    #[allow(clippy::large_enum_variant)]
    enum GetUserResponse {
        #[oai(status = 200)]
        Ok(Json<api_types::User>),
        #[oai(status = 404)]
        NotFound,
    }
}

api_response! {
    #[allow(clippy::large_enum_variant)]
    enum UpdateUserResponse {
        #[oai(status = 200)]
        Ok(Json<api_types::User>),
        #[oai(status = 400)]
        BadRequest,
        #[oai(status = 404)]
        NotFound,
    }
}

/// Users are resolved by name across authentication and authorization, so a
/// second row with the same username must never be created.
async fn username_taken(
    db: &sea_orm::DatabaseConnection,
    username: &str,
    exclude_id: Option<Uuid>,
) -> Result<bool, GatedError> {
    let mut query = User::Entity::find().filter(User::Column::Username.eq(username));
    if let Some(id) = exclude_id {
        query = query.filter(User::Column::Id.ne(id));
    }
    Ok(query.one(db).await?.is_some())
}

api_response! {
    enum DeleteUserResponse {
        #[oai(status = 204)]
        Deleted,

        #[oai(status = 404)]
        NotFound,
    }
}

#[utoipa::path(get, path = "/users/{id}", operation_id = "get_user")]
async fn api_get_user(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetUserResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let Some(user) = User::Entity::find_by_id(id.0).one(&db).await? else {
        return Ok(GetUserResponse::NotFound);
    };

    Ok(GetUserResponse::Ok(Json(
        UserConfig::try_from(user)?.into(),
    )))
}

#[utoipa::path(put, path = "/users/{id}", operation_id = "update_user")]
async fn api_update_user(
    id: Path<Uuid>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
    body: Json<UserDataRequest>,
) -> Result<UpdateUserResponse, GatedError> {
    let db = services.db_required().await?;

    let Some(user) = User::Entity::find_by_id(id.0).one(&db).await? else {
        return Ok(UpdateUserResponse::NotFound);
    };

    if body.username.is_empty() {
        return Ok(UpdateUserResponse::BadRequest);
    }
    if username_taken(&db, &body.username, Some(id.0)).await? {
        return Ok(UpdateUserResponse::BadRequest);
    }

    let mut model: User::ActiveModel = user.into();
    model.username = Set(body.username.clone());
    model.description = Set(body.description.clone().unwrap_or_default());
    model.credential_policy = Set(serde_json::to_value(
        body.credential_policy
            .clone()
            .map(UserRequireCredentialsPolicy::from),
    )
    .map_err(GatedError::from)?);
    model.rate_limit_bytes_per_second = Set(body.rate_limit_bytes_per_second.map(|x| x as i64));
    let user = match model.update(&db).await {
        Ok(user) => user,
        Err(error)
            if matches!(
                error.sql_err(),
                Some(sea_orm::SqlErr::UniqueConstraintViolation(_))
            ) =>
        {
            return Ok(UpdateUserResponse::BadRequest);
        }
        Err(error) => return Err(error.into()),
    };

    drop(db);

    services
        .rate_limiter_registry
        .lock()
        .await
        .apply_new_rate_limits(&mut *services.state.write().await)
        .await?;

    Ok(UpdateUserResponse::Ok(Json(
        UserConfig::try_from(user)?.into(),
    )))
}

#[utoipa::path(delete, path = "/users/{id}", operation_id = "delete_user")]
async fn api_delete_user(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<DeleteUserResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let Some(user) = User::Entity::find_by_id(id.0).one(&db).await? else {
        return Ok(DeleteUserResponse::NotFound);
    };

    UserRoleAssignment::Entity::delete_many()
        .filter(UserRoleAssignment::Column::UserId.eq(user.id))
        .exec(&db)
        .await?;

    user.delete(&db).await?;
    services.notify_authorization_changed();
    Ok(DeleteUserResponse::Deleted)
}

api_response! {
    enum GetUserRolesResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<RoleConfig>>),
        #[oai(status = 404)]
        NotFound,
    }
}

api_response! {
    enum AddUserRoleResponse {
        #[oai(status = 201)]
        Created,
        #[oai(status = 409)]
        AlreadyExists,
    }
}

api_response! {
    enum DeleteUserRoleResponse {
        #[oai(status = 204)]
        Deleted,
        #[oai(status = 404)]
        NotFound,
    }
}

#[utoipa::path(get, path = "/users/{id}/roles", operation_id = "get_user_roles")]
async fn api_get_user_roles(
    id: Path<Uuid>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetUserRolesResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let Some((_, roles)) = User::Entity::find_by_id(*id)
        .find_with_related(Role::Entity)
        .all(&db)
        .await
        .map(|x| x.into_iter().next())
        .map_err(GatedError::from)?
    else {
        return Ok(GetUserRolesResponse::NotFound);
    };

    Ok(GetUserRolesResponse::Ok(Json(
        roles.into_iter().map(|x| x.into()).collect(),
    )))
}

#[utoipa::path(
    post,
    path = "/users/{id}/roles/{role_id}",
    operation_id = "add_user_role"
)]
async fn api_add_user_role(
    Path((id, role_id)): Path<(Uuid, Uuid)>,
    db: Data<SharedDatabaseConnection>,
    _sec_scheme: AnySecurityScheme,
) -> Result<AddUserRoleResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    if !UserRoleAssignment::Entity::find()
        .filter(UserRoleAssignment::Column::UserId.eq(id))
        .filter(UserRoleAssignment::Column::RoleId.eq(role_id))
        .all(&db)
        .await
        .map_err(GatedError::from)?
        .is_empty()
    {
        return Ok(AddUserRoleResponse::AlreadyExists);
    }

    let values = UserRoleAssignment::ActiveModel {
        user_id: Set(id),
        role_id: Set(role_id),
        ..Default::default()
    };

    values.insert(&db).await.map_err(GatedError::from)?;

    Ok(AddUserRoleResponse::Created)
}

#[utoipa::path(
    delete,
    path = "/users/{id}/roles/{role_id}",
    operation_id = "delete_user_role"
)]
async fn api_delete_user_role(
    Path((id, role_id)): Path<(Uuid, Uuid)>,
    db: Data<SharedDatabaseConnection>,
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<DeleteUserRoleResponse, GatedError> {
    let db = gated_core::db_required(&db).await?;

    let Some(_user) = User::Entity::find_by_id(id).one(&db).await? else {
        return Ok(DeleteUserRoleResponse::NotFound);
    };

    let Some(_role) = Role::Entity::find_by_id(role_id).one(&db).await? else {
        return Ok(DeleteUserRoleResponse::NotFound);
    };

    let Some(model) = UserRoleAssignment::Entity::find()
        .filter(UserRoleAssignment::Column::UserId.eq(id))
        .filter(UserRoleAssignment::Column::RoleId.eq(role_id))
        .one(&db)
        .await
        .map_err(GatedError::from)?
    else {
        return Ok(DeleteUserRoleResponse::NotFound);
    };

    model.delete(&db).await.map_err(GatedError::from)?;
    services.notify_authorization_changed();

    Ok(DeleteUserRoleResponse::Deleted)
}

pub fn router() -> OpenApiRouter {
    api_routes!(
        api_get_all_users,
        api_create_user,
        api_get_user,
        api_update_user,
        api_delete_user,
        api_get_user_roles,
        api_add_user_role,
        api_delete_user_role,
    )
}

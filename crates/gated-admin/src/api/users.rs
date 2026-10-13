use gated_common::{
    GatedError, Role as RoleConfig, User as UserConfig, UserRequireCredentialsPolicy,
};
use gated_core::Services;
use gated_core::SharedDatabaseConnection;
use gated_db_entities::{Role, User, UserRoleAssignment};
use poem::web::Data;
use poem_openapi::param::{Path, Query};
use poem_openapi::payload::Json;
use poem_openapi::{ApiResponse, Object, OpenApi};
use sea_orm::{
    ActiveModelTrait, ColumnTrait, EntityTrait, ModelTrait, QueryFilter, QueryOrder, Set,
};
use uuid::Uuid;

use super::AnySecurityScheme;

#[derive(Object)]
struct CreateUserRequest {
    username: String,
    description: Option<String>,
}

#[derive(Object)]
struct UserDataRequest {
    username: String,
    credential_policy: Option<UserRequireCredentialsPolicy>,
    description: Option<String>,
    rate_limit_bytes_per_second: Option<u32>,
}

#[derive(ApiResponse)]
enum GetUsersResponse {
    #[oai(status = 200)]
    Ok(Json<Vec<UserConfig>>),
}
#[derive(ApiResponse)]
enum CreateUserResponse {
    #[oai(status = 201)]
    Created(Json<UserConfig>),

    #[oai(status = 400)]
    BadRequest(Json<String>),
}

pub struct ListApi;

#[OpenApi]
impl ListApi {
    #[oai(path = "/users", method = "get", operation_id = "get_users")]
    async fn api_get_all_users(
        &self,
        db: Data<&SharedDatabaseConnection>,
        search: Query<Option<String>>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<GetUsersResponse, GatedError> {
        let db = gated_core::db_required(&db).await?;

        let mut users = User::Entity::find().order_by_asc(User::Column::Username);

        if let Some(ref search) = *search {
            let search = format!("%{search}%");
            users = users.filter(User::Column::Username.like(search));
        }

        let users = users.all(&db).await.map_err(GatedError::from)?;

        let users: Vec<UserConfig> = users
            .into_iter()
            .map(UserConfig::try_from)
            .collect::<Result<Vec<UserConfig>, _>>()?;

        Ok(GetUsersResponse::Ok(Json(users)))
    }

    #[oai(path = "/users", method = "post", operation_id = "create_user")]
    async fn api_create_user(
        &self,
        db: Data<&SharedDatabaseConnection>,
        body: Json<CreateUserRequest>,
        _sec_scheme: AnySecurityScheme,
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
                )))
            }
            Err(error) => return Err(error.into()),
        };

        Ok(CreateUserResponse::Created(Json(user.try_into()?)))
    }
}

#[derive(ApiResponse)]
#[allow(clippy::large_enum_variant)]
enum GetUserResponse {
    #[oai(status = 200)]
    Ok(Json<UserConfig>),
    #[oai(status = 404)]
    NotFound,
}

#[derive(ApiResponse)]
#[allow(clippy::large_enum_variant)]
enum UpdateUserResponse {
    #[oai(status = 200)]
    Ok(Json<UserConfig>),
    #[oai(status = 400)]
    BadRequest,
    #[oai(status = 404)]
    NotFound,
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

#[derive(ApiResponse)]
enum DeleteUserResponse {
    #[oai(status = 204)]
    Deleted,

    #[oai(status = 404)]
    NotFound,
}

pub struct DetailApi;

#[OpenApi]
impl DetailApi {
    #[oai(path = "/users/:id", method = "get", operation_id = "get_user")]
    async fn api_get_user(
        &self,
        db: Data<&SharedDatabaseConnection>,
        id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<GetUserResponse, GatedError> {
        let db = gated_core::db_required(&db).await?;

        let Some(user) = User::Entity::find_by_id(id.0).one(&db).await? else {
            return Ok(GetUserResponse::NotFound);
        };

        Ok(GetUserResponse::Ok(Json(user.try_into()?)))
    }

    #[oai(path = "/users/:id", method = "put", operation_id = "update_user")]
    async fn api_update_user(
        &self,
        services: Data<&Services>,
        body: Json<UserDataRequest>,
        id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
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
        model.credential_policy =
            Set(serde_json::to_value(body.credential_policy.clone()).map_err(GatedError::from)?);
        model.rate_limit_bytes_per_second = Set(body.rate_limit_bytes_per_second.map(|x| x as i64));
        let user = match model.update(&db).await {
            Ok(user) => user,
            Err(error)
                if matches!(
                    error.sql_err(),
                    Some(sea_orm::SqlErr::UniqueConstraintViolation(_))
                ) =>
            {
                return Ok(UpdateUserResponse::BadRequest)
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

        Ok(UpdateUserResponse::Ok(Json(user.try_into()?)))
    }

    #[oai(path = "/users/:id", method = "delete", operation_id = "delete_user")]
    async fn api_delete_user(
        &self,
        db: Data<&SharedDatabaseConnection>,
        services: Data<&Services>,
        id: Path<Uuid>,
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
}

#[derive(ApiResponse)]
enum GetUserRolesResponse {
    #[oai(status = 200)]
    Ok(Json<Vec<RoleConfig>>),
    #[oai(status = 404)]
    NotFound,
}

#[derive(ApiResponse)]
enum AddUserRoleResponse {
    #[oai(status = 201)]
    Created,
    #[oai(status = 409)]
    AlreadyExists,
}

#[derive(ApiResponse)]
enum DeleteUserRoleResponse {
    #[oai(status = 204)]
    Deleted,
    #[oai(status = 404)]
    NotFound,
}

pub struct RolesApi;

#[OpenApi]
impl RolesApi {
    #[oai(
        path = "/users/:id/roles",
        method = "get",
        operation_id = "get_user_roles"
    )]
    async fn api_get_user_roles(
        &self,
        db: Data<&SharedDatabaseConnection>,
        id: Path<Uuid>,
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

    #[oai(
        path = "/users/:id/roles/:role_id",
        method = "post",
        operation_id = "add_user_role"
    )]
    async fn api_add_user_role(
        &self,
        db: Data<&SharedDatabaseConnection>,
        id: Path<Uuid>,
        role_id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<AddUserRoleResponse, GatedError> {
        let db = gated_core::db_required(&db).await?;

        if !UserRoleAssignment::Entity::find()
            .filter(UserRoleAssignment::Column::UserId.eq(id.0))
            .filter(UserRoleAssignment::Column::RoleId.eq(role_id.0))
            .all(&db)
            .await
            .map_err(GatedError::from)?
            .is_empty()
        {
            return Ok(AddUserRoleResponse::AlreadyExists);
        }

        let values = UserRoleAssignment::ActiveModel {
            user_id: Set(id.0),
            role_id: Set(role_id.0),
            ..Default::default()
        };

        values.insert(&db).await.map_err(GatedError::from)?;

        Ok(AddUserRoleResponse::Created)
    }

    #[oai(
        path = "/users/:id/roles/:role_id",
        method = "delete",
        operation_id = "delete_user_role"
    )]
    async fn api_delete_user_role(
        &self,
        db: Data<&SharedDatabaseConnection>,
        services: Data<&Services>,
        id: Path<Uuid>,
        role_id: Path<Uuid>,
        _sec_scheme: AnySecurityScheme,
    ) -> Result<DeleteUserRoleResponse, GatedError> {
        let db = gated_core::db_required(&db).await?;

        let Some(_user) = User::Entity::find_by_id(id.0).one(&db).await? else {
            return Ok(DeleteUserRoleResponse::NotFound);
        };

        let Some(_role) = Role::Entity::find_by_id(role_id.0).one(&db).await? else {
            return Ok(DeleteUserRoleResponse::NotFound);
        };

        let Some(model) = UserRoleAssignment::Entity::find()
            .filter(UserRoleAssignment::Column::UserId.eq(id.0))
            .filter(UserRoleAssignment::Column::RoleId.eq(role_id.0))
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
}

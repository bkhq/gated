//! Durable management action records, separate from proxied session logs.
use axum::extract::Request;
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use gated_common::GatedError;
use gated_core::Services;
use gated_db_entities::ManagementAudit;
use sea_orm::{ActiveModelTrait, Set};
use uuid::Uuid;

use super::common::RequestAuthorization;

fn audit_entry(
    actor: &str,
    method: &str,
    path: &str,
    request_id: Uuid,
    status: Option<u16>,
) -> ManagementAudit::ActiveModel {
    ManagementAudit::ActiveModel {
        id: Set(Uuid::new_v4()),
        session_id: Set(Uuid::nil()),
        timestamp: Set(chrono::Utc::now()),
        username: Set(Some(actor.to_owned())),
        text: Set("Management action".into()),
        values: Set(serde_json::json!({
            "event": "management.action", "plane": "management", "actor": actor,
            "method": method, "path": path, "request_id": request_id,
            "phase": if status.is_some() { "completed" } else { "requested" }, "status": status,
        })),
    }
}

/// Records management writes before and after they run.
pub async fn audit_request(request: Request, next: Next) -> Response {
    let path = request.uri().path().to_owned();
    let method = request.method().as_str().to_owned();
    let actor = request
        .extensions()
        .get::<RequestAuthorization>()
        .map(|auth| {
            auth.username()
                .cloned()
                .unwrap_or_else(|| "admin-token".into())
        });
    let is_write = matches!(method.as_str(), "POST" | "PUT" | "PATCH" | "DELETE");
    let in_scope = path.starts_with("/admin/api/")
        || path.starts_with("/api/profile/")
        || path.starts_with("/api/auth/");
    if !is_write
        || !in_scope
        || matches!(
            path.as_str(),
            "/admin/api/logs" | "/admin/api/management-audit"
        )
        || actor.is_none()
    {
        return next.run(request).await;
    }
    let actor = actor.unwrap_or_default();
    let Some(services) = request.extensions().get::<Services>().cloned() else {
        return http::StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let db = match services.db_required().await {
        Ok(db) => db,
        Err(error) => return GatedError::from(error).into_response(),
    };
    let request_id = Uuid::new_v4();
    // Persist intent before calling the action, so failed/partial actions retain attribution.
    if let Err(error) = audit_entry(&actor, &method, &path, request_id, None)
        .insert(&db)
        .await
    {
        return GatedError::from(error).into_response();
    }
    let response = next.run(request).await;
    let status = response.status();
    // The action has already run; a failed completion record must not turn
    // its real outcome into an error. The intent record keeps attribution.
    if let Err(error) = audit_entry(&actor, &method, &path, request_id, Some(status.as_u16()))
        .insert(&db)
        .await
    {
        tracing::error!(?error, %request_id, %actor, %method, %path, "Failed to record management action completion");
    }
    response
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{ConnectionTrait, Database, DbBackend, EntityTrait, Schema};

    #[tokio::test]
    async fn completion_record_failure_keeps_the_action_result() {
        use axum::http::{Method, StatusCode};
        use axum::routing::post;
        use axum::{Extension, Router};
        use gated_common::{GatedConfig, GlobalParams};
        use tower::ServiceExt;

        let root = std::env::temp_dir().join(format!("gated-mgmt-audit-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let config_path = root.join("config.yaml");
        std::fs::write(&config_path, "").unwrap();
        let services = Services::new(
            GatedConfig {
                store: Default::default(),
            },
            None,
            GlobalParams::new(config_path, false).unwrap(),
            None,
        )
        .await
        .unwrap();
        let db = Database::connect("sqlite::memory:").await.unwrap();
        let schema = Schema::new(DbBackend::Sqlite);
        db.execute(
            db.get_database_backend()
                .build(&schema.create_table_from_entity(ManagementAudit::Entity)),
        )
        .await
        .unwrap();
        *services.db.write().await = Some(db);

        // The action removes the audit table, so only the completion insert fails.
        async fn action(Extension(services): Extension<Services>) -> StatusCode {
            let db = services.db_required().await.unwrap();
            db.execute_unprepared("DROP TABLE management_audit")
                .await
                .unwrap();
            StatusCode::CREATED
        }

        let app = Router::new()
            .route("/admin/api/parameters", post(action))
            .layer(axum::middleware::from_fn(audit_request))
            .layer(Extension(services.clone()))
            .layer(Extension(RequestAuthorization::AdminToken));
        let response = app
            .oneshot(
                Request::builder()
                    .method(Method::POST)
                    .uri("/admin/api/parameters")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::CREATED);
    }

    #[tokio::test]
    async fn management_actor_is_persisted_outside_session_logs() {
        let db = Database::connect("sqlite::memory:").await.unwrap();
        let schema = Schema::new(DbBackend::Sqlite);
        db.execute(
            db.get_database_backend()
                .build(&schema.create_table_from_entity(ManagementAudit::Entity)),
        )
        .await
        .unwrap();
        db.execute(
            db.get_database_backend()
                .build(&schema.create_table_from_entity(gated_db_entities::LogEntry::Entity)),
        )
        .await
        .unwrap();
        let request_id = Uuid::new_v4();
        audit_entry(
            "operator-b",
            "PUT",
            "/admin/api/parameters",
            request_id,
            Some(201),
        )
        .insert(&db)
        .await
        .unwrap();
        let entry = ManagementAudit::Entity::find()
            .one(&db)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(entry.username.as_deref(), Some("operator-b"));
        assert_eq!(entry.session_id, Uuid::nil());
        assert_eq!(entry.values["actor"], "operator-b");
        assert_eq!(entry.values["phase"], "completed");
        assert!(
            gated_db_entities::LogEntry::Entity::find()
                .all(&db)
                .await
                .unwrap()
                .is_empty()
        );
    }
}

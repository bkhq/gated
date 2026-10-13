//! Durable management action records, separate from proxied session logs.
use std::sync::Arc;

use gated_common::GatedError;
use gated_core::Services;
use gated_db_entities::ManagementAudit;
use poem::web::Data;
use poem::{Endpoint, FromRequest, IntoResponse, Request, Response};
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

pub async fn audit_request<E: Endpoint + 'static>(
    ep: Arc<E>,
    req: Request,
) -> poem::Result<Response> {
    let path = req.original_uri().path().to_owned();
    let method = req.method().as_str().to_owned();
    let auth = Option::<Data<&RequestAuthorization>>::from_request_without_body(&req).await?;
    let actor = auth.map(|auth| {
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
        return ep.call(req).await.map(IntoResponse::into_response);
    }
    let actor = actor.unwrap_or_default();
    let services = Data::<&Services>::from_request_without_body(&req).await?;
    let db = services.db_required().await.map_err(GatedError::from)?;
    let request_id = Uuid::new_v4();
    // Persist intent before calling the action, so failed/partial actions retain attribution.
    audit_entry(&actor, &method, &path, request_id, None)
        .insert(&db)
        .await
        .map_err(GatedError::from)?;
    let result = ep.call(req).await.map(IntoResponse::into_response);
    let status = match &result {
        Ok(response) => response.status(),
        Err(error) => error.status(),
    };
    // The action has already run; a failed completion record must not turn
    // its real outcome into an error. The intent record keeps attribution.
    if let Err(error) = audit_entry(&actor, &method, &path, request_id, Some(status.as_u16()))
        .insert(&db)
        .await
    {
        tracing::error!(?error, %request_id, %actor, %method, %path, "Failed to record management action completion");
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::{ConnectionTrait, Database, DbBackend, EntityTrait, Schema};

    #[tokio::test]
    async fn completion_record_failure_keeps_the_action_result() {
        use gated_common::{GatedConfig, GlobalParams};
        use poem::http::{Method, StatusCode};
        use poem::{handler, EndpointExt};

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
        #[handler]
        async fn action(services: Data<&Services>) -> StatusCode {
            let db = services.db_required().await.unwrap();
            db.execute_unprepared("DROP TABLE management_audit")
                .await
                .unwrap();
            StatusCode::CREATED
        }

        let app = action
            .around(audit_request)
            .data(services.clone())
            .data(RequestAuthorization::AdminToken);
        let response = app
            .get_response(
                Request::builder()
                    .method(Method::POST)
                    .uri("/admin/api/parameters".parse().unwrap())
                    .finish(),
            )
            .await;
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
        assert!(gated_db_entities::LogEntry::Entity::find()
            .all(&db)
            .await
            .unwrap()
            .is_empty());
    }
}

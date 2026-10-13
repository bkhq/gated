use sea_orm::entity::prelude::*;
use sea_orm::Set;
use uuid::Uuid;

#[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
#[sea_orm(table_name = "parameters")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: Uuid,
    pub allow_own_credential_management: bool,
    pub rate_limit_bytes_per_second: Option<i64>,
    #[sea_orm(column_type = "Text")]
    pub ca_certificate_pem: String,
    #[sea_orm(column_type = "Text")]
    pub ca_private_key_pem: String,
    pub ssh_client_auth_publickey: bool,
    pub ssh_client_auth_password: bool,
    pub ssh_client_auth_keyboard_interactive: bool,
    pub minimize_password_login: bool,
    /// Per-user request/minute limit for SQL Console and DB Terminal
    /// gateway endpoints. `None` means unlimited.
    pub sql_console_rate_limit_per_user: Option<i64>,
    /// Per-target request/minute limit for SQL Console and DB Terminal
    /// gateway endpoints. `None` means unlimited.
    pub sql_console_rate_limit_per_target: Option<i64>,
    /// When true, the web terminal renders a frontend-only operator-identity +
    /// timestamp watermark overlay. Purely visual; never injected into the PTY
    /// byte stream. Defaults to false (feature off).
    pub terminal_watermark_enabled: bool,
    /// Title shown on the login page, sidebar and browser tab. `None` uses
    /// the built-in "Gated".
    pub site_title: Option<String>,
}

impl ActiveModelBehavior for ActiveModel {}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl Entity {
    pub async fn get(db: &DatabaseConnection) -> Result<Model, DbErr> {
        match Self::find().one(db).await? {
            Some(model) => Ok(model),
            None => {
                ActiveModel {
                    id: Set(Uuid::new_v4()),
                    allow_own_credential_management: Set(true),
                    rate_limit_bytes_per_second: Set(None),
                    ca_certificate_pem: Set("".into()),
                    ca_private_key_pem: Set("".into()),
                    ssh_client_auth_publickey: Set(true),
                    ssh_client_auth_password: Set(true),
                    ssh_client_auth_keyboard_interactive: Set(true),
                    minimize_password_login: Set(false),
                    sql_console_rate_limit_per_user: Set(None),
                    sql_console_rate_limit_per_target: Set(None),
                    terminal_watermark_enabled: Set(false),
                    site_title: Set(None),
                }
                .insert(db)
                .await
            }
        }
    }
}

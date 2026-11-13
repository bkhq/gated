use gated_common::helpers::password_policy::PasswordPolicy;
use sea_orm::Set;
use sea_orm::entity::prelude::*;
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
    /// Hours between automatic target reachability checks; 0 turns them off.
    pub target_check_interval_hours: i32,
    /// Blocks client addresses and locks users out after repeated failed
    /// sign-ins. The `lp_*` columns are its thresholds, durations in seconds.
    pub login_protection_enabled: bool,
    pub lp_ip_max_attempts: i32,
    pub lp_ip_window_seconds: i32,
    /// Length of the first block; each repeat doubles it up to
    /// `lp_ip_max_block_seconds`.
    pub lp_ip_block_seconds: i32,
    pub lp_ip_max_block_seconds: i32,
    pub lp_user_max_attempts: i32,
    pub lp_user_window_seconds: i32,
    /// 0 keeps a user locked until an administrator lifts the lockout.
    pub lp_user_lockout_seconds: i32,
    /// Longest lifetime a user may give an API token. `None`: no limit.
    pub max_api_token_duration_seconds: Option<i64>,
    /// Rules for new passwords, see [`Model::password_policy`].
    pub password_min_length: i32,
    pub password_require_uppercase: bool,
    pub password_require_lowercase: bool,
    pub password_require_digits: bool,
    pub password_require_special: bool,
    /// Every user must enroll an OTP device: the web interface offers
    /// nothing but enrollment until then, and other protocols refuse.
    pub mfa_required: bool,
}

impl Model {
    pub fn password_policy(&self) -> PasswordPolicy {
        PasswordPolicy {
            min_length: u32::try_from(self.password_min_length).unwrap_or(0),
            require_uppercase: self.password_require_uppercase,
            require_lowercase: self.password_require_lowercase,
            require_digits: self.password_require_digits,
            require_special: self.password_require_special,
        }
    }
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
                    target_check_interval_hours: Set(24),
                    login_protection_enabled: Set(true),
                    lp_ip_max_attempts: Set(20),
                    lp_ip_window_seconds: Set(900),
                    lp_ip_block_seconds: Set(1800),
                    lp_ip_max_block_seconds: Set(86400),
                    lp_user_max_attempts: Set(10),
                    lp_user_window_seconds: Set(3600),
                    lp_user_lockout_seconds: Set(3600),
                    max_api_token_duration_seconds: Set(None),
                    password_min_length: Set(0),
                    password_require_uppercase: Set(false),
                    password_require_lowercase: Set(false),
                    password_require_digits: Set(false),
                    password_require_special: Set(false),
                    mfa_required: Set(false),
                }
                .insert(db)
                .await
            }
        }
    }
}

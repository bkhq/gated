use sea_orm::{DbBackend, Schema};
use sea_orm_migration::prelude::*;

// --- Entity definitions for all tables (final schema state) ---

pub mod ticket {
    use sea_orm::entity::prelude::*;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "tickets")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub secret: String,
        pub username: String,
        #[sea_orm(column_type = "Text")]
        pub description: String,
        pub target: String,
        pub uses_left: Option<i16>,
        pub expiry: Option<DateTimeUtc>,
        pub created: DateTimeUtc,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod session {
    use sea_orm::entity::prelude::*;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "sessions")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub target_snapshot: Option<String>,
        pub username: Option<String>,
        pub remote_address: String,
        pub started: DateTimeUtc,
        pub ended: Option<DateTimeUtc>,
        pub ticket_id: Option<Uuid>,
        pub protocol: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Ticket,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Ticket => Entity::belongs_to(super::ticket::Entity)
                    .from(Column::TicketId)
                    .to(super::ticket::Column::Id)
                    .on_delete(ForeignKeyAction::SetNull)
                    .into(),
            }
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod recording {
    use sea_orm::entity::prelude::*;
    use uuid::Uuid;

    #[derive(Debug, Clone, PartialEq, Eq, EnumIter, DeriveActiveEnum)]
    #[sea_orm(rs_type = "String", db_type = "String(StringLen::N(16))")]
    pub enum RecordingKind {
        #[sea_orm(string_value = "terminal")]
        Terminal,
        #[sea_orm(string_value = "traffic")]
        Traffic,
        #[sea_orm(string_value = "kubernetes")]
        Kubernetes,
        #[sea_orm(string_value = "api")]
        Api,
    }

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "recordings")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub name: String,
        pub started: DateTimeUtc,
        pub ended: Option<DateTimeUtc>,
        pub session_id: Uuid,
        pub kind: RecordingKind,
        #[sea_orm(column_type = "Text", nullable)]
        pub metadata: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Session,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Session => Entity::belongs_to(super::session::Entity)
                    .from(Column::SessionId)
                    .to(super::session::Column::Id)
                    .on_delete(ForeignKeyAction::Cascade)
                    .into(),
            }
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod known_host {
    use sea_orm::entity::prelude::*;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "known_hosts")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub host: String,
        pub port: i32,
        pub key_type: String,
        pub key_base64: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod log_entry {
    use chrono::{DateTime, Utc};
    use sea_orm::entity::prelude::*;
    use sea_orm::query::JsonValue;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "log")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub text: String,
        pub values: JsonValue,
        pub timestamp: DateTime<Utc>,
        pub session_id: Uuid,
        pub username: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod target_group {
    use sea_orm::entity::prelude::*;
    use uuid::Uuid;

    #[derive(Debug, PartialEq, Eq, Clone, EnumIter, DeriveActiveEnum)]
    #[sea_orm(rs_type = "String", db_type = "String(StringLen::N(16))")]
    pub enum BootstrapThemeColor {
        #[sea_orm(string_value = "primary")]
        Primary,
        #[sea_orm(string_value = "secondary")]
        Secondary,
        #[sea_orm(string_value = "success")]
        Success,
        #[sea_orm(string_value = "danger")]
        Danger,
        #[sea_orm(string_value = "warning")]
        Warning,
        #[sea_orm(string_value = "info")]
        Info,
        #[sea_orm(string_value = "light")]
        Light,
        #[sea_orm(string_value = "dark")]
        Dark,
    }

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "target_groups")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub name: String,
        #[sea_orm(column_type = "Text")]
        pub description: String,
        pub color: Option<BootstrapThemeColor>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod role {
    use sea_orm::entity::prelude::*;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "roles")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub name: String,
        #[sea_orm(column_type = "Text")]
        pub description: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod target {
    use sea_orm::entity::prelude::*;
    use uuid::Uuid;

    #[derive(Debug, PartialEq, Eq, Clone, EnumIter, DeriveActiveEnum)]
    #[sea_orm(rs_type = "String", db_type = "String(StringLen::N(16))")]
    pub enum TargetKind {
        #[sea_orm(string_value = "kubernetes")]
        Kubernetes,
        #[sea_orm(string_value = "mysql")]
        MySql,
        #[sea_orm(string_value = "ssh")]
        Ssh,
        #[sea_orm(string_value = "postgres")]
        Postgres,
        #[sea_orm(string_value = "web_admin")]
        WebAdmin,
        #[sea_orm(string_value = "api")]
        Api,
    }

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "targets")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub name: String,
        #[sea_orm(column_type = "Text")]
        pub description: String,
        pub kind: TargetKind,
        pub options: serde_json::Value,
        pub rate_limit_bytes_per_second: Option<i64>,
        pub group_id: Option<Uuid>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

mod target_role_assignment {
    use sea_orm::entity::prelude::*;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "target_roles")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = true)]
        pub id: i32,
        pub target_id: Uuid,
        pub role_id: Uuid,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        Target,
        Role,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::Target => Entity::belongs_to(super::target::Entity)
                    .from(Column::TargetId)
                    .to(super::target::Column::Id)
                    .into(),
                Self::Role => Entity::belongs_to(super::role::Entity)
                    .from(Column::RoleId)
                    .to(super::role::Column::Id)
                    .into(),
            }
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod user {
    use sea_orm::entity::prelude::*;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "users")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub username: String,
        pub credential_policy: serde_json::Value,
        #[sea_orm(column_type = "Text")]
        pub description: String,
        pub rate_limit_bytes_per_second: Option<i64>,
        pub ldap_server_id: Option<Uuid>,
        #[sea_orm(column_type = "Text", nullable)]
        pub ldap_object_uuid: Option<String>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

mod user_role_assignment {
    use sea_orm::entity::prelude::*;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "user_roles")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = true)]
        pub id: i32,
        pub user_id: Uuid,
        pub role_id: Uuid,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        User,
        Role,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::User => Entity::belongs_to(super::user::Entity)
                    .from(Column::UserId)
                    .to(super::user::Column::Id)
                    .into(),
                Self::Role => Entity::belongs_to(super::role::Entity)
                    .from(Column::RoleId)
                    .to(super::role::Column::Id)
                    .into(),
            }
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod otp_credential {
    use sea_orm::entity::prelude::*;
    use sea_orm::sea_query::ForeignKeyAction;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "credentials_otp")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub user_id: Uuid,
        pub secret_key: Vec<u8>,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        User,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::User => Entity::belongs_to(super::user::Entity)
                    .from(Column::UserId)
                    .to(super::user::Column::Id)
                    .on_delete(ForeignKeyAction::Cascade)
                    .into(),
            }
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod password_credential {
    use sea_orm::entity::prelude::*;
    use sea_orm::sea_query::ForeignKeyAction;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "credentials_password")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub user_id: Uuid,
        pub argon_hash: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        User,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::User => Entity::belongs_to(super::user::Entity)
                    .from(Column::UserId)
                    .to(super::user::Column::Id)
                    .on_delete(ForeignKeyAction::Cascade)
                    .into(),
            }
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod public_key_credential {
    use sea_orm::entity::prelude::*;
    use sea_orm::sea_query::ForeignKeyAction;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "credentials_public_key")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub user_id: Uuid,
        pub label: String,
        pub date_added: Option<DateTimeUtc>,
        pub last_used: Option<DateTimeUtc>,
        #[sea_orm(column_type = "Text")]
        pub openssh_public_key: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        User,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::User => Entity::belongs_to(super::user::Entity)
                    .from(Column::UserId)
                    .to(super::user::Column::Id)
                    .on_delete(ForeignKeyAction::Cascade)
                    .into(),
            }
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

mod sso_credential {
    use sea_orm::entity::prelude::*;
    use sea_orm::sea_query::ForeignKeyAction;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "credentials_sso")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub user_id: Uuid,
        pub provider: Option<String>,
        pub email: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        User,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::User => Entity::belongs_to(super::user::Entity)
                    .from(Column::UserId)
                    .to(super::user::Column::Id)
                    .on_delete(ForeignKeyAction::Cascade)
                    .into(),
            }
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod certificate_credential {
    use chrono::{DateTime, Utc};
    use sea_orm::entity::prelude::*;
    use sea_orm::sea_query::ForeignKeyAction;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "credentials_certificate")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub user_id: Uuid,
        pub label: String,
        pub date_added: Option<DateTime<Utc>>,
        pub last_used: Option<DateTime<Utc>>,
        #[sea_orm(column_type = "Text")]
        pub certificate_pem: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        User,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::User => Entity::belongs_to(super::user::Entity)
                    .from(Column::UserId)
                    .to(super::user::Column::Id)
                    .on_delete(ForeignKeyAction::Cascade)
                    .into(),
            }
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

mod parameters {
    use sea_orm::entity::prelude::*;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "parameters")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub allow_own_credential_management: bool,
        pub rate_limit_bytes_per_second: Option<i64>,
        pub ssh_client_auth_publickey: bool,
        pub ssh_client_auth_password: bool,
        pub ssh_client_auth_keyboard_interactive: bool,
        #[sea_orm(column_type = "Text")]
        pub ca_certificate_pem: String,
        #[sea_orm(column_type = "Text")]
        pub ca_private_key_pem: String,
        pub minimize_password_login: bool,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod api_token {
    use chrono::{DateTime, Utc};
    use sea_orm::entity::prelude::*;
    use sea_orm::sea_query::ForeignKeyAction;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "api_tokens")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub user_id: Uuid,
        pub label: String,
        pub secret: String,
        pub created: DateTime<Utc>,
        pub expiry: DateTime<Utc>,
    }

    #[derive(Copy, Clone, Debug, EnumIter)]
    pub enum Relation {
        User,
    }

    impl RelationTrait for Relation {
        fn def(&self) -> RelationDef {
            match self {
                Self::User => Entity::belongs_to(super::user::Entity)
                    .from(Column::UserId)
                    .to(super::user::Column::Id)
                    .on_delete(ForeignKeyAction::Cascade)
                    .into(),
            }
        }
    }

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod ldap_server {
    use sea_orm::entity::prelude::*;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "ldap_servers")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        #[sea_orm(unique)]
        pub name: String,
        pub host: String,
        pub port: i32,
        pub bind_dn: String,
        pub bind_password: String,
        pub user_filter: String,
        pub base_dns: serde_json::Value,
        pub tls_mode: String,
        pub tls_verify: bool,
        pub enabled: bool,
        pub auto_link_sso_users: bool,
        #[sea_orm(column_type = "Text")]
        pub description: String,
        pub username_attribute: String,
        #[sea_orm(column_type = "Text")]
        pub ssh_key_attribute: String,
        pub uuid_attribute: String,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

pub mod certificate_revocation {
    use chrono::{DateTime, Utc};
    use sea_orm::entity::prelude::*;
    use uuid::Uuid;

    #[derive(Clone, Debug, PartialEq, Eq, DeriveEntityModel)]
    #[sea_orm(table_name = "certificate_revocations")]
    pub struct Model {
        #[sea_orm(primary_key, auto_increment = false)]
        pub id: Uuid,
        pub serial_number_base64: String,
        pub date_added: DateTime<Utc>,
    }

    #[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
    pub enum Relation {}

    impl ActiveModelBehavior for ActiveModel {}
}

// --- Migration implementation ---

pub struct Migration;

impl MigrationName for Migration {
    fn name(&self) -> &str {
        "m00001_initial"
    }
}

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let builder = manager.get_database_backend();
        let schema = Schema::new(builder);

        // 1. tickets
        manager
            .create_table(schema.create_table_from_entity(ticket::Entity))
            .await?;
        let connection = manager.get_connection();
        if connection.get_database_backend() == DbBackend::MySql {
            connection
                .execute_unprepared(
                    "ALTER TABLE `tickets` MODIFY COLUMN `expiry` TIMESTAMP NULL DEFAULT NULL",
                )
                .await?;
        }

        // 2. sessions (FK → tickets)
        manager
            .create_table(schema.create_table_from_entity(session::Entity))
            .await?;

        // 3. recordings (FK → sessions)
        manager
            .create_table(schema.create_table_from_entity(recording::Entity))
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(recording::Entity)
                    .name("recording__unique__session_id__name")
                    .unique()
                    .col(recording::Column::SessionId)
                    .col(recording::Column::Name)
                    .to_owned(),
            )
            .await?;

        // 4. known_hosts
        manager
            .create_table(schema.create_table_from_entity(known_host::Entity))
            .await?;

        // 5. log
        manager
            .create_table(schema.create_table_from_entity(log_entry::Entity))
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(log_entry::Entity)
                    .name("log_entry__timestamp_session_id")
                    .col(log_entry::Column::Timestamp)
                    .col(log_entry::Column::SessionId)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(log_entry::Entity)
                    .name("log_entry__session_id")
                    .col(log_entry::Column::SessionId)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .table(log_entry::Entity)
                    .name("log_entry__username")
                    .col(log_entry::Column::Username)
                    .to_owned(),
            )
            .await?;

        // 6. target_groups
        manager
            .create_table(schema.create_table_from_entity(target_group::Entity))
            .await?;

        // 7. roles
        manager
            .create_table(schema.create_table_from_entity(role::Entity))
            .await?;

        // 8. targets (group_id references target_groups at app level)
        manager
            .create_table(schema.create_table_from_entity(target::Entity))
            .await?;

        // 9. target_roles (FK → targets, roles)
        manager
            .create_table(schema.create_table_from_entity(target_role_assignment::Entity))
            .await?;

        // 10. users
        manager
            .create_table(schema.create_table_from_entity(user::Entity))
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_users_ldap_server_id")
                    .table(user::Entity)
                    .col(user::Column::LdapServerId)
                    .to_owned(),
            )
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_users_ldap_unique")
                    .table(user::Entity)
                    .col(user::Column::LdapServerId)
                    .col(user::Column::LdapObjectUuid)
                    .unique()
                    .to_owned(),
            )
            .await?;

        // 11. user_roles (FK → users, roles)
        manager
            .create_table(schema.create_table_from_entity(user_role_assignment::Entity))
            .await?;

        // 12. credentials_otp (FK → users, cascade)
        manager
            .create_table(schema.create_table_from_entity(otp_credential::Entity))
            .await?;

        // 13. credentials_password (FK → users, cascade)
        manager
            .create_table(schema.create_table_from_entity(password_credential::Entity))
            .await?;

        // 14. credentials_public_key (FK → users, cascade)
        manager
            .create_table(schema.create_table_from_entity(public_key_credential::Entity))
            .await?;

        // 15. credentials_sso (FK → users, cascade)
        manager
            .create_table(schema.create_table_from_entity(sso_credential::Entity))
            .await?;

        // 16. credentials_certificate (FK → users, cascade)
        manager
            .create_table(schema.create_table_from_entity(certificate_credential::Entity))
            .await?;

        // 17. parameters
        manager
            .create_table(schema.create_table_from_entity(parameters::Entity))
            .await?;

        // 18. api_tokens (FK → users, cascade)
        manager
            .create_table(schema.create_table_from_entity(api_token::Entity))
            .await?;

        // 19. ldap_servers
        manager
            .create_table(schema.create_table_from_entity(ldap_server::Entity))
            .await?;

        // 20. certificate_revocations
        manager
            .create_table(schema.create_table_from_entity(certificate_revocation::Entity))
            .await?;
        manager
            .create_index(
                Index::create()
                    .name("idx_certificate_revocations_serial")
                    .table(certificate_revocation::Entity)
                    .col(certificate_revocation::Column::SerialNumberBase64)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Drop in reverse order of creation (respecting FK dependencies)
        macro_rules! drop_tables {
            ($($entity:expr),+ $(,)?) => {
                $(
                    manager
                        .drop_table(Table::drop().table($entity).to_owned())
                        .await?;
                )+
            };
        }

        drop_tables!(
            certificate_revocation::Entity,
            ldap_server::Entity,
            api_token::Entity,
            parameters::Entity,
            certificate_credential::Entity,
            sso_credential::Entity,
            public_key_credential::Entity,
            password_credential::Entity,
            otp_credential::Entity,
            user_role_assignment::Entity,
            user::Entity,
            target_role_assignment::Entity,
            target::Entity,
            role::Entity,
            target_group::Entity,
            log_entry::Entity,
            known_host::Entity,
            recording::Entity,
            session::Entity,
            ticket::Entity,
        );

        Ok(())
    }
}

use anyhow::Result;
use dialoguer::theme::ColorfulTheme;
use gated_common::auth::CredentialKind;
use gated_common::{GlobalParams, Secret, User as UserConfig, UserPasswordCredential};
use gated_core::Services;
use gated_db_entities::{OtpCredential, Parameters, PasswordCredential, User};
use sea_orm::{ActiveModelTrait, ColumnTrait, EntityTrait, QueryFilter, QueryOrder, Set};
use tracing::*;
use uuid::Uuid;

use crate::commands::common::assert_interactive_terminal;
use crate::config::load_config;

pub(crate) async fn command(params: &GlobalParams, username: &Option<String>) -> Result<()> {
    assert_interactive_terminal();

    let config = load_config(params, true)?;
    let services = Services::new(config.clone(), None, params.clone(), None).await?;
    services.open_db_legacy().await?;

    let theme = ColorfulTheme::default();
    let db = services.db_required().await?;

    let users = User::Entity::find()
        .order_by_asc(User::Column::Username)
        .all(&db)
        .await?;

    let users: Result<Vec<UserConfig>, _> = users.into_iter().map(|t| t.try_into()).collect();
    let mut users = users?;
    let usernames = users.iter().map(|x| x.username.clone()).collect::<Vec<_>>();

    let user = match username {
        Some(username) => users
            .iter_mut()
            .find(|x| &x.username == username)
            .ok_or_else(|| anyhow::anyhow!("User not found"))?,
        None =>
        {
            #[allow(clippy::indexing_slicing)]
            &mut users[dialoguer::Select::with_theme(&theme)
                .with_prompt("Select a user to recover access for")
                .items(&usernames)
                .default(0)
                .interact()?]
        }
    };

    let password = Secret::new(
        dialoguer::Password::with_theme(&theme)
            .with_prompt(format!("New password for {}", user.username))
            .interact()?,
    );

    if !dialoguer::Confirm::with_theme(&theme)
            .default(true)
            .with_prompt("This tool will add a new password for the user and set their HTTP auth policy to only require a password. If MFA is required, the user's OTP devices are removed. Continue?")
            .interact()? {
                std::process::exit(0);
            }

    PasswordCredential::ActiveModel {
        user_id: Set(user.id),
        id: Set(Uuid::new_v4()),
        ..UserPasswordCredential::from_password(&password).into()
    }
    .insert(&db)
    .await?;

    // With MFA required no stored policy waives the OTP device, so a lost
    // device is removed here and a new one is enrolled at the next sign-in.
    if Parameters::Entity::get(&db).await?.mfa_required {
        let removed = OtpCredential::Entity::delete_many()
            .filter(OtpCredential::Column::UserId.eq(user.id))
            .exec(&db)
            .await?
            .rows_affected;
        if removed > 0 {
            user.credential_policy = user
                .credential_policy
                .as_ref()
                .and_then(|policy| policy.downgrade_from_otp());
            info!(
                "MFA is required: removed {removed} OTP device(s); a new one is enrolled at the next sign-in"
            );
        }
    }

    user.credential_policy
        .get_or_insert_with(Default::default)
        .http = Some(vec![CredentialKind::Password]);

    User::ActiveModel {
        id: Set(user.id),
        credential_policy: Set(serde_json::to_value(Some(&user.credential_policy))?),
        ..Default::default()
    }
    .update(&db)
    .await?;

    // Whoever runs this has the console: lift what would keep them out.
    gated_core::login_protection::unlock_user(&db, &user.username).await?;
    for block in gated_core::login_protection::list_ip_blocks(&db).await? {
        gated_core::login_protection::unblock_ip(&db, &block.ip_address).await?;
    }

    info!("All done. You can now log in");

    Ok(())
}

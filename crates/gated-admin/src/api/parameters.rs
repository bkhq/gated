use gated_common::GatedError;
use gated_common::helpers::password_policy::{MAX_MIN_LENGTH, PasswordPolicy};
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use gated_core::Services;
use gated_db_entities::Parameters;
use sea_orm::ActiveValue::NotSet;
use sea_orm::{EntityTrait, IntoActiveModel, Set};
use serde::Deserialize;
use serde::Serialize;
use utoipa::ToSchema;
use utoipa_axum::router::OpenApiRouter;

use super::AnySecurityScheme;

#[derive(Serialize, ToSchema)]
struct ParameterValues {
    pub allow_own_credential_management: bool,
    pub rate_limit_bytes_per_second: Option<u32>,
    pub ssh_client_auth_publickey: bool,
    pub ssh_client_auth_password: bool,
    pub ssh_client_auth_keyboard_interactive: bool,
    pub minimize_password_login: bool,
    /// Per-user request/minute limit for SQL Console and DB Terminal
    /// gateway endpoints. `None` means unlimited.
    pub sql_console_rate_limit_per_user: Option<u32>,
    /// Per-target request/minute limit for SQL Console and DB Terminal
    /// gateway endpoints. `None` means unlimited.
    pub sql_console_rate_limit_per_target: Option<u32>,
    /// When true, the web terminal renders a frontend-only operator-identity +
    /// timestamp watermark overlay. Defaults to false.
    pub terminal_watermark_enabled: bool,
    /// Title shown on the login page, sidebar and browser tab. `None` uses
    /// the built-in "Gated".
    pub site_title: Option<String>,
    /// Hours between automatic target reachability checks; 0 = off.
    pub target_check_interval_hours: u32,
    pub login_protection: LoginProtectionParameters,
    /// Longest lifetime a user may give an API token they create, in
    /// seconds. `None`: no limit. Tokens an administrator creates for a user
    /// are not limited.
    pub max_api_token_duration_seconds: Option<u32>,
    /// Rules for passwords set through the admin and profile APIs.
    pub password_policy: PasswordPolicy,
    /// Every user must enroll an OTP device before using the gateway.
    pub mfa_required: bool,
}

/// Thresholds for blocking client addresses and locking users out after
/// failed sign-ins. Durations are in seconds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, ToSchema)]
struct LoginProtectionParameters {
    pub enabled: bool,
    /// Failed attempts from one address within `ip_window_seconds` that
    /// block it, 1 to 1000.
    pub ip_max_attempts: u32,
    /// 60 to 86400.
    pub ip_window_seconds: u32,
    /// Length of the first block, 60 to 2592000. Each repeat doubles it.
    pub ip_block_seconds: u32,
    /// Longest block, `ip_block_seconds` to 2592000.
    pub ip_max_block_seconds: u32,
    /// Failed attempts for one user within `user_window_seconds` that lock
    /// the user out, 1 to 1000. Administrators are not locked out.
    pub user_max_attempts: u32,
    /// 60 to 86400.
    pub user_window_seconds: u32,
    /// 60 to 2592000, or 0 to keep the user locked until an administrator
    /// lifts the lockout.
    pub user_lockout_seconds: u32,
}

const LP_MAX_ATTEMPTS: u32 = 1000;
const LP_MIN_SECONDS: u32 = 60;
const LP_MAX_WINDOW_SECONDS: u32 = 86_400;
const LP_MAX_DURATION_SECONDS: u32 = 2_592_000;

impl LoginProtectionParameters {
    fn validate(&self) -> Result<(), String> {
        let checks = [
            ("ip_max_attempts", self.ip_max_attempts, 1, LP_MAX_ATTEMPTS),
            (
                "user_max_attempts",
                self.user_max_attempts,
                1,
                LP_MAX_ATTEMPTS,
            ),
            (
                "ip_window_seconds",
                self.ip_window_seconds,
                LP_MIN_SECONDS,
                LP_MAX_WINDOW_SECONDS,
            ),
            (
                "user_window_seconds",
                self.user_window_seconds,
                LP_MIN_SECONDS,
                LP_MAX_WINDOW_SECONDS,
            ),
            (
                "ip_block_seconds",
                self.ip_block_seconds,
                LP_MIN_SECONDS,
                LP_MAX_DURATION_SECONDS,
            ),
            (
                "ip_max_block_seconds",
                self.ip_max_block_seconds,
                self.ip_block_seconds,
                LP_MAX_DURATION_SECONDS,
            ),
        ];
        for (name, value, min, max) in checks {
            if !(min..=max).contains(&value) {
                return Err(format!("login_protection.{name} must be {min} to {max}"));
            }
        }
        if self.user_lockout_seconds != 0
            && !(LP_MIN_SECONDS..=LP_MAX_DURATION_SECONDS).contains(&self.user_lockout_seconds)
        {
            return Err(format!(
                "login_protection.user_lockout_seconds must be 0 or {LP_MIN_SECONDS} to {LP_MAX_DURATION_SECONDS}"
            ));
        }
        Ok(())
    }
}

fn unsigned(value: i32) -> u32 {
    u32::try_from(value).unwrap_or(0)
}

#[derive(Serialize, Deserialize, ToSchema)]
struct ParameterUpdate {
    pub allow_own_credential_management: bool,
    pub rate_limit_bytes_per_second: Option<u32>,
    pub ssh_client_auth_publickey: Option<bool>,
    pub ssh_client_auth_password: Option<bool>,
    pub ssh_client_auth_keyboard_interactive: Option<bool>,
    pub minimize_password_login: Option<bool>,
    /// Per-user request/minute limit for SQL Console and DB Terminal
    /// gateway endpoints. `None` clears the limit.
    #[serde(default)]
    pub sql_console_rate_limit_per_user: Option<u32>,
    /// Per-target request/minute limit for SQL Console and DB Terminal
    /// gateway endpoints. `None` clears the limit.
    #[serde(default)]
    pub sql_console_rate_limit_per_target: Option<u32>,
    /// When true, the web terminal renders a frontend-only operator-identity +
    /// timestamp watermark overlay. Omitted leaves the current value unchanged.
    pub terminal_watermark_enabled: Option<bool>,
    /// Site title, at most 64 characters. Omitted leaves the current value
    /// unchanged; an empty string restores the built-in "Gated".
    pub site_title: Option<String>,
    /// Hours between automatic target reachability checks, 0 (off) to 168.
    /// Omitted leaves the current value unchanged.
    pub target_check_interval_hours: Option<u32>,
    /// Omitted leaves the current values unchanged.
    pub login_protection: Option<LoginProtectionParameters>,
    /// Seconds; 0 lifts the limit. Omitted leaves the current value unchanged.
    pub max_api_token_duration_seconds: Option<u32>,
    /// Omitted leaves the current rules unchanged. Existing passwords are
    /// not checked again.
    pub password_policy: Option<PasswordPolicy>,
    /// Omitted leaves the current value unchanged.
    pub mfa_required: Option<bool>,
}

api_response! {
    enum GetParametersResponse {
        #[oai(status = 200)]
        Ok(Json<ParameterValues>),
    }
}

api_response! {
    enum UpdateParametersResponse {
        #[oai(status = 201)]
        Done,
        #[oai(status = 400)]
        BadRequest(Json<String>),
    }
}

const SITE_TITLE_MAX_CHARS: usize = 64;
const TARGET_CHECK_INTERVAL_MAX_HOURS: u32 = 168;

/// Normalize a submitted site title: surrounding whitespace is dropped and an
/// empty value clears the title.
fn normalize_site_title(title: &str) -> Result<Option<String>, String> {
    let title = title.trim();
    if title.chars().count() > SITE_TITLE_MAX_CHARS {
        return Err(format!(
            "site_title must be at most {SITE_TITLE_MAX_CHARS} characters"
        ));
    }
    if title.chars().any(char::is_control) {
        return Err("site_title must not contain control characters".into());
    }
    Ok((!title.is_empty()).then(|| title.to_owned()))
}

#[utoipa::path(get, path = "/parameters", operation_id = "get_parameters")]
async fn api_get(
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
) -> Result<GetParametersResponse, GatedError> {
    let db = services.db_required().await?;
    let parameters = Parameters::Entity::get(&db).await?;
    let password_policy = parameters.password_policy();

    Ok(GetParametersResponse::Ok(Json(ParameterValues {
        allow_own_credential_management: parameters.allow_own_credential_management,
        rate_limit_bytes_per_second: parameters.rate_limit_bytes_per_second.map(|x| x as u32),
        ssh_client_auth_publickey: parameters.ssh_client_auth_publickey,
        ssh_client_auth_password: parameters.ssh_client_auth_password,
        ssh_client_auth_keyboard_interactive: parameters.ssh_client_auth_keyboard_interactive,
        minimize_password_login: parameters.minimize_password_login,
        sql_console_rate_limit_per_user: parameters
            .sql_console_rate_limit_per_user
            .map(|x| x as u32),
        sql_console_rate_limit_per_target: parameters
            .sql_console_rate_limit_per_target
            .map(|x| x as u32),
        terminal_watermark_enabled: parameters.terminal_watermark_enabled,
        site_title: parameters.site_title,
        target_check_interval_hours: u32::try_from(parameters.target_check_interval_hours)
            .unwrap_or(0),
        login_protection: LoginProtectionParameters {
            enabled: parameters.login_protection_enabled,
            ip_max_attempts: unsigned(parameters.lp_ip_max_attempts),
            ip_window_seconds: unsigned(parameters.lp_ip_window_seconds),
            ip_block_seconds: unsigned(parameters.lp_ip_block_seconds),
            ip_max_block_seconds: unsigned(parameters.lp_ip_max_block_seconds),
            user_max_attempts: unsigned(parameters.lp_user_max_attempts),
            user_window_seconds: unsigned(parameters.lp_user_window_seconds),
            user_lockout_seconds: unsigned(parameters.lp_user_lockout_seconds),
        },
        max_api_token_duration_seconds: parameters
            .max_api_token_duration_seconds
            .and_then(|seconds| u32::try_from(seconds).ok()),
        password_policy,
        mfa_required: parameters.mfa_required,
    })))
}

#[utoipa::path(put, path = "/parameters", operation_id = "update_parameters")]
async fn api_update_parameters(
    services: Data<Services>,
    _sec_scheme: AnySecurityScheme,
    body: Json<ParameterUpdate>,
) -> Result<UpdateParametersResponse, GatedError> {
    let site_title = match body.site_title.as_deref().map(normalize_site_title) {
        None => NotSet,
        Some(Ok(title)) => Set(title),
        Some(Err(message)) => return Ok(UpdateParametersResponse::BadRequest(Json(message))),
    };
    if body
        .target_check_interval_hours
        .is_some_and(|hours| hours > TARGET_CHECK_INTERVAL_MAX_HOURS)
    {
        return Ok(UpdateParametersResponse::BadRequest(Json(format!(
            "target_check_interval_hours must be 0 to {TARGET_CHECK_INTERVAL_MAX_HOURS}"
        ))));
    }
    if let Some(Err(message)) = body
        .login_protection
        .as_ref()
        .map(LoginProtectionParameters::validate)
    {
        return Ok(UpdateParametersResponse::BadRequest(Json(message)));
    }
    if body
        .password_policy
        .as_ref()
        .is_some_and(|policy| policy.min_length > MAX_MIN_LENGTH)
    {
        return Ok(UpdateParametersResponse::BadRequest(Json(format!(
            "password_policy.min_length must be 0 to {MAX_MIN_LENGTH}"
        ))));
    }
    let db = services.db_required().await?;
    let mut parameters = Parameters::Entity::get(&db).await?.into_active_model();
    parameters.site_title = site_title;
    if let Some(policy) = &body.password_policy {
        parameters.password_min_length = Set(policy.min_length as i32);
        parameters.password_require_uppercase = Set(policy.require_uppercase);
        parameters.password_require_lowercase = Set(policy.require_lowercase);
        parameters.password_require_digits = Set(policy.require_digits);
        parameters.password_require_special = Set(policy.require_special);
    }
    parameters.mfa_required = body.mfa_required.map_or(NotSet, Set);
    parameters.max_api_token_duration_seconds = body
        .max_api_token_duration_seconds
        .map_or(NotSet, |seconds| {
            Set((seconds > 0).then_some(i64::from(seconds)))
        });
    if let Some(lp) = &body.login_protection {
        parameters.login_protection_enabled = Set(lp.enabled);
        parameters.lp_ip_max_attempts = Set(lp.ip_max_attempts as i32);
        parameters.lp_ip_window_seconds = Set(lp.ip_window_seconds as i32);
        parameters.lp_ip_block_seconds = Set(lp.ip_block_seconds as i32);
        parameters.lp_ip_max_block_seconds = Set(lp.ip_max_block_seconds as i32);
        parameters.lp_user_max_attempts = Set(lp.user_max_attempts as i32);
        parameters.lp_user_window_seconds = Set(lp.user_window_seconds as i32);
        parameters.lp_user_lockout_seconds = Set(lp.user_lockout_seconds as i32);
    }
    parameters.target_check_interval_hours = body
        .target_check_interval_hours
        .map_or(NotSet, |hours| Set(hours as i32));

    parameters.allow_own_credential_management = Set(body.allow_own_credential_management);
    parameters.rate_limit_bytes_per_second =
        Set(body.rate_limit_bytes_per_second.map(|x| x as i64));
    parameters.ssh_client_auth_publickey = body.ssh_client_auth_publickey.map_or(NotSet, Set);
    parameters.ssh_client_auth_password = body.ssh_client_auth_password.map_or(NotSet, Set);
    parameters.ssh_client_auth_keyboard_interactive = body
        .ssh_client_auth_keyboard_interactive
        .map_or(NotSet, Set);
    parameters.minimize_password_login = body.minimize_password_login.map_or(NotSet, Set);
    parameters.sql_console_rate_limit_per_user =
        Set(body.sql_console_rate_limit_per_user.map(|x| x as i64));
    parameters.sql_console_rate_limit_per_target =
        Set(body.sql_console_rate_limit_per_target.map(|x| x as i64));
    parameters.terminal_watermark_enabled = body.terminal_watermark_enabled.map_or(NotSet, Set);

    Parameters::Entity::update(parameters).exec(&db).await?;
    drop(db);

    services
        .rate_limiter_registry
        .lock()
        .await
        .apply_new_rate_limits(&mut *services.state.write().await)
        .await?;
    services
        .sql_console_rate_limiter
        .refresh(&services.db)
        .await?;

    Ok(UpdateParametersResponse::Done)
}

pub fn router() -> OpenApiRouter {
    api_routes!(api_get, api_update_parameters,)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn login_protection_thresholds_are_bounded() {
        let valid = LoginProtectionParameters {
            enabled: true,
            ip_max_attempts: 20,
            ip_window_seconds: 900,
            ip_block_seconds: 1800,
            ip_max_block_seconds: 86400,
            user_max_attempts: 10,
            user_window_seconds: 3600,
            user_lockout_seconds: 0,
        };
        assert_eq!(valid.validate(), Ok(()));
        let invalid = [
            LoginProtectionParameters {
                ip_max_attempts: 0,
                ..valid.clone()
            },
            LoginProtectionParameters {
                user_max_attempts: 1001,
                ..valid.clone()
            },
            LoginProtectionParameters {
                ip_window_seconds: 59,
                ..valid.clone()
            },
            LoginProtectionParameters {
                user_window_seconds: 86401,
                ..valid.clone()
            },
            LoginProtectionParameters {
                ip_max_block_seconds: 1799,
                ..valid.clone()
            },
            LoginProtectionParameters {
                user_lockout_seconds: 30,
                ..valid.clone()
            },
        ];
        for parameters in invalid {
            assert!(parameters.validate().is_err(), "{parameters:?}");
        }
    }

    #[test]
    fn site_title_is_trimmed_cleared_and_bounded() {
        assert_eq!(
            normalize_site_title("  Ops Gateway "),
            Ok(Some("Ops Gateway".into()))
        );
        assert_eq!(normalize_site_title("   "), Ok(None));
        assert_eq!(
            normalize_site_title(&"堡".repeat(64)),
            Ok(Some("堡".repeat(64)))
        );
        assert!(normalize_site_title(&"x".repeat(65)).is_err());
        assert!(normalize_site_title("a\nb").is_err());
    }
}

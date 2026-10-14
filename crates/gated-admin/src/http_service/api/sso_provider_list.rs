use crate::http_service::session::Session;
use axum::extract::{Form, Query};
use axum::http::HeaderValue;
use axum::http::header::LOCATION;
use axum::http::request::Parts;
use axum::response::{Html, IntoResponse, Response};
use gated_common::web::{ApiResponse, Schemas};
use gated_common::web::{Data, Json};
use gated_common::{api_response, api_routes};
use serde::Serialize;
use std::ops::DerefMut;
use std::sync::Arc;
use utoipa::openapi::Responses;
use utoipa::{IntoParams, ToSchema};
use utoipa_axum::router::OpenApiRouter;

use gated_common::GatedError;
use gated_common::auth::{AuthCredential, AuthResult};
use gated_core::{ConfigProvider, Services};
use gated_sso::{SsoClient, SsoInternalProviderConfig};
use serde::Deserialize;
use tokio::sync::Mutex;
use tracing::*;

use super::sso_provider_detail::{SSO_CONTEXT_SESSION_KEY, SsoContext};
use crate::http_service::SsoLoginState;
use crate::http_service::api::common::logout;
use crate::http_service::common::{SessionExt, authorize_session, get_auth_state_for_request};
use crate::http_service::session::SessionStore;

#[derive(Serialize, ToSchema)]
pub enum SsoProviderKind {
    Google,
    Apple,
    Azure,
    Custom,
}

#[derive(Serialize, ToSchema)]
pub struct SsoProviderDescription {
    pub name: String,
    pub label: String,
    pub kind: SsoProviderKind,
}

api_response! {
    enum GetSsoProvidersResponse {
        #[oai(status = 200)]
        Ok(Json<Vec<SsoProviderDescription>>),
    }
}

api_response! {
    enum ReturnToSsoResponse {
        #[oai(status = 307)]
        Ok,
    }
}

/// A [`ReturnToSsoResponse::Ok`] pointing at the given location.
struct ReturnToSsoRedirect(String);

impl IntoResponse for ReturnToSsoRedirect {
    fn into_response(self) -> Response {
        let mut response = ReturnToSsoResponse::Ok.into_response();
        if let Ok(location) = HeaderValue::from_str(&self.0) {
            response.headers_mut().insert(LOCATION, location);
        }
        response
    }
}

impl ApiResponse for ReturnToSsoRedirect {
    fn responses(schemas: &mut Schemas) -> Responses {
        ReturnToSsoResponse::responses(schemas)
    }
}

api_response! {
    enum ReturnToSsoPostResponse {
        #[oai(status = 200)]
        Redirect(Html<String>),
    }
}

#[derive(Deserialize, ToSchema)]
pub struct ReturnToSsoFormData {
    pub code: Option<String>,
    pub state: Option<String>,
}

#[derive(Serialize, ToSchema)]
struct StartSloResponseParams {
    url: String,
}

api_response! {
    #[allow(clippy::large_enum_variant)]
    enum StartSloResponse {
        #[oai(status = 200)]
        Ok(Json<StartSloResponseParams>),
        #[oai(status = 400)]
        NotInSsoSession,
        #[oai(status = 404)]
        NotFound,
    }
}

fn make_redirect_url(err: &str) -> String {
    error!("SSO error: {err}");
    format!("/ui/?login_error={err}")
}

/// HTML-escape a string for safe interpolation into both element
/// text and single/double-quoted attribute contexts. Without this, an
/// attacker-controlled redirect target injects markup/script into the reflected
/// redirect page.
fn html_escape(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for c in input.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            _ => out.push(c),
        }
    }
    out
}

/// Accept only a local, same-origin relative path as a post-login
/// redirect target. Absolute URLs (`https://evil.com`), protocol-relative
/// targets (`//evil.com`), and backslash variants (`/\evil.com`, which some
/// browsers normalize to a host) are rejected so the caller can fall back to a
/// safe default. A single-slash-rooted path cannot carry a scheme/host.
fn sanitize_next_path(next: &str) -> Option<&str> {
    if !next.starts_with('/') {
        return None;
    }
    // Reject protocol-relative and backslash-smuggling targets.
    if next.starts_with("//") || next.starts_with("/\\") {
        return None;
    }
    Some(next)
}

/// The OIDC `state` returned by the IdP must equal the CSRF token
/// generated at authorize-time. An absent state is never valid.
fn sso_state_is_valid(expected_csrf: &str, returned_state: Option<&str>) -> bool {
    returned_state == Some(expected_csrf)
}

/// Compute which local roles SSO manages and which should be active
/// for this login, given the provider's optional role-mapping config and the
/// IdP-provided group claims.
///
/// Returns `(managed_role_names, active_role_names)`:
/// - With a mapping config, only the explicitly mapped local roles are managed,
///   and a group is activated only if it has an explicit mapping entry.
/// - Without a mapping config, SSO manages and grants nothing: IdP claims are
///   never synced verbatim.
fn compute_sso_role_sync(
    mappings: Option<&std::collections::HashMap<String, String>>,
    remote_groups: &[String],
) -> (Vec<String>, Vec<String>) {
    match mappings {
        Some(mappings) => {
            let managed = mappings.values().cloned().collect::<Vec<_>>();
            let active = remote_groups
                .iter()
                .filter_map(|group| mappings.get(group).cloned())
                .collect::<Vec<_>>();
            (managed, active)
        }
        None => (Vec::new(), Vec::new()),
    }
}

#[utoipa::path(get, path = "/sso/providers", operation_id = "get_sso_providers")]
async fn api_get_all_sso_providers(
    services: Data<Services>,
) -> Result<GetSsoProvidersResponse, GatedError> {
    let mut providers = services.config.read().await.store.sso_providers.clone();
    providers.sort_by(|a, b| a.label().cmp(b.label()));
    Ok(GetSsoProvidersResponse::Ok(Json(
        providers
            .into_iter()
            .map(|p| SsoProviderDescription {
                name: p.name.clone(),
                label: p.label().to_string(),
                kind: match p.provider {
                    SsoInternalProviderConfig::Google { .. } => SsoProviderKind::Google,
                    SsoInternalProviderConfig::Apple { .. } => SsoProviderKind::Apple,
                    SsoInternalProviderConfig::Azure { .. } => SsoProviderKind::Azure,
                    SsoInternalProviderConfig::Custom { .. } => SsoProviderKind::Custom,
                },
            })
            .collect(),
    )))
}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
struct ReturnToSsoGetQuery {
    code: Option<String>,
    state: Option<String>,
}

#[utoipa::path(
    get,
    path = "/sso/return",
    operation_id = "return_to_sso",
    params(ReturnToSsoGetQuery)
)]
async fn api_return_to_sso_get(
    req: Parts,
    session: Session,
    services: Data<Services>,
    Query(query): Query<ReturnToSsoGetQuery>,
) -> Result<ReturnToSsoRedirect, GatedError> {
    let ReturnToSsoGetQuery { code, state } = query;
    let url = api_return_to_sso_get_common(&req, &session, services, &code, &state)
        .await?
        .unwrap_or_else(|x| make_redirect_url(&x));

    Ok(ReturnToSsoRedirect(url))
}

#[utoipa::path(
    post,
    path = "/sso/return",
    operation_id = "return_to_sso_with_form_data"
)]
async fn api_return_to_sso_post(
    req: Parts,
    session: Session,
    services: Data<Services>,
    data: Form<ReturnToSsoFormData>,
) -> Result<ReturnToSsoPostResponse, GatedError> {
    let url = api_return_to_sso_get_common(&req, &session, services, &data.code, &data.state)
        .await?
        .unwrap_or_else(|x| make_redirect_url(&x));
    // Escape the URL for each output context it lands in.
    // Script context: prevent a `</script>` (or similar) breakout from a
    // valid JSON string by encoding the markup-significant characters.
    let serialized_url = serde_json::to_string(&url)?
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026");
    // HTML text/attribute context: encode `& < > " '`.
    let escaped_url = html_escape(&url);
    Ok(ReturnToSsoPostResponse::Redirect(Html(format!(
        "<!doctype html>\n
            <html>
                <script>
                    location.href = {serialized_url};
                </script>
                <body>
                    Redirecting to <a href='{escaped_url}'>{escaped_url}</a>...
                </body>
            </html>
        "
    ))))
}

async fn api_return_to_sso_get_common(
    req: &Parts,
    session: &Session,
    services: Data<Services>,
    code: &Option<String>,
    state: &Option<String>,
) -> Result<Result<String, String>, GatedError> {
    let Some(context) = session.get::<SsoContext>(SSO_CONTEXT_SESSION_KEY) else {
        return Ok(Err("Not in an active SSO process".to_string()));
    };

    let Some(ref code) = *code else {
        return Ok(Err(
            "No authorization code in the return URL request".to_string()
        ));
    };

    // Verify the returned `state` against the CSRF token we
    // generated at authorize-time *before* exchanging the code. A missing
    // or mismatched state is rejected (login CSRF / code injection).
    let expected_state = context.request.csrf_token().secret().clone();
    if !sso_state_is_valid(&expected_state, state.as_deref()) {
        return Ok(Err(
            "Invalid or missing SSO state parameter (possible CSRF)".to_string(),
        ));
    }

    let response = context
        .request
        .verify_code((*code).clone())
        .await
        .inspect_err(|e| {
            warn!(target: "audit","Failed to verify SSO code: {e:?}");
        })?;

    // Fail closed — a missing `email_verified` claim is treated
    // as unverified. The email must be explicitly asserted as verified
    // before it is used.
    if response.email_verified != Some(true) {
        return Ok(Err("The SSO account's e-mail is not verified".to_string()));
    }

    let Some(email) = response.email else {
        return Ok(Err("No e-mail information in the SSO response".to_string()));
    };

    info!(target: "audit","SSO login as {email}");

    let providers_config = services.config.read().await.store.sso_providers.clone();
    let mut iter = providers_config.iter();
    let Some(provider_config) = iter.find(|x| x.name == context.provider) else {
        return Ok(Err(format!("No provider matching {}", context.provider)));
    };

    let cred = AuthCredential::Sso {
        provider: context.provider.clone(),
        email: email.clone(),
        iss: response.iss.clone(),
        sub: response.sub.clone(),
    };

    let username = services
        .config_provider
        .lock()
        .await
        .username_for_sso_credential(&cred, response.preferred_username, provider_config.clone())
        .await?;
    let Some(username) = username else {
        return Ok(Err(format!("No user matching {email}")));
    };

    let mut auth_state_store = services.auth_state_store.lock().await;
    let state_arc = get_auth_state_for_request(&username, session, &mut auth_state_store).await?;

    let mut state = state_arc.lock().await;
    let mut cp = services.config_provider.lock().await;

    if state.user_info().username != username {
        return Ok(Err(format!(
            "Incorrect account for SSO authentication ({username})"
        )));
    }

    if cp.validate_credential(&username, &cred).await? {
        state.add_valid_credential(cred);
    } else {
        return Ok(Err(format!(
            "Failed to validate SSO credential for {username}"
        )));
    }

    if let AuthResult::Accepted { user_info } = state.verify() {
        auth_state_store.complete(state.id()).await;
        authorize_session(req, user_info).await?;
        session.set_sso_login_state(SsoLoginState {
            provider: context.provider,
            token: response.id_token,
            supports_single_logout: context.supports_single_logout,
        });
    }

    let mappings = provider_config.provider.role_mappings();
    if let Some(remote_groups) = response.groups {
        // Only roles explicitly allow-listed in the mapping
        // config are synced. Without a mapping config, SSO grants no roles
        // at all — IdP claims are never trusted verbatim.
        let (managed_role_names, active_role_names) =
            compute_sso_role_sync(mappings.as_ref(), &remote_groups);

        debug!(
            "SSO role mappings for {username}: active={active_role_names:?}, managed={managed_role_names:?}"
        );
        cp.apply_sso_role_mappings(&username, Some(managed_role_names), active_role_names)
            .await?;
    }

    // Only a validated local relative path may drive the
    // redirect; anything off-host falls back to the safe default.
    let next_path = context
        .next_url
        .as_deref()
        .and_then(sanitize_next_path)
        .unwrap_or("/ui/auth/login");
    let mut next_url = next_path.to_owned();

    // `next_path` is always a single-slash-rooted local path here, so
    // host-prefixing keeps the redirect on our own origin.
    if let Some(ref host) = context.return_host {
        next_url = format!("https://{}{}", host, next_url);
    }

    Ok(Ok(next_url))
}

#[utoipa::path(get, path = "/sso/logout", operation_id = "initiate_sso_logout")]
async fn api_start_slo(
    req: Parts,
    session: Session,
    services: Data<Services>,
    session_middleware: Data<Arc<Mutex<SessionStore>>>,
) -> Result<StartSloResponse, GatedError> {
    let Some(state) = session.get_sso_login_state() else {
        return Ok(StartSloResponse::NotInSsoSession);
    };

    let config = services.config.read().await;

    let return_url = config.construct_external_url(Some(&req), None)?;
    debug!("Return URL: {}", &return_url);

    let Some(provider_config) = config
        .store
        .sso_providers
        .iter()
        .find(|p| p.name == state.provider)
    else {
        return Ok(StartSloResponse::NotFound);
    };

    let client = SsoClient::new(provider_config.provider.clone())?;
    let logout_url = client.logout(state.token, return_url).await?;

    logout(&session, session_middleware.lock().await.deref_mut());

    Ok(StartSloResponse::Ok(Json(StartSloResponseParams {
        url: logout_url.to_string(),
    })))
}

pub fn router() -> OpenApiRouter {
    api_routes!(
        api_get_all_sso_providers,
        api_return_to_sso_get,
        api_return_to_sso_post,
        api_start_slo,
    )
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::{compute_sso_role_sync, html_escape, sanitize_next_path, sso_state_is_valid};

    // Off-host redirect targets are rejected; local paths pass.
    #[test]
    fn next_path_rejects_off_host_redirects() {
        assert!(sanitize_next_path("//evil.com").is_none());
        assert!(sanitize_next_path("https://evil.com").is_none());
        assert!(sanitize_next_path("/\\evil.com").is_none());
        assert!(sanitize_next_path("\\/evil.com").is_none());
        assert!(sanitize_next_path("evil.com").is_none());
        assert_eq!(sanitize_next_path("/ui/auth/login"), Some("/ui/auth/login"));
        assert_eq!(sanitize_next_path("/dashboard"), Some("/dashboard"));
    }

    // HTML-special characters are neutralized in every output context.
    #[test]
    fn html_escape_neutralizes_markup() {
        let escaped = html_escape("/ui/?x=</script><script>alert(1)</script>");
        assert!(!escaped.contains('<'));
        assert!(!escaped.contains('>'));
        assert!(escaped.contains("&lt;"));
        // The single quote that delimits the href attribute is encoded.
        assert_eq!(html_escape("a'b\"c&d"), "a&#x27;b&quot;c&amp;d");
    }

    #[test]
    fn state_must_match_csrf_token() {
        assert!(sso_state_is_valid("abc123", Some("abc123")));
        assert!(!sso_state_is_valid("abc123", Some("wrong")));
        // Absent state is rejected.
        assert!(!sso_state_is_valid("abc123", None));
        assert!(!sso_state_is_valid("abc123", Some("")));
    }

    #[test]
    fn no_mapping_config_grants_no_roles() {
        // Even if the IdP asserts an "admin" group, with no mapping config
        // nothing is managed and nothing is granted.
        let (managed, active) =
            compute_sso_role_sync(None, &["admin".to_string(), "users".to_string()]);
        assert!(managed.is_empty());
        assert!(active.is_empty());
    }

    #[test]
    fn only_explicitly_mapped_roles_are_synced() {
        let mut mappings = HashMap::new();
        mappings.insert("idp-ops".to_string(), "admin".to_string());
        mappings.insert("idp-staff".to_string(), "user".to_string());

        // The IdP sending the raw role name "admin" (not the mapped key) must
        // NOT grant the local "admin" role.
        let (_, active) = compute_sso_role_sync(Some(&mappings), &["admin".to_string()]);
        assert!(active.is_empty());

        // Only an explicitly mapped group grants its mapped local role.
        let (managed, active) = compute_sso_role_sync(
            Some(&mappings),
            &["idp-ops".to_string(), "unmapped".to_string()],
        );
        assert_eq!(active, vec!["admin".to_string()]);
        // Managed set is exactly the mapping's local role values.
        let mut managed_sorted = managed;
        managed_sorted.sort();
        assert_eq!(
            managed_sorted,
            vec!["admin".to_string(), "user".to_string()]
        );
    }
}

use openidconnect::core::CoreIdToken;

#[derive(Clone, Debug)]
pub struct SsoLoginResponse {
    pub name: Option<String>,
    pub email: Option<String>,
    pub email_verified: Option<bool>,
    pub groups: Option<Vec<String>>,
    pub id_token: CoreIdToken,
    pub preferred_username: Option<String>,
    /// OIDC issuer (`iss`) claim of the verified ID token.
    pub iss: String,
    /// OIDC subject (`sub`) claim of the verified ID token.
    pub sub: String,
}

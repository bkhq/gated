// Raw audit messages logged by the backend (`target: "audit"`), mapped to `events.*` keys.
const EXACT: Record<string, string> = {
  'Target connected': 'targetConnected',
  'target_connected': 'targetConnected',
  'Recording started': 'recordingStarted',
  'recording_started': 'recordingStarted',
  'Denied': 'accessDenied',
  'access_denied': 'accessDenied',
  'Host key is unknown': 'hostKeyUnknown',
  'Host key is invalid!': 'hostKeyInvalid',
  'Target host key is not trusted, but there is no active PTY channel to show the trust prompt on.': 'hostKeyUntrusted',
  'Accepted untrusted host key (auto-accept is enabled)': 'hostKeyAutoAccepted',
  'Rejected untrusted host key (auto-reject is enabled)': 'hostKeyAutoRejected',
  'Web user approval failed': 'webApprovalFailed',
  'File transfer is not allowed on this target': 'fileTransferDenied',
  'SFTP denied: file transfer is not allowed for the user\'s roles on this target': 'fileTransferDenied',
  'web_file_transfer_denied': 'fileTransferDenied',
  'web_file_operation': 'fileOperation',
  'sftp_file_operation': 'fileOperation',
  'auth_login_succeeded': 'loginSucceeded',
  'auth_login_rejected': 'loginRejected',
  'auth_login_rate_limited': 'loginRateLimited',
  'auth_otp_succeeded': 'otpSucceeded',
  'auth_otp_invalid': 'otpInvalid',
  'auth_otp_rate_limited': 'otpRateLimited',
  'auth_logout': 'logout',
  'auth_web_approval_succeeded': 'webApprovalSucceeded',
  'web_auth_stream_origin_rejected': 'originRejected',
  'credential_password_changed': 'passwordChanged',
  'credential_password_change_reauth_failed': 'passwordChangeReauthFailed',
  'credential_public_key_added': 'publicKeyAdded',
  'credential_public_key_deleted': 'publicKeyDeleted',
  'credential_otp_enrollment_started': 'otpEnrollmentStarted',
  'credential_otp_added': 'otpAdded',
  'credential_otp_deleted': 'otpDeleted',
  'credential_certificate_issued': 'certificateIssued',
  'credential_certificate_revoked': 'certificateRevoked',
  'encryption_init_succeeded': 'encryptionInitSucceeded',
  'encryption_init_failed': 'encryptionInitFailed',
  'encryption_init_database_detection_failed': 'encryptionInitFailed',
  'encryption_unlock_succeeded': 'encryptionUnlockSucceeded',
  'encryption_unlock_failed': 'encryptionUnlockFailed',
  'encryption_rekey_master_failed': 'encryptionRekeyFailed',
  'encryption_plaintext_backup_retained': 'encryptionPlaintextBackupRetained',
  'encryption_admin_audit': 'encryptionAdminAction',
  'failed to delete encryption bootstrap token': 'encryptionBootstrapTokenDeleteFailed',
}

// Messages that interpolate names or errors.
const PATTERNS: [RegExp, string][] = [
  [/^Target .+ not authorized for user /, 'targetNotAuthorized'],
  [/^Failed to verify SSO code/, 'ssoVerifyFailed'],
  [/^SSO login as /, 'ssoLogin'],
  [/^Auto-created SSO user /, 'ssoUserCreated'],
  [/^Adding role .+ \(from SSO\)$/, 'ssoRoleAdded'],
  [/^Removing role .+ \(from SSO\)$/, 'ssoRoleRemoved'],
]

export const KNOWN_EVENT_MESSAGES: readonly string[] = [
  ...Object.keys(EXACT),
  'Target db not authorized for user alice',
  'Failed to verify SSO code: error',
  'SSO login as alice@example.com',
  'Auto-created SSO user alice',
  'Adding role admin for user alice (from SSO)',
  'Removing role admin for user alice (from SSO)',
]

export function eventLabelKey(rawText: string): string {
  const text = rawText.trim()
  const name = EXACT[text] ?? PATTERNS.find(([pattern]) => pattern.test(text))?.[1] ?? 'other'
  return `events.${name}`
}

export function eventLabel(t: (key: string) => string, rawText: string): string {
  return t(eventLabelKey(rawText))
}

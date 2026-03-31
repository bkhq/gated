// Mock data for development without backend

export const mockUser = {
  id: '00000000-0000-0000-0000-000000000001',
  username: 'admin',
  description: 'Administrator',
  credential_policy: {},
  rate_limit_bytes_per_second: null,
}

export const mockInfo = {
  username: 'admin',
  admin: true,
  version: 'v0.0.0-mock',
  external_host: 'localhost',
  ports: { ssh: 2222, http: 8889, kubernetes: 8443, mysql: 33306, postgres: 55432 },
  authorized_via_sso_with_single_logout: false,
  authorized_via_ticket: false,
  has_ldap: false,
  minimize_password_login: false,
  own_credential_management_allowed: true,
  selected_target: null,
  setup_state: null,
}

export const mockTargets = [
  {
    name: 'prod-web-01',
    kind: 'Ssh',
    description: 'Production web server 1',
    group: { id: 'g1', name: 'production', color: 'red' },
  },
  {
    name: 'prod-web-02',
    kind: 'Ssh',
    description: 'Production web server 2',
    group: { id: 'g1', name: 'production', color: 'red' },
  },
  {
    name: 'staging-app',
    kind: 'Ssh',
    description: 'Staging application server',
    group: { id: 'g2', name: 'staging', color: 'yellow' },
  },
  {
    name: 'dev-db',
    kind: 'Ssh',
    description: 'Development database server',
    group: { id: 'g3', name: 'development', color: 'green' },
  },
  {
    name: 'k8s-cluster',
    kind: 'Kubernetes',
    description: 'Production Kubernetes cluster',
    group: null,
  },
  {
    name: 'mysql-prod',
    kind: 'MySql',
    description: 'Production MySQL database',
    group: { id: 'g1', name: 'production', color: 'red' },
  },
  {
    name: 'pg-analytics',
    kind: 'Postgres',
    description: 'Analytics PostgreSQL database',
    group: null,
  },
]

export const mockAdminTargets = mockTargets.map((t, i) => ({
  id: `t${i + 1}`,
  name: t.name,
  description: t.description,
  group_id: t.group?.id ?? null,
  options: {
    kind: t.kind,
    ...(t.kind === 'Ssh' ? { host: `10.0.0.${i + 1}`, port: 22, username: 'deploy', auth: { password: 'secret' }, allow_insecure_algos: false } : {}),
  },
}))

export const mockSessions = [
  {
    id: 's1',
    username: 'admin',
    target_name: 'prod-web-01',
    protocol: 'SSH',
    started: new Date(Date.now() - 3600000).toISOString(),
    ended: null,
    remote_address: '192.168.1.100:54321',
  },
  {
    id: 's2',
    username: 'admin',
    target_name: 'staging-app',
    protocol: 'SSH',
    started: new Date(Date.now() - 7200000).toISOString(),
    ended: new Date(Date.now() - 5400000).toISOString(),
    remote_address: '192.168.1.100:54322',
  },
  {
    id: 's3',
    username: 'devuser',
    target_name: 'dev-db',
    protocol: 'SSH',
    started: new Date(Date.now() - 86400000).toISOString(),
    ended: new Date(Date.now() - 82800000).toISOString(),
    remote_address: '10.0.0.50:12345',
  },
]

export const mockRoles = [
  { id: 'r1', name: 'admin', description: 'Full access to all targets' },
  { id: 'r2', name: 'developer', description: 'Access to development and staging targets' },
  { id: 'r3', name: 'readonly', description: 'Read-only access' },
]

export const mockUsers = [
  { ...mockUser },
  { id: 'u2', username: 'devuser', description: 'Developer', credential_policy: {}, rate_limit_bytes_per_second: null },
  { id: 'u3', username: 'ops', description: 'Operations team', credential_policy: {}, rate_limit_bytes_per_second: 1048576 },
]

export const mockTargetGroups = [
  { id: 'g1', name: 'production', description: 'Production servers', color: 'red' },
  { id: 'g2', name: 'staging', description: 'Staging environment', color: 'yellow' },
  { id: 'g3', name: 'development', description: 'Development servers', color: 'green' },
]

export const mockLogs = [
  { id: 'l1', timestamp: new Date(Date.now() - 60000).toISOString(), username: 'admin', message: 'User logged in', values: { client_ip: '192.168.1.100' }, session_id: null },
  { id: 'l2', timestamp: new Date(Date.now() - 120000).toISOString(), username: 'admin', message: 'Connected to prod-web-01', values: { client_ip: '192.168.1.100' }, session_id: 's1' },
  { id: 'l3', timestamp: new Date(Date.now() - 300000).toISOString(), username: 'devuser', message: 'User logged in', values: { client_ip: '10.0.0.50' }, session_id: null },
  { id: 'l4', timestamp: new Date(Date.now() - 600000).toISOString(), username: 'admin', message: 'Created user devuser', values: {}, session_id: null },
  { id: 'l5', timestamp: new Date(Date.now() - 3600000).toISOString(), username: 'admin', message: 'Added role developer to devuser', values: {}, session_id: null },
]

export const mockSshKeys = [
  { kind: 'ssh-ed25519', public_key_base64: 'AAAAC3NzaC1lZDI1NTE5AAAAIJMockKeyDataForDevelopmentPurposesOnly1234' },
  { kind: 'ssh-rsa', public_key_base64: 'AAAAB3NzaC1yc2EAAAADAQABAAABgQCmockRSAKeyDataForDev...' },
]

export const mockParameters = {
  allow_own_credential_management: true,
  rate_limit_bytes_per_second: null,
  ssh_auth_password: true,
  ssh_auth_publickey: true,
  ssh_auth_keyboard_interactive: true,
  minimize_password_login: false,
}

export const mockCredentials = {
  passwords: [{ id: 'pw1' }],
  public_keys: [
    { id: 'pk1', label: 'Laptop', abbreviated: 'ssh-ed25519 AAAA...1234', date_added: new Date(Date.now() - 86400000 * 30).toISOString() },
  ],
  otp: [],
  sso: [],
  certificates: [],
}

export const mockApiTokens = [
  { id: 'at1', name: 'CI Pipeline', created: new Date(Date.now() - 86400000 * 7).toISOString(), expiry: new Date(Date.now() + 86400000 * 90).toISOString() },
]

import { http, HttpResponse } from 'msw'
import {
  mockAdminTargets,
  mockApiTokens,
  mockCredentials,
  mockInfo,
  mockLogs,
  mockParameters,
  mockRoles,
  mockSessions,
  mockSshKeys,
  mockTargetGroups,
  mockTargets,
  mockUsers,
} from './data'

// Gateway API handlers
const gatewayHandlers = [
  // Auth
  http.post('/api/auth/login', () => HttpResponse.json(null, { status: 201 })),
  http.post('/api/auth/otp', () => HttpResponse.json(null, { status: 201 })),
  http.post('/api/auth/logout', () => HttpResponse.json(null, { status: 200 })),

  // Info
  http.get('/api/info', () => HttpResponse.json(mockInfo)),

  // SSO
  http.get('/api/sso/providers', () => HttpResponse.json([])),

  // Targets
  http.get('/api/targets', ({ request }) => {
    const url = new URL(request.url)
    const search = url.searchParams.get('search')
    const filtered = search != null && search !== ''
      ? mockTargets.filter(t => t.name.includes(search) || (t.description?.includes(search) ?? false))
      : mockTargets
    return HttpResponse.json(filtered)
  }),

  // Credentials
  http.get('/api/profile/credentials', () => HttpResponse.json(mockCredentials)),
  http.post('/api/profile/credentials/password', () => HttpResponse.json(null, { status: 201 })),
  http.post('/api/profile/credentials/public-keys', () =>
    HttpResponse.json({ id: crypto.randomUUID(), label: 'New Key', abbreviated: 'ssh-ed25519 AAAA...new' }, { status: 201 })),
  http.delete('/api/profile/credentials/public-keys/:id', () => new HttpResponse(null, { status: 204 })),
  http.post('/api/profile/credentials/otp', () =>
    HttpResponse.json({ id: crypto.randomUUID(), secret_key: [1, 2, 3, 4], provisioning_uri: 'otpauth://totp/Gated:admin?secret=MOCK' }, { status: 201 })),
  http.delete('/api/profile/credentials/otp/:id', () => new HttpResponse(null, { status: 204 })),

  // API Tokens
  http.get('/api/profile/api-tokens', () => HttpResponse.json(mockApiTokens)),
  http.post('/api/profile/api-tokens', () =>
    HttpResponse.json({ id: crypto.randomUUID(), name: 'New Token', secret: 'mock-secret-token-value', created: new Date().toISOString() }, { status: 201 })),
  http.delete('/api/profile/api-tokens/:id', () => new HttpResponse(null, { status: 204 })),
]

// Admin API handlers
const adminHandlers = [
  // Sessions
  http.get('/admin/api/sessions', () => HttpResponse.json(mockSessions)),
  http.get('/admin/api/sessions/:id', ({ params }) => {
    const session = mockSessions.find(s => s.id === params.id)
    return session != null ? HttpResponse.json(session) : new HttpResponse(null, { status: 404 })
  }),
  http.post('/admin/api/sessions/:id/close', () => HttpResponse.json(null, { status: 200 })),
  http.get('/admin/api/sessions/:id/recordings', () => HttpResponse.json([])),

  // Recordings
  http.get('/admin/api/recordings/:id', ({ params }) =>
    HttpResponse.json({ id: params.id, name: 'recording', started: new Date().toISOString(), ended: null, metadata: '{}' })),

  // Users
  http.get('/admin/api/users', () => HttpResponse.json(mockUsers)),
  http.post('/admin/api/users', async ({ request }) => {
    const body = await request.json() as Record<string, unknown>
    return HttpResponse.json({ id: crypto.randomUUID(), ...body, credential_policy: {} }, { status: 201 })
  }),
  http.get('/admin/api/users/:id', ({ params }) => {
    const user = mockUsers.find(u => u.id === params.id)
    return user != null ? HttpResponse.json(user) : new HttpResponse(null, { status: 404 })
  }),
  http.put('/admin/api/users/:id', () => HttpResponse.json(null, { status: 200 })),
  http.delete('/admin/api/users/:id', () => new HttpResponse(null, { status: 204 })),

  // User roles
  http.get('/admin/api/users/:id/roles', () => HttpResponse.json(mockRoles.slice(0, 1))),
  http.post('/admin/api/users/:id/roles/:roleId', () => new HttpResponse(null, { status: 201 })),
  http.delete('/admin/api/users/:id/roles/:roleId', () => new HttpResponse(null, { status: 204 })),

  // User credentials (password, sso, public-keys, otp, certificates)
  http.get('/admin/api/users/:userId/credentials/passwords', () => HttpResponse.json([{ id: 'pw1' }])),
  http.post('/admin/api/users/:userId/credentials/passwords', () => HttpResponse.json({ id: crypto.randomUUID() }, { status: 201 })),
  http.delete('/admin/api/users/:userId/credentials/passwords/:id', () => new HttpResponse(null, { status: 204 })),
  http.get('/admin/api/users/:userId/credentials/sso', () => HttpResponse.json([])),
  http.post('/admin/api/users/:userId/credentials/sso', () => HttpResponse.json({ id: crypto.randomUUID() }, { status: 201 })),
  http.delete('/admin/api/users/:userId/credentials/sso/:id', () => new HttpResponse(null, { status: 204 })),
  http.get('/admin/api/users/:userId/credentials/public-keys', () => HttpResponse.json([])),
  http.post('/admin/api/users/:userId/credentials/public-keys', () => HttpResponse.json({ id: crypto.randomUUID() }, { status: 201 })),
  http.delete('/admin/api/users/:userId/credentials/public-keys/:id', () => new HttpResponse(null, { status: 204 })),
  http.get('/admin/api/users/:userId/credentials/otp', () => HttpResponse.json([])),
  http.post('/admin/api/users/:userId/credentials/otp', () => HttpResponse.json({ id: crypto.randomUUID() }, { status: 201 })),
  http.delete('/admin/api/users/:userId/credentials/otp/:id', () => new HttpResponse(null, { status: 204 })),
  http.get('/admin/api/users/:userId/credentials/certificates', () => HttpResponse.json([])),
  http.post('/admin/api/users/:userId/credentials/certificates', () =>
    HttpResponse.json({ id: crypto.randomUUID(), certificate_pem: '-----BEGIN CERTIFICATE-----\nMOCK\n-----END CERTIFICATE-----' }, { status: 201 })),
  http.delete('/admin/api/users/:userId/credentials/certificates/:id', () => new HttpResponse(null, { status: 204 })),

  // Roles
  http.get('/admin/api/roles', () => HttpResponse.json(mockRoles)),
  http.post('/admin/api/roles', async ({ request }) => {
    const body = await request.json() as Record<string, unknown>
    return HttpResponse.json({ id: crypto.randomUUID(), ...body }, { status: 201 })
  }),
  http.get('/admin/api/role/:id', ({ params }) => {
    const role = mockRoles.find(r => r.id === params.id)
    return role != null ? HttpResponse.json(role) : new HttpResponse(null, { status: 404 })
  }),
  http.put('/admin/api/role/:id', () => HttpResponse.json(null, { status: 200 })),
  http.delete('/admin/api/role/:id', () => new HttpResponse(null, { status: 204 })),
  http.get('/admin/api/role/:id/users', () => HttpResponse.json(mockUsers.slice(0, 1))),
  http.get('/admin/api/role/:id/targets', () => HttpResponse.json(mockAdminTargets.slice(0, 2))),

  // Targets (admin)
  http.get('/admin/api/targets', () => HttpResponse.json(mockAdminTargets)),
  http.post('/admin/api/targets', async ({ request }) => {
    const body = await request.json() as Record<string, unknown>
    return HttpResponse.json({ id: crypto.randomUUID(), ...body }, { status: 201 })
  }),
  http.get('/admin/api/targets/:id', ({ params }) => {
    const target = mockAdminTargets.find(t => t.id === params.id)
    return target != null ? HttpResponse.json(target) : new HttpResponse(null, { status: 404 })
  }),
  http.put('/admin/api/targets/:id', () => HttpResponse.json(null, { status: 200 })),
  http.delete('/admin/api/targets/:id', () => new HttpResponse(null, { status: 204 })),
  http.get('/admin/api/targets/:id/roles', () => HttpResponse.json(mockRoles.slice(0, 1))),
  http.get('/admin/api/targets/:id/known-ssh-host-keys', () => HttpResponse.json([])),
  http.post('/admin/api/targets/:id/roles/:roleId', () => new HttpResponse(null, { status: 201 })),
  http.delete('/admin/api/targets/:id/roles/:roleId', () => new HttpResponse(null, { status: 204 })),

  // Target Groups
  http.get('/admin/api/target-groups', () => HttpResponse.json(mockTargetGroups)),
  http.post('/admin/api/target-groups', async ({ request }) => {
    const body = await request.json() as Record<string, unknown>
    return HttpResponse.json({ id: crypto.randomUUID(), ...body }, { status: 201 })
  }),
  http.get('/admin/api/target-groups/:id', ({ params }) => {
    const group = mockTargetGroups.find(g => g.id === params.id)
    return group != null ? HttpResponse.json(group) : new HttpResponse(null, { status: 404 })
  }),
  http.put('/admin/api/target-groups/:id', () => HttpResponse.json(null, { status: 200 })),
  http.delete('/admin/api/target-groups/:id', () => new HttpResponse(null, { status: 204 })),

  // Tickets
  http.get('/admin/api/tickets', () => HttpResponse.json([])),
  http.post('/admin/api/tickets', () =>
    HttpResponse.json({ id: crypto.randomUUID(), secret: 'ticket-mock-secret' }, { status: 201 })),
  http.delete('/admin/api/tickets/:id', () => new HttpResponse(null, { status: 204 })),

  // SSH
  http.get('/admin/api/ssh/own-keys', () => HttpResponse.json(mockSshKeys)),
  http.get('/admin/api/ssh/known-hosts', () => HttpResponse.json([])),
  http.post('/admin/api/ssh/known-hosts', () => HttpResponse.json({ id: crypto.randomUUID() }, { status: 201 })),
  http.delete('/admin/api/ssh/known-hosts/:id', () => new HttpResponse(null, { status: 204 })),
  http.post('/admin/api/ssh/check-host-key', () =>
    HttpResponse.json({ remote_key_type: 'ssh-ed25519', remote_key_base64: 'AAAAC3NzaC1lZDI1NTE5AAAAIMockHostKey' })),

  // Logs
  http.post('/admin/api/logs', () => HttpResponse.json(mockLogs)),

  // Parameters
  http.get('/admin/api/parameters', () => HttpResponse.json(mockParameters)),
  http.put('/admin/api/parameters', () => HttpResponse.json(null, { status: 200 })),

  // LDAP
  http.get('/admin/api/ldap-servers', () => HttpResponse.json([])),
  http.post('/admin/api/ldap-servers', () => HttpResponse.json({ id: crypto.randomUUID() }, { status: 201 })),
  http.post('/admin/api/ldap-servers/test', () => HttpResponse.json({ success: true })),

  // User LDAP linking
  http.post('/admin/api/users/:id/ldap-link/unlink', () => HttpResponse.json(null, { status: 200 })),
  http.post('/admin/api/users/:id/ldap-link/auto-link', () => HttpResponse.json(null, { status: 200 })),
]

export const handlers = [...gatewayHandlers, ...adminHandlers]

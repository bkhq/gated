// TanStack Query hooks for the admin API
// These will be populated once the OpenAPI client is generated.
// Run `bun run openapi` to generate the client.

export const adminKeys = {
  sessions: ['admin', 'sessions'] as const,
  session: (id: string) => ['admin', 'sessions', id] as const,
  recordings: ['admin', 'recordings'] as const,
  recording: (id: string) => ['admin', 'recordings', id] as const,
  targets: ['admin', 'targets'] as const,
  target: (id: string) => ['admin', 'targets', id] as const,
  users: ['admin', 'users'] as const,
  user: (id: string) => ['admin', 'users', id] as const,
  roles: ['admin', 'roles'] as const,
  role: (id: string) => ['admin', 'roles', id] as const,
  tickets: ['admin', 'tickets'] as const,
  sshKeys: ['admin', 'ssh-keys'] as const,
  knownHosts: ['admin', 'known-hosts'] as const,
  parameters: ['admin', 'parameters'] as const,
  logs: ['admin', 'logs'] as const,
  ldapServers: ['admin', 'ldap-servers'] as const,
  ldapServer: (id: string) => ['admin', 'ldap-servers', id] as const,
  targetGroups: ['admin', 'target-groups'] as const,
  targetGroup: (id: string) => ['admin', 'target-groups', id] as const,
}

// TODO: Uncomment and implement once OpenAPI client is generated
// import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
// import { api } from '@/features/admin/lib/api'

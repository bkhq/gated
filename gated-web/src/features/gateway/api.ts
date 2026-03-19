// TanStack Query hooks for the gateway API
// These will be populated once the OpenAPI client is generated.
// Run `bun run openapi` to generate the client.

export const gatewayKeys = {
  info: ['gateway', 'info'] as const,
  targets: ['gateway', 'targets'] as const,
  credentials: ['gateway', 'credentials'] as const,
  apiTokens: ['gateway', 'api-tokens'] as const,
  ssoProviders: ['gateway', 'sso-providers'] as const,
}

// TODO: Uncomment and implement once OpenAPI client is generated
// import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
// import { api } from '@/features/gateway/lib/api'

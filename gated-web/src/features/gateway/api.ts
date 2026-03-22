import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, ResponseError } from '@/features/gateway/lib/api'

export const gatewayKeys = {
  info: ['gateway', 'info'] as const,
  targets: ['gateway', 'targets'] as const,
  credentials: ['gateway', 'credentials'] as const,
  apiTokens: ['gateway', 'api-tokens'] as const,
  ssoProviders: ['gateway', 'sso-providers'] as const,
}

export function useInfoQuery() {
  return useQuery({
    queryKey: gatewayKeys.info,
    queryFn: () => api.getInfo(),
    retry: false,
  })
}

export function useSsoProvidersQuery() {
  return useQuery({
    queryKey: gatewayKeys.ssoProviders,
    queryFn: () => api.getSsoProviders(),
    retry: false,
  })
}

export function useLoginMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: { username: string; password: string }) => api.login(req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: gatewayKeys.info })
    },
  })
}

export function useOtpLoginMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (req: { otp: string }) => api.otpLogin(req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: gatewayKeys.info })
    },
  })
}

export function useLogoutMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => api.logout(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: gatewayKeys.info })
    },
  })
}

export function useStartSsoMutation() {
  return useMutation({
    mutationFn: ({ name, next }: { name: string; next?: string }) => api.startSso(name, next),
  })
}

export { ResponseError }

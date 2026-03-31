import type { NewApiToken, NewOtpCredential, NewPublicKeyCredential } from '@/features/gateway/lib/api-client'
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
    queryFn: async () => api.getInfo(),
    retry: false,
  })
}

export function useSsoProvidersQuery() {
  return useQuery({
    queryKey: gatewayKeys.ssoProviders,
    queryFn: async () => api.getSsoProviders(),
    retry: false,
  })
}

export function useLoginMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: { username: string, password: string }) => api.login(req),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: gatewayKeys.info })
    },
  })
}

export function useOtpLoginMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: { otp: string }) => api.otpLogin(req),
    onSuccess: () => {
      queryClient.removeQueries({ queryKey: gatewayKeys.info })
    },
  })
}

export function useLogoutMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async () => api.logout(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: gatewayKeys.info })
    },
  })
}

export function useStartSsoMutation() {
  return useMutation({
    mutationFn: async ({ name, next }: { name: string, next?: string }) => api.startSso(name, next),
  })
}

export function useTargetsQuery(search?: string) {
  return useQuery({
    queryKey: [...gatewayKeys.targets, search],
    queryFn: async () => api.getTargets(search),
    retry: false,
  })
}

export function useCredentialsQuery() {
  return useQuery({
    queryKey: gatewayKeys.credentials,
    queryFn: async () => api.getMyCredentials(),
    retry: false,
  })
}

export function useChangePasswordMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (password: string) => api.changeMyPassword({ password }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: gatewayKeys.credentials })
    },
  })
}

export function useAddPublicKeyMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: NewPublicKeyCredential) => api.addMyPublicKey(req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: gatewayKeys.credentials })
    },
  })
}

export function useDeletePublicKeyMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => api.deleteMyPublicKey(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: gatewayKeys.credentials })
    },
  })
}

export function useAddOtpMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: NewOtpCredential) => api.addMyOtp(req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: gatewayKeys.credentials })
    },
  })
}

export function useDeleteOtpMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => api.deleteMyOtp(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: gatewayKeys.credentials })
    },
  })
}

export function useApiTokensQuery() {
  return useQuery({
    queryKey: gatewayKeys.apiTokens,
    queryFn: async () => api.getMyApiTokens(),
    retry: false,
  })
}

export function useCreateApiTokenMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (req: NewApiToken) => api.createApiToken(req),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: gatewayKeys.apiTokens })
    },
  })
}

export function useDeleteApiTokenMutation() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => api.deleteMyApiToken(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: gatewayKeys.apiTokens })
    },
  })
}

export { ResponseError }

import type { LoginRequest, OtpLoginRequest } from '@/shared/lib/api/auth'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  continueAuth,
  getAuthState,
  login,
  logout,
  submitOtp,
} from '@/shared/lib/api/auth'
import { listProviders, startSso } from '@/shared/lib/api/sso'

export function useLogin() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (req: LoginRequest) => login(req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['info'] })
      void qc.invalidateQueries({ queryKey: ['auth-state'] })
    },
  })
}

export function useSubmitOtp() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (req: OtpLoginRequest) => submitOtp(req),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['info'] })
      void qc.invalidateQueries({ queryKey: ['auth-state'] })
    },
  })
}

export function useContinueAuth() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => continueAuth(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['info'] })
      void qc.invalidateQueries({ queryKey: ['auth-state'] })
    },
  })
}

export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => logout(),
    onSuccess: () => {
      qc.removeQueries()
    },
  })
}

export function useAuthState(refetchInterval: number | false = false) {
  return useQuery({
    queryKey: ['auth-state'],
    queryFn: async ({ signal }) => getAuthState(signal),
    staleTime: 0,
    retry: false,
    refetchInterval,
  })
}

export function useSsoProviders(enabled = true) {
  return useQuery({
    queryKey: ['sso-providers'],
    queryFn: async ({ signal }) => listProviders(signal),
    staleTime: 60_000,
    retry: false,
    enabled,
  })
}

export function useStartSso() {
  return useMutation({
    mutationFn: async (name: string) => startSso(name),
  })
}

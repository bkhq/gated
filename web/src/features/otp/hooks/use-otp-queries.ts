import type { OtpDeviceDraft } from '@/shared/types/drafts'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { profileApi } from '@/shared/lib/api/profile'

export function useOtpDevices() {
  return useQuery({ queryKey: ['otp-devices'], queryFn: async ({ signal }) => profileApi.otpDevices.list(signal) })
}

export function useAddOtpDevice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (draft: OtpDeviceDraft) => profileApi.otpDevices.add(draft),
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['otp-devices'] }),
  })
}

export function useRemoveOtpDevice() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string) => {
      await profileApi.otpDevices.remove(id)
      return { id }
    },
    onSuccess: async () => qc.invalidateQueries({ queryKey: ['otp-devices'] }),
  })
}

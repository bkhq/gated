import { useEffect } from 'react'
import { useInfoQuery } from '@/features/gateway/api'
import { useAuthStore } from '@/shared/stores/auth'

export function useAuthInit() {
  const { setAuth, clearAuth } = useAuthStore()
  const infoQuery = useInfoQuery()

  useEffect(() => {
    if (infoQuery.isSuccess) {
      const info = infoQuery.data
      if (info.username) {
        setAuth(info.username, false)
      } else {
        clearAuth()
      }
    } else if (infoQuery.isError) {
      clearAuth()
    }
  }, [infoQuery.isSuccess, infoQuery.isError, infoQuery.data, setAuth, clearAuth])
}

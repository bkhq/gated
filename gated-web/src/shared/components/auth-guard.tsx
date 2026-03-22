import { Loader2 } from 'lucide-react'
import { Navigate, Outlet, useLocation } from 'react-router'
import { useAuthStore } from '@/shared/stores/auth'

export function RequireAuth() {
  const { isAuthenticated, initialized } = useAuthStore()
  const location = useLocation()

  if (!initialized) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/@gated/login" state={{ from: location }} replace />
  }

  return <Outlet />
}

export function RequireAdmin() {
  const { isAuthenticated, isAdmin, initialized } = useAuthStore()
  const location = useLocation()

  if (!initialized) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!isAuthenticated) {
    return <Navigate to="/@gated/login" state={{ from: location }} replace />
  }

  if (!isAdmin) {
    return <Navigate to="/@gated" replace />
  }

  return <Outlet />
}

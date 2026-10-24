import { createRootRoute } from '@tanstack/react-router'
import { AppLayout } from '@/app/shell/layout'
import { RouteError } from '@/app/shell/route-error'
import { BootGate } from '@/features/encryption/boot-gate'

export const Route = createRootRoute({
  component: () => (
    <BootGate>
      <AppLayout />
    </BootGate>
  ),
  errorComponent: RouteError,
})

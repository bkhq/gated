import { createRootRoute } from '@tanstack/react-router'
import { AppLayout } from '@/app/shell/layout'
import { BootGate } from '@/features/encryption/boot-gate'

export const Route = createRootRoute({
  component: () => (
    <BootGate>
      <AppLayout />
    </BootGate>
  ),
})

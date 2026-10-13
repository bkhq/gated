import * as React from 'react'
import { useLockStatus } from '@/shared/hooks/use-lock-status'
import { BootstrapPage } from './bootstrap-page'
import { LockErrorPage, LockPendingPage } from './error-page'
import { UnlockPage } from './unlock-page'

/**
 * Boot-time encryption gate. Wraps the rest of the app and blocks rendering
 * until the gateway reports an "openable" lock-status:
 *
 *   - `disabled`       → encryption isn't enabled; render children unchanged.
 *   - `unlocked`       → render children.
 *   - `uninitialized`  → show the bootstrap wizard (operator enters the
 *                        bootstrap token + a master password).
 *   - `locked`         → show the unlock screen.
 *   - `error`          → show the error screen with a manual retry button;
 *                        `useLockStatus` keeps polling every 3 s, so the
 *                        screen self-clears once the gateway recovers.
 *
 * If the lock-status query itself fails (network down, gateway not yet
 * listening), the error screen is shown until the next successful fetch.
 */
export function BootGate({ children }: { children: React.ReactNode }) {
  const { data, isLoading, isError, refetch, isFetching } = useLockStatus()

  if (isLoading)
    return <LockPendingPage />

  if (isError) {
    return (
      <LockErrorPage
        onRetry={() => {
          void refetch()
        }}
        retrying={isFetching}
      />
    )
  }

  // After isLoading/isError, the query has succeeded and `data` is defined,
  // but TS sees the success path as `undefined`-able via `useQuery`. Treat a
  // missing/unknown status defensively by falling through to the error page
  // rather than leaking the app shell.
  const status = data?.status
  switch (status) {
    case 'disabled':
    case 'unlocked':
      return <>{children}</>
    case 'uninitialized':
      return <BootstrapPage />
    case 'locked':
      return <UnlockPage />
    case 'error':
    case undefined:
    default:
      return (
        <LockErrorPage
          onRetry={() => {
            void refetch()
          }}
          retrying={isFetching}
        />
      )
  }
}

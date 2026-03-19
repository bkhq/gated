import { QueryClientProvider } from '@tanstack/react-query'
import { Suspense } from 'react'
import { I18nextProvider } from 'react-i18next'
import { ThemeProvider } from '@/shared/components/theme-provider'
import i18n from './i18n'
import { queryClient } from './query-client'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <I18nextProvider i18n={i18n}>
      <Suspense>
        <QueryClientProvider client={queryClient}>
          <ThemeProvider defaultTheme="system" storageKey="gated-theme">
            {children}
          </ThemeProvider>
        </QueryClientProvider>
      </Suspense>
    </I18nextProvider>
  )
}

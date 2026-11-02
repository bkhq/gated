import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import * as React from 'react'
import { I18nextProvider } from 'react-i18next'
import i18n from '@/i18n'
import { TooltipProvider } from '@/shared/ui/tooltip'
import { useAppStore } from '@/store/app-store'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      retry: 1,
    },
  },
})

export function Providers({ children }: { children: React.ReactNode }) {
  const theme = useAppStore(state => state.theme)
  const setTheme = useAppStore(state => state.setTheme)

  React.useEffect(() => {
    const requestedTheme = new URLSearchParams(window.location.search).get('theme')
    if (requestedTheme === 'dark' || requestedTheme === 'light' || requestedTheme === 'system') {
      setTheme(requestedTheme)
    }
  }, [setTheme])

  React.useEffect(() => {
    if (theme !== 'system') {
      document.documentElement.classList.toggle('dark', theme === 'dark')
      return
    }
    const mql = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = () => document.documentElement.classList.toggle('dark', mql.matches)
    apply()
    mql.addEventListener('change', apply)
    return () => mql.removeEventListener('change', apply)
  }, [theme])

  return (
    <I18nextProvider i18n={i18n}>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider delay={120} closeDelay={0}>
          {children}
        </TooltipProvider>
      </QueryClientProvider>
    </I18nextProvider>
  )
}

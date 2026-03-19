import { use } from 'react'
import { ThemeProviderContext } from '@/shared/lib/theme-context'

export function useTheme() {
  return use(ThemeProviderContext)
}

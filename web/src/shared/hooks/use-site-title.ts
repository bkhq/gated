import { useInfo } from '@/shared/hooks/use-info'

export const DEFAULT_SITE_TITLE = 'Gated'

/** The configured site title, or the built-in default while unset/unavailable. */
export function useSiteTitle(): string {
  return useInfo().data?.site_title?.trim() || DEFAULT_SITE_TITLE
}

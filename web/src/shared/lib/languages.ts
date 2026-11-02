import type { Lang } from '@/store/app-store'

export interface SupportedLang {
  code: Lang
  label: string
}

export const SUPPORTED_LANGS: readonly SupportedLang[] = [
  { code: 'zh-CN', label: '简体中文' },
  { code: 'en', label: 'English' },
] as const

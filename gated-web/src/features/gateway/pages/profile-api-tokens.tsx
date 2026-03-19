import { useTranslation } from 'react-i18next'

export function Component() {
  const { t } = useTranslation('gateway')
  return <h1>{t('pages.apiTokens')}</h1>
}

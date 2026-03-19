import { useTranslation } from 'react-i18next'

export function Component() {
  const { t } = useTranslation('admin')
  return <h1>{t('pages.createTicket')}</h1>
}

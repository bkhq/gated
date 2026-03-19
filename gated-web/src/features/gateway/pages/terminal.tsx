import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'

export function Component() {
  const { targetName } = useParams()
  const { t } = useTranslation('gateway')
  return <h1>{t('pages.terminal', { targetName })}</h1>
}

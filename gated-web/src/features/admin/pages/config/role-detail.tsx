import { useTranslation } from 'react-i18next'
import { useParams } from 'react-router'

export function Component() {
  const { id } = useParams()
  const { t } = useTranslation('admin')
  return <h1>{t('pages.roleDetail', { id })}</h1>
}

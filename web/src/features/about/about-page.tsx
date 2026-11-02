import { useTranslation } from 'react-i18next'
import { PageHeader } from '@/shared/components/page-header'
import { AboutPanel } from './about-panel'

export function AboutPage() {
  const { t } = useTranslation()
  return (
    <>
      <PageHeader title={t('about.title')} description={t('about.description')} />
      <AboutPanel />
    </>
  )
}

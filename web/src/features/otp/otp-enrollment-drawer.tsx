import { useMutation } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { profileApi } from '@/shared/lib/api/profile'
import { otpCode } from '@/shared/lib/otp'
import { Button } from '@/shared/ui/button'
import { Drawer } from '@/shared/ui/drawer'
import { Input } from '@/shared/ui/input'
import { useAddOtpDevice } from './hooks/use-otp-queries'

export function OtpEnrollmentDrawer({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation()
  const begin = useMutation({ mutationFn: async () => profileApi.otpDevices.begin() })
  const confirm = useAddOtpDevice()
  const [otp, setOtp] = useState('')
  const uri = begin.data?.provisioning_uri
  const secret = uri ? new URL(uri).searchParams.get('secret') ?? '' : ''
  const busy = begin.isPending || confirm.isPending

  return (
    <Drawer open onClose={onClose}>
      <form
        className="flex h-full flex-col gap-4 p-6"
        onSubmit={(event) => {
          event.preventDefault()
          if (busy)
            return
          if (!uri)
            begin.mutate()
          else if (/^\d{6}$/.test(otp))
            confirm.mutate({ otp }, { onSuccess: onClose })
        }}
      >
        <h2 className="text-lg font-semibold">{t('profile.auth.otpDrawer.titleNew')}</h2>
        <p>{t('otpEnrollment.instructions')}</p>
        {uri && (
          <>
            <QRCodeSVG
              value={uri}
              size={176}
              marginSize={2}
              bgColor="#ffffff"
              fgColor="#000000"
              role="img"
              aria-label={t('otpEnrollment.qr')}
              className="self-center rounded-md"
            />
            <label htmlFor="otp-secret">{t('otpEnrollment.secret')}</label>
            <Input id="otp-secret" value={secret} readOnly />
            <a href={uri} className="underline">{t('otpEnrollment.openApp')}</a>
            <label htmlFor="otp-proof">{t('otpEnrollment.code')}</label>
            <Input id="otp-proof" value={otp} onChange={event => setOtp(otpCode(event.target.value))} inputMode="numeric" autoComplete="one-time-code" />
          </>
        )}
        <div className="mt-auto flex justify-end gap-2">
          <Button type="button" variant="outline" onClick={onClose}>{t('actions.cancel')}</Button>
          <Button type="submit" disabled={busy || (!!uri && !/^\d{6}$/.test(otp))}>{t(uri ? 'otpEnrollment.confirm' : 'otpEnrollment.begin')}</Button>
        </div>
      </form>
    </Drawer>
  )
}

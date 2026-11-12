import type { PublicKey } from '@/shared/types/domain'
import { useTranslation } from 'react-i18next'
import { Badge } from '@/shared/ui/badge'

/** `ssh-ed25519 AAAA…` → `ED25519`. */
function keyType(publicKey: string): string {
  const algorithm = publicKey.trim().split(/\s+/)[0] ?? ''
  return algorithm.replace(/^(?:ssh|ecdsa-sha2|sk-ssh|sk-ecdsa-sha2)-/, '').replace(/@.*$/, '').toUpperCase()
}

/** Name, type, fingerprint and usage of one registered SSH public key. */
export function PublicKeySummary({ publicKey }: { publicKey: PublicKey }) {
  const { t } = useTranslation()
  const type = keyType(publicKey.publicKey)
  return (
    <div className="min-w-0 flex-1">
      <div className="flex min-w-0 items-center gap-2">
        <span className="truncate text-[13.5px] font-medium">{publicKey.name}</span>
        {type && <Badge tone="mono" className="shrink-0 font-mono text-[10px]">{type}</Badge>}
      </div>
      <div className="mono mt-0.5 truncate text-[11.5px] text-muted-foreground select-all" title={publicKey.fingerprint}>
        {publicKey.fingerprint}
      </div>
      <div className="mt-1 text-[11.5px] text-muted-foreground">
        {t('profile.auth.added', { when: publicKey.added })}
        {' · '}
        {publicKey.lastUsed === 'never'
          ? t('profile.auth.neverUsed')
          : t('profile.auth.lastUsed', { when: publicKey.lastUsed })}
      </div>
    </div>
  )
}

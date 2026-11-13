import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { liftIpBlock, liftUserLockout, listIpBlocks, listUserLockouts } from '@/shared/lib/api/login-protection'
import { formatDateTime } from '@/shared/lib/format-time'
import { Button } from '@/shared/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/shared/ui/card'
import { Skeleton } from '@/shared/ui/skeleton'
import { Table, TBody, TD, TH, THead, TR } from '@/shared/ui/table'

const QUERY_KEY = ['login-protection'] as const

/** Addresses and users currently refused at sign-in, with a way to let them back in. */
export function LoginProtectionCard() {
  const { t, i18n } = useTranslation()
  const qc = useQueryClient()
  const query = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async ({ signal }) => {
      const [ipBlocks, userLockouts] = await Promise.all([listIpBlocks(signal), listUserLockouts(signal)])
      return { ipBlocks, userLockouts }
    },
  })
  const onSuccess = async () => qc.invalidateQueries({ queryKey: QUERY_KEY })
  const unblock = useMutation({ mutationFn: async (ip: string) => liftIpBlock(ip), onSuccess })
  const unlock = useMutation({ mutationFn: async (username: string) => liftUserLockout(username), onSuccess })
  const time = (iso: string) => formatDateTime(iso, i18n.language)

  return (
    <div className="px-6 pt-4">
      <Card>
        <CardHeader>
          <CardTitle>{t('settings.loginProtection.title')}</CardTitle>
          <div className="mt-1 text-[12.5px] text-muted-foreground">{t('settings.loginProtection.hint')}</div>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {query.isLoading
            ? <Skeleton className="h-4 w-full" />
            : !query.data
                ? <div role="alert" className="text-[12.5px] text-destructive">{t('settings.loginProtection.loadError')}</div>
                : (
                    <>
                      <section className="flex flex-col gap-2">
                        <h3 className="m-0 text-[13px] font-medium">{t('settings.loginProtection.ipBlocks')}</h3>
                        {query.data.ipBlocks.length === 0
                          ? <div className="text-[12.5px] text-muted-foreground">{t('settings.loginProtection.noIpBlocks')}</div>
                          : (
                              <Table>
                                <THead>
                                  <TR>
                                    <TH>{t('settings.loginProtection.address')}</TH>
                                    <TH>{t('settings.loginProtection.since')}</TH>
                                    <TH>{t('settings.loginProtection.until')}</TH>
                                    <TH>{t('settings.loginProtection.blockCount')}</TH>
                                    <TH />
                                  </TR>
                                </THead>
                                <TBody>
                                  {query.data.ipBlocks.map(block => (
                                    <TR key={block.ip_address}>
                                      <TD className="font-mono">{block.ip_address}</TD>
                                      <TD className="text-muted-foreground">{time(block.blocked_at)}</TD>
                                      <TD className="text-muted-foreground">{time(block.expires_at)}</TD>
                                      <TD>{block.block_count}</TD>
                                      <TD className="text-right">
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          disabled={unblock.isPending}
                                          aria-label={t('settings.loginProtection.unblockLabel', { ip: block.ip_address })}
                                          onClick={() => unblock.mutate(block.ip_address)}
                                        >
                                          {t('settings.loginProtection.unblock')}
                                        </Button>
                                      </TD>
                                    </TR>
                                  ))}
                                </TBody>
                              </Table>
                            )}
                      </section>
                      <section className="flex flex-col gap-2">
                        <h3 className="m-0 text-[13px] font-medium">{t('settings.loginProtection.userLockouts')}</h3>
                        {query.data.userLockouts.length === 0
                          ? <div className="text-[12.5px] text-muted-foreground">{t('settings.loginProtection.noUserLockouts')}</div>
                          : (
                              <Table>
                                <THead>
                                  <TR>
                                    <TH>{t('settings.loginProtection.user')}</TH>
                                    <TH>{t('settings.loginProtection.since')}</TH>
                                    <TH>{t('settings.loginProtection.until')}</TH>
                                    <TH />
                                  </TR>
                                </THead>
                                <TBody>
                                  {query.data.userLockouts.map(lockout => (
                                    <TR key={lockout.username}>
                                      <TD>{lockout.username}</TD>
                                      <TD className="text-muted-foreground">{time(lockout.locked_at)}</TD>
                                      <TD className="text-muted-foreground">
                                        {lockout.expires_at ? time(lockout.expires_at) : t('settings.loginProtection.untilLifted')}
                                      </TD>
                                      <TD className="text-right">
                                        <Button
                                          variant="outline"
                                          size="sm"
                                          disabled={unlock.isPending}
                                          aria-label={t('settings.loginProtection.unlockLabel', { username: lockout.username })}
                                          onClick={() => unlock.mutate(lockout.username)}
                                        >
                                          {t('settings.loginProtection.unlock')}
                                        </Button>
                                      </TD>
                                    </TR>
                                  ))}
                                </TBody>
                              </Table>
                            )}
                      </section>
                    </>
                  )}
        </CardContent>
      </Card>
    </div>
  )
}

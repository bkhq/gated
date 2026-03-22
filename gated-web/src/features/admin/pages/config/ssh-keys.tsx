import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { type ColumnDef } from '@tanstack/react-table'
import { KeyRound, Plus, ServerCog, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { adminKeys } from '@/features/admin/api'
import { api, type SSHKnownHost, type SSHKey } from '@/features/admin/lib/api'
import { CopyButton } from '@/shared/components/copy-button'
import { DataTable } from '@/shared/components/data-table'
import { EmptyState } from '@/shared/components/empty-state'
import { PageHeader } from '@/shared/components/page-header'
import { Button } from '@/shared/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/shared/components/ui/dialog'
import { Input } from '@/shared/components/ui/input'
import { Label } from '@/shared/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/shared/components/ui/tabs'
import { ConfirmDialog } from '@/shared/components/confirm-dialog'

// ─── API Hooks ───────────────────────────────────────────────────────────────

function useKnownHostsQuery() {
  return useQuery({
    queryKey: adminKeys.knownHosts,
    queryFn: () => api.getSshKnownHosts(),
  })
}

function useAddKnownHostMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (req: { host: string; port: number; key_type: string; key_base64: string }) =>
      api.addSshKnownHost(req),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: adminKeys.knownHosts })
    },
  })
}

function useDeleteKnownHostMutation() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteSshKnownHost(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: adminKeys.knownHosts })
    },
  })
}

function useCheckHostKeyMutation() {
  return useMutation({
    mutationFn: (req: { host: string; port: number }) => api.checkSshHostKey(req),
  })
}

function useOwnKeysQuery() {
  return useQuery({
    queryKey: adminKeys.sshKeys,
    queryFn: () => api.getSshOwnKeys(),
  })
}

// ─── Known Hosts Tab ─────────────────────────────────────────────────────────

function AddKnownHostDialog() {
  const { t } = useTranslation('admin')
  const [open, setOpen] = useState(false)
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const [keyType, setKeyType] = useState('')
  const [keyBase64, setKeyBase64] = useState('')
  const mutation = useAddKnownHostMutation()

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    mutation.mutate(
      { host, port: parseInt(port, 10), key_type: keyType, key_base64: keyBase64 },
      {
        onSuccess: () => {
          toast.success(t('ssh.knownHosts.addSuccess'))
          setOpen(false)
          setHost('')
          setPort('22')
          setKeyType('')
          setKeyBase64('')
        },
        onError: () => toast.error(t('ssh.knownHosts.addError')),
      },
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="h-4 w-4 mr-2" />
          {t('ssh.knownHosts.add')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('ssh.knownHosts.addTitle')}</DialogTitle>
          <DialogDescription>{t('ssh.knownHosts.addDescription')}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-3 gap-4">
            <div className="col-span-2 space-y-2">
              <Label htmlFor="kh-host">{t('ssh.fields.host')}</Label>
              <Input
                id="kh-host"
                value={host}
                onChange={e => setHost(e.target.value)}
                placeholder="example.com"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="kh-port">{t('ssh.fields.port')}</Label>
              <Input
                id="kh-port"
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={e => setPort(e.target.value)}
                required
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="kh-key-type">{t('ssh.fields.keyType')}</Label>
            <Input
              id="kh-key-type"
              value={keyType}
              onChange={e => setKeyType(e.target.value)}
              placeholder="ssh-ed25519"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="kh-key-base64">{t('ssh.fields.keyBase64')}</Label>
            <Input
              id="kh-key-base64"
              value={keyBase64}
              onChange={e => setKeyBase64(e.target.value)}
              placeholder="AAAA..."
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? t('common.saving') : t('common.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function KnownHostsTab() {
  const { t } = useTranslation('admin')
  const { data: hosts = [], isLoading } = useKnownHostsQuery()
  const deleteMutation = useDeleteKnownHostMutation()
  const [deleteId, setDeleteId] = useState<string | null>(null)

  const columns: ColumnDef<SSHKnownHost>[] = [
    {
      accessorKey: 'host',
      header: t('ssh.fields.host'),
      cell: ({ row }) => (
        <span className="font-mono text-sm">
          {row.original.host}:{row.original.port}
        </span>
      ),
    },
    {
      accessorKey: 'key_type',
      header: t('ssh.fields.keyType'),
      cell: ({ row }) => (
        <span className="font-mono text-sm text-muted-foreground">{row.original.key_type}</span>
      ),
    },
    {
      accessorKey: 'key_base64',
      header: t('ssh.fields.fingerprint'),
      cell: ({ row }) => (
        <div className="flex items-center gap-1 max-w-xs">
          <span className="font-mono text-xs text-muted-foreground truncate">
            {row.original.key_base64.slice(0, 32)}…
          </span>
          <CopyButton value={row.original.key_base64} label={t('common.copy')} />
        </div>
      ),
    },
    {
      id: 'actions',
      cell: ({ row }) => (
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-destructive hover:text-destructive"
          onClick={() => setDeleteId(row.original.id)}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      ),
    },
  ]

  if (isLoading) return <div className="py-8 text-center text-muted-foreground">{t('common.loading')}</div>

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <AddKnownHostDialog />
      </div>
      {hosts.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title={t('ssh.knownHosts.empty')}
          description={t('ssh.knownHosts.emptyDescription')}
          action={<AddKnownHostDialog />}
        />
      ) : (
        <DataTable
          columns={columns}
          data={hosts}
          searchPlaceholder={t('ssh.knownHosts.search')}
        />
      )}
      <ConfirmDialog
        open={deleteId !== null}
        onOpenChange={open => { if (!open) setDeleteId(null) }}
        title={t('ssh.knownHosts.deleteTitle')}
        description={t('ssh.knownHosts.deleteDescription')}
        confirmLabel={t('common.delete')}
        cancelLabel={t('common.cancel')}
        onConfirm={() => {
          if (deleteId) {
            deleteMutation.mutate(deleteId, {
              onSuccess: () => {
                toast.success(t('ssh.knownHosts.deleteSuccess'))
                setDeleteId(null)
              },
              onError: () => toast.error(t('ssh.knownHosts.deleteError')),
            })
          }
        }}
      />
    </div>
  )
}

// ─── Host Key Check Tab ───────────────────────────────────────────────────────

function HostKeyCheckTab() {
  const { t } = useTranslation('admin')
  const [host, setHost] = useState('')
  const [port, setPort] = useState('22')
  const mutation = useCheckHostKeyMutation()

  const handleCheck = (e: React.FormEvent) => {
    e.preventDefault()
    mutation.mutate({ host, port: parseInt(port, 10) })
  }

  return (
    <div className="space-y-6 max-w-lg">
      <form onSubmit={handleCheck} className="space-y-4">
        <div className="grid grid-cols-3 gap-4">
          <div className="col-span-2 space-y-2">
            <Label htmlFor="check-host">{t('ssh.fields.host')}</Label>
            <Input
              id="check-host"
              value={host}
              onChange={e => setHost(e.target.value)}
              placeholder="example.com"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="check-port">{t('ssh.fields.port')}</Label>
            <Input
              id="check-port"
              type="number"
              min={1}
              max={65535}
              value={port}
              onChange={e => setPort(e.target.value)}
              required
            />
          </div>
        </div>
        <Button type="submit" disabled={mutation.isPending}>
          <ServerCog className="h-4 w-4 mr-2" />
          {mutation.isPending ? t('ssh.checkHostKey.checking') : t('ssh.checkHostKey.check')}
        </Button>
      </form>

      {mutation.isSuccess && mutation.data && (
        <div className="rounded-lg border p-4 space-y-3">
          <h3 className="font-semibold text-sm">{t('ssh.checkHostKey.result')}</h3>
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="text-sm text-muted-foreground w-24">{t('ssh.fields.keyType')}</span>
              <span className="font-mono text-sm">{mutation.data.remote_key_type}</span>
            </div>
            <div className="flex items-start gap-2">
              <span className="text-sm text-muted-foreground w-24 shrink-0">{t('ssh.fields.keyBase64')}</span>
              <div className="flex items-center gap-1 min-w-0">
                <span className="font-mono text-xs break-all">{mutation.data.remote_key_base64}</span>
                <CopyButton value={mutation.data.remote_key_base64} label={t('common.copy')} className="shrink-0" />
              </div>
            </div>
          </div>
        </div>
      )}

      {mutation.isError && (
        <div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4">
          <p className="text-sm text-destructive">{t('ssh.checkHostKey.error')}</p>
        </div>
      )}
    </div>
  )
}

// ─── Own Keys Tab ─────────────────────────────────────────────────────────────

function OwnKeysTab() {
  const { t } = useTranslation('admin')
  const { data: keys = [], isLoading } = useOwnKeysQuery()

  if (isLoading) return <div className="py-8 text-center text-muted-foreground">{t('common.loading')}</div>

  if (keys.length === 0) {
    return (
      <EmptyState
        icon={KeyRound}
        title={t('ssh.ownKeys.empty')}
        description={t('ssh.ownKeys.emptyDescription')}
      />
    )
  }

  return (
    <div className="space-y-3">
      {keys.map((key: SSHKey, idx: number) => (
        <div key={idx} className="rounded-lg border p-4 space-y-2">
          <div className="flex items-center justify-between">
            <span className="font-mono text-sm font-semibold">{key.kind}</span>
            <CopyButton
              value={`${key.kind} ${key.public_key_base64}`}
              label={t('ssh.ownKeys.copyKey')}
            />
          </div>
          <p className="font-mono text-xs text-muted-foreground break-all">{key.public_key_base64}</p>
        </div>
      ))}
    </div>
  )
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export function Component() {
  const { t } = useTranslation('admin')

  return (
    <div>
      <PageHeader title={t('pages.sshKeys')} description={t('ssh.description')} />
      <Tabs defaultValue="known-hosts">
        <TabsList>
          <TabsTrigger value="known-hosts">{t('ssh.tabs.knownHosts')}</TabsTrigger>
          <TabsTrigger value="check-host-key">{t('ssh.tabs.checkHostKey')}</TabsTrigger>
          <TabsTrigger value="own-keys">{t('ssh.tabs.ownKeys')}</TabsTrigger>
        </TabsList>
        <TabsContent value="known-hosts" className="mt-6">
          <KnownHostsTab />
        </TabsContent>
        <TabsContent value="check-host-key" className="mt-6">
          <HostKeyCheckTab />
        </TabsContent>
        <TabsContent value="own-keys" className="mt-6">
          <OwnKeysTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

import type { LucideIcon } from 'lucide-react'
import type { FileType } from './lib/entries'
import type { SftpEntry } from '@/shared/lib/api/sftp'
import { File, FileArchive, FileAudio, FileImage, FileSymlink, FileText, FileVideo, Folder } from 'lucide-react'
import { cn } from '@/shared/lib/utils'
import { fileType } from './lib/entries'

const ICONS: Record<FileType, LucideIcon> = {
  dir: Folder,
  symlink: FileSymlink,
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  archive: FileArchive,
  text: FileText,
  other: File,
}

export function EntryIcon({ entry, size = 15 }: { entry: Pick<SftpEntry, 'name' | 'kind'>, size?: number }) {
  const type = fileType(entry)
  const Icon = ICONS[type]
  return <Icon size={size} className={cn('shrink-0', type === 'dir' ? 'text-[hsl(var(--primary))]' : 'text-muted-foreground')} />
}

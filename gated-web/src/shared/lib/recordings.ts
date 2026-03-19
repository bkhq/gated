export type RecordingMetadata
  = | { type: 'kubernetes-exec', namespace: string, pod: string, container: string, command: string }
    | { type: 'kubernetes-attach', namespace: string, pod: string, container: string }
    | { type: 'ssh-shell', channel: number }
    | { type: 'ssh-exec', channel: number }
    | { type: 'ssh-direct-tcpip', host: string, port: number }
    | { type: 'ssh-direct-socket', path: string }
    | { type: 'ssh-forwarded-tcpip', host: string, port: number }
    | { type: 'ssh-forwarded-socket', path: string }

export function recordingMetadataToFieldSet(metadata: RecordingMetadata): [string, string][] {
  const fieldSets: [string, string][] = []

  switch (metadata.type) {
    case 'kubernetes-exec':
      fieldSets.push(['Namespace', metadata.namespace])
      fieldSets.push(['Pod', metadata.pod])
      fieldSets.push(['Container', metadata.container])
      fieldSets.push(['Command', metadata.command])
      break
    case 'kubernetes-attach':
      fieldSets.push(['Namespace', metadata.namespace])
      fieldSets.push(['Pod', metadata.pod])
      fieldSets.push(['Container', metadata.container])
      break
    case 'ssh-shell':
    case 'ssh-exec':
      fieldSets.push(['Channel', metadata.channel.toString()])
      break
    case 'ssh-direct-tcpip':
    case 'ssh-forwarded-tcpip':
      fieldSets.push(['Host', metadata.host])
      fieldSets.push(['Port', metadata.port.toString()])
      break
    case 'ssh-direct-socket':
    case 'ssh-forwarded-socket':
      fieldSets.push(['Path', metadata.path])
      break
  }

  return fieldSets
}

export function recordingTypeLabel(metadata: string): string {
  const parsed = JSON.parse(metadata) as RecordingMetadata | null
  switch (parsed?.type) {
    case undefined:
      return 'Unknown type'
    case 'kubernetes-exec':
      return 'Exec'
    case 'kubernetes-attach':
      return 'Attach'
    case 'ssh-shell':
      return 'Shell'
    case 'ssh-exec':
      return 'Exec'
    case 'ssh-direct-tcpip':
      return 'Local TCP forwarding'
    case 'ssh-direct-socket':
      return 'Local UNIX socket forwarding'
    case 'ssh-forwarded-tcpip':
      return 'Remote TCP forwarding'
    case 'ssh-forwarded-socket':
      return 'Remote UNIX socket forwarding'
    default:
      return 'Unknown type'
  }
}

import type { components } from './admin.types'
import { adminApi } from './http'

export type ListenerCertificate = components['schemas']['ListenerCertificate']
export type TlsListener = components['schemas']['TLSListener']
export type ImportTlsCertificateRequest = components['schemas']['ImportTLSCertificateRequest']

export async function listTlsCertificates(signal?: AbortSignal): Promise<ListenerCertificate[]> {
  return adminApi.get<ListenerCertificate[]>('/tls/certificates', signal)
}

export async function generateTlsCertificate(listener: TlsListener, signal?: AbortSignal): Promise<ListenerCertificate> {
  return adminApi.post<ListenerCertificate>(`/tls/certificates/${listener}/generate`, undefined, signal)
}

export async function importTlsCertificate(
  listener: TlsListener,
  req: ImportTlsCertificateRequest,
  signal?: AbortSignal,
): Promise<ListenerCertificate> {
  return adminApi.put<ListenerCertificate>(`/tls/certificates/${listener}`, req, signal)
}

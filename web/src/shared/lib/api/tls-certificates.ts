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

export type AcmeSettings = components['schemas']['AcmeSettingsResponse']
export type UpdateAcmeSettingsRequest = components['schemas']['UpdateAcmeSettingsRequest']

export async function getAcmeSettings(signal?: AbortSignal): Promise<AcmeSettings> {
  return adminApi.get<AcmeSettings>('/tls/acme', signal)
}

export async function updateAcmeSettings(req: UpdateAcmeSettingsRequest, signal?: AbortSignal): Promise<AcmeSettings> {
  return adminApi.put<AcmeSettings>('/tls/acme', req, signal)
}

export async function enableAcme(listener: TlsListener, domains: string[], signal?: AbortSignal): Promise<ListenerCertificate> {
  return adminApi.put<ListenerCertificate>(`/tls/certificates/${listener}/acme`, { domains }, signal)
}

export async function disableAcme(listener: TlsListener, signal?: AbortSignal): Promise<void> {
  return adminApi.delete<void>(`/tls/certificates/${listener}/acme`, signal)
}

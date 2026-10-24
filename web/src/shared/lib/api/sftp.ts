// Client for the web file manager (crates/gated-admin/src/http_service/api/sftp.rs).
// `download` and `upload` are raw routes outside the OpenAPI spec.

import type { components } from './user.types'
import { ApiError, userApi } from './http'

export type SftpEntry = components['schemas']['SftpEntry']
export type SftpListing = components['schemas']['SftpListing']

function base(target: string): string {
  return `/sftp/${encodeURIComponent(target)}`
}

/** The `{ error }` body text of a failed SFTP request, else the generic message. */
export function sftpErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body
    if (body && typeof body === 'object' && 'error' in body && typeof body.error === 'string')
      return body.error
  }
  return err instanceof Error ? err.message : String(err)
}

export async function listDirectory(target: string, path?: string, signal?: AbortSignal): Promise<SftpListing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  return userApi.get<SftpListing>(`${base(target)}/list${query}`, signal)
}

export async function makeDirectory(target: string, path: string): Promise<void> {
  return userApi.post<void>(`${base(target)}/mkdir`, { path })
}

export async function renamePath(target: string, from: string, to: string): Promise<void> {
  return userApi.post<void>(`${base(target)}/rename`, { from, to })
}

export async function removePath(target: string, path: string, directory: boolean): Promise<void> {
  return userApi.post<void>(`${base(target)}/remove`, { path, directory })
}

export function downloadUrl(target: string, path: string): string {
  return `/api${base(target)}/download?path=${encodeURIComponent(path)}`
}

export interface UploadOptions {
  overwrite?: boolean
  onProgress?: (loaded: number) => void
  signal?: AbortSignal
}

/** Upload one file; uses XHR because fetch has no upload progress. */
export async function uploadFile(target: string, path: string, file: Blob, options: UploadOptions = {}): Promise<void> {
  const params = new URLSearchParams({ path })
  if (options.overwrite)
    params.set('overwrite', 'true')
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', `/api${base(target)}/upload?${params.toString()}`)
    xhr.withCredentials = true
    xhr.upload.onprogress = event => options.onProgress?.(event.loaded)
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve()
        return
      }
      let body: unknown = xhr.responseText
      try {
        body = JSON.parse(xhr.responseText)
      }
      catch {}
      reject(new ApiError(xhr.status, `HTTP ${xhr.status}`, body))
    }
    xhr.onerror = () => reject(new Error('Network error'))
    xhr.onabort = () => reject(new DOMException('Upload cancelled', 'AbortError'))
    options.signal?.addEventListener('abort', () => xhr.abort())
    xhr.send(file)
  })
}

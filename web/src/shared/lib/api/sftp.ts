// Client for the web file manager (crates/gated-admin/src/http_service/api/sftp.rs).
// `download` and `upload` are raw routes outside the OpenAPI spec.

import type { TargetRef } from './target-ref'
import type { components } from './user.types'
import { ApiError, userApi } from './http'
import { refName, withAccount } from './target-ref'

export type SftpEntry = components['schemas']['SftpEntry']
export type SftpListing = components['schemas']['SftpListing']

function base(target: TargetRef): string {
  return `/sftp/${encodeURIComponent(refName(target))}`
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

export async function listDirectory(target: TargetRef, path?: string, signal?: AbortSignal): Promise<SftpListing> {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  return userApi.get<SftpListing>(withAccount(`${base(target)}/list${query}`, target), signal)
}

export async function makeDirectory(target: TargetRef, path: string): Promise<void> {
  return userApi.post<void>(withAccount(`${base(target)}/mkdir`, target), { path })
}

export async function renamePath(target: TargetRef, from: string, to: string): Promise<void> {
  return userApi.post<void>(withAccount(`${base(target)}/rename`, target), { from, to })
}

export async function removePath(target: TargetRef, path: string, directory: boolean): Promise<void> {
  return userApi.post<void>(withAccount(`${base(target)}/remove`, target), { path, directory })
}

export function downloadUrl(target: TargetRef, path: string): string {
  return withAccount(`/api${base(target)}/download?path=${encodeURIComponent(path)}`, target)
}

export interface UploadOptions {
  overwrite?: boolean
  onProgress?: (loaded: number) => void
  signal?: AbortSignal
}

/** Upload one file; uses XHR because fetch has no upload progress. */
export async function uploadFile(target: TargetRef, path: string, file: Blob, options: UploadOptions = {}): Promise<void> {
  const params = new URLSearchParams({ path })
  if (options.overwrite)
    params.set('overwrite', 'true')
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest()
    xhr.open('PUT', withAccount(`/api${base(target)}/upload?${params.toString()}`, target))
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

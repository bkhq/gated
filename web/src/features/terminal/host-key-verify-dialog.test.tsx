import type { HostKeyVerifyPrompt } from './codec'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HostKeyVerifyDialog } from './host-key-verify-dialog'

const prompt: HostKeyVerifyPrompt = {
  algorithm: 'ssh-ed25519',
  keyBase64: 'AAAAC3NzaC1lZDI1NTE5AAAAIBfakefingerprintbase64payload====',
}

describe('hostKeyVerifyDialog', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('renders nothing when there is no prompt', () => {
    const onDecision = vi.fn()
    render(<HostKeyVerifyDialog prompt={null} onDecision={onDecision} />)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.queryByText('Verify host key')).toBeNull()
  })

  it('shows the algorithm and base64 key when a prompt is supplied', () => {
    const onDecision = vi.fn()
    render(<HostKeyVerifyDialog prompt={prompt} onDecision={onDecision} />)
    expect(screen.getByText('Verify host key')).toBeInTheDocument()
    expect(screen.getByText(prompt.algorithm)).toBeInTheDocument()
    expect(screen.getByText(prompt.keyBase64)).toBeInTheDocument()
  })

  it('shows the target and SHA-256 fingerprint when the server sends them', () => {
    const onDecision = vi.fn()
    render(
      <HostKeyVerifyDialog
        prompt={{ ...prompt, fingerprint: 'SHA256:abc', host: 'ssh.example', port: 2222 }}
        onDecision={onDecision}
      />,
    )
    expect(screen.getByText('ssh.example:2222')).toBeInTheDocument()
    expect(screen.getByText('SHA256:abc')).toBeInTheDocument()
    expect(screen.getByText(prompt.keyBase64).closest('details')).not.toBeNull()
  })

  it('shows the public key directly when no fingerprint is sent', () => {
    const onDecision = vi.fn()
    render(<HostKeyVerifyDialog prompt={prompt} onDecision={onDecision} />)
    expect(screen.getByText(prompt.keyBase64).closest('details')).toBeNull()
  })

  it('calls onDecision(true) when Accept is clicked', () => {
    const onDecision = vi.fn()
    render(<HostKeyVerifyDialog prompt={prompt} onDecision={onDecision} />)
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }))
    expect(onDecision).toHaveBeenCalledWith(true)
  })

  it('calls onDecision(false) when Reject is clicked', () => {
    const onDecision = vi.fn()
    render(<HostKeyVerifyDialog prompt={prompt} onDecision={onDecision} />)
    fireEvent.click(screen.getByRole('button', { name: 'Reject' }))
    expect(onDecision).toHaveBeenCalledWith(false)
  })

  it('auto-rejects when the countdown hits zero (default 60s)', () => {
    const onDecision = vi.fn()
    render(<HostKeyVerifyDialog prompt={prompt} onDecision={onDecision} />)
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(onDecision).toHaveBeenCalledWith(false)
  })

  it('respects a custom timeoutMs override', () => {
    const onDecision = vi.fn()
    render(
      <HostKeyVerifyDialog prompt={prompt} onDecision={onDecision} timeoutMs={2_000} />,
    )
    act(() => {
      vi.advanceTimersByTime(1_900)
    })
    expect(onDecision).not.toHaveBeenCalled()
    act(() => {
      vi.advanceTimersByTime(200)
    })
    expect(onDecision).toHaveBeenCalledWith(false)
  })

  it('decrements the countdown display over time', () => {
    const onDecision = vi.fn()
    render(<HostKeyVerifyDialog prompt={prompt} onDecision={onDecision} />)
    const start = screen.getByTestId('host-key-countdown').textContent
    expect(start).toMatch(/60s/)
    act(() => {
      vi.advanceTimersByTime(5_000)
    })
    expect(screen.getByTestId('host-key-countdown').textContent).toMatch(/5[45]s/)
  })

  it('uses overridden labels when supplied', () => {
    const onDecision = vi.fn()
    render(
      <HostKeyVerifyDialog
        prompt={prompt}
        onDecision={onDecision}
        labels={{ accept: '接受', reject: '拒绝', title: '验证主机密钥' }}
      />,
    )
    expect(screen.getByText('验证主机密钥')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '接受' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '拒绝' })).toBeInTheDocument()
  })
})

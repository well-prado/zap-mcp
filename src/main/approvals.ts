/**
 * Human-in-the-loop for outgoing messages. Claude asks, you approve (optionally editing the
 * text) in the app or from the notification, and only then the message goes out.
 */
import { EventEmitter } from 'node:events'
import { randomBytes } from 'node:crypto'
import type { ApprovalStatus, ApprovalView } from '@shared/types'
import type { Store } from './db'

type Executor = (finalText?: string) => Promise<void>

interface Waiter {
  execute: Executor
  settle: (s: ApprovalStatus) => void
  done: Promise<ApprovalStatus>
}

export class Approvals extends EventEmitter {
  private waiters = new Map<string, Waiter>()

  constructor(private readonly store: Store) {
    super()
  }

  /**
   * Queue a send for approval. `execute` runs only after the user approves.
   * Resolves with the outcome, or 'pending' if the user has not decided within `waitMs`
   * (the send still happens later if they approve).
   */
  async request(
    input: Omit<ApprovalView, 'id' | 'createdAt' | 'status' | 'accountLabel' | 'error'>,
    execute: Executor,
    waitMs: number
  ): Promise<{ id: string; status: ApprovalStatus | 'pending' }> {
    const id = randomBytes(6).toString('hex')
    this.store.insertApproval({ ...input, id, createdAt: Date.now(), status: 'pending' })

    let settle!: (s: ApprovalStatus) => void
    const done = new Promise<ApprovalStatus>((r) => (settle = r))
    this.waiters.set(id, { execute, settle, done })

    const view = this.store.listApprovals().find((a) => a.id === id)
    if (view) this.emit('requested', view)
    this.emit('changed')

    const timeout = new Promise<'pending'>((r) => setTimeout(() => r('pending'), waitMs))
    return { id, status: await Promise.race([done, timeout]) }
  }

  async decide(id: string, approve: boolean, editedText?: string): Promise<ApprovalStatus> {
    const waiter = this.waiters.get(id)
    if (!waiter) throw new Error('Esta aprovação não está mais pendente.')
    this.waiters.delete(id)

    if (!approve) {
      this.store.updateApproval(id, { status: 'rejected' })
      waiter.settle('rejected')
      this.emit('changed')
      return 'rejected'
    }

    const text = editedText?.trim() || undefined
    this.store.updateApproval(id, { status: 'approved', text })
    this.emit('changed')
    try {
      await waiter.execute(text)
      this.store.updateApproval(id, { status: 'sent' })
      waiter.settle('sent')
      return 'sent'
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
      this.store.updateApproval(id, { status: 'failed', error })
      waiter.settle('failed')
      return 'failed'
    } finally {
      this.emit('changed')
    }
  }

  pendingCount(): number {
    return this.waiters.size
  }
}

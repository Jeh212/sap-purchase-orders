// ConfirmationStore — per-session, binds pending PO creation to an immutable
// server-computed payload hash. The model cannot forge or bypass this.

export type ConfirmationStatus =
  | "none"
  | "pending"
  | "confirmed"
  | "consumed"
  | "expired"

export interface ConfirmationStore {
  /**
   * Record that a PO creation for requestId requires human confirmation.
   * payloadHash is computed server-side over the authoritative payload;
   * the model never sets or controls it.
   * Calling this again for the same requestId invalidates any prior state.
   */
  setPending(requestId: string, payloadHash: string, codes: string[]): void

  /**
   * Record explicit human confirmation. Only transitions from 'pending' to
   * 'confirmed' when both requestId AND payloadHash match exactly.
   * Throws if the store entry is not in 'pending' state for this pair.
   */
  confirm(requestId: string, payloadHash: string): void

  /**
   * Query the current confirmation status for a (requestId, payloadHash) pair.
   * Returns 'expired' if the entry has exceeded the TTL.
   * Returns 'none' if no entry exists.
   */
  check(requestId: string, payloadHash: string): ConfirmationStatus

  /**
   * Explicitly invalidate any pending/confirmed state for requestId.
   * Called when request data changes or a new payload is built.
   */
  invalidate(requestId: string): void
}

const TTL_MS = 30 * 60 * 1000 // 30 minutes

type Entry = {
  payloadHash: string
  codes: string[]
  status: "pending" | "confirmed" | "consumed"
  timestamp: number
}

export class InMemoryConfirmationStore implements ConfirmationStore {
  private readonly entries = new Map<string, Entry>()

  setPending(requestId: string, payloadHash: string, codes: string[]): void {
    this.entries.set(requestId, {
      payloadHash,
      codes,
      status: "pending",
      timestamp: Date.now(),
    })
  }

  confirm(requestId: string, payloadHash: string): void {
    const entry = this.entries.get(requestId)

    if (entry === undefined) {
      throw new Error(`No pending confirmation for request ${requestId}`)
    }
    if (this.isExpired(entry)) {
      throw new Error(`Confirmation for request ${requestId} has expired`)
    }
    if (entry.status !== "pending") {
      throw new Error(
        `Cannot confirm: current status is '${entry.status}' for request ${requestId}`,
      )
    }
    if (entry.payloadHash !== payloadHash) {
      throw new Error(
        `Payload hash mismatch for request ${requestId}: confirmation rejected`,
      )
    }

    entry.status = "confirmed"
  }

  check(requestId: string, payloadHash: string): ConfirmationStatus {
    const entry = this.entries.get(requestId)

    if (entry === undefined) return "none"
    if (this.isExpired(entry)) return "expired"
    if (entry.payloadHash !== payloadHash) return "none"

    return entry.status
  }

  invalidate(requestId: string): void {
    this.entries.delete(requestId)
  }

  /**
   * Called by po_create after successfully consuming a confirmed entry.
   * Marks the entry consumed so it cannot be used again (single-use).
   */
  consume(requestId: string, payloadHash: string): void {
    const entry = this.entries.get(requestId)
    if (entry === undefined || entry.payloadHash !== payloadHash) return
    entry.status = "consumed"
  }

  /** Returns the RC codes that required confirmation for a given request. */
  getCodes(requestId: string): string[] {
    return this.entries.get(requestId)?.codes ?? []
  }

  private isExpired(entry: Entry): boolean {
    return (
      (entry.status === "pending" || entry.status === "confirmed") &&
      Date.now() - entry.timestamp > TTL_MS
    )
  }
}

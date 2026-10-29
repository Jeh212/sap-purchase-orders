import { describe, it, expect } from "vitest"
import { InMemoryConfirmationStore } from "../../src/domain/confirmation.js"

const REQ = "REQ-2026-001"
const HASH_A = "aaaa" + "0".repeat(60)
const HASH_B = "bbbb" + "0".repeat(60)

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe("InMemoryConfirmationStore — state transitions", () => {
  it("starts with status 'none' for any request", () => {
    const store = new InMemoryConfirmationStore()
    expect(store.check(REQ, HASH_A)).toBe("none")
  })

  it("setPending → status becomes 'pending'", () => {
    const store = new InMemoryConfirmationStore()
    store.setPending(REQ, HASH_A, ["RC5"])
    expect(store.check(REQ, HASH_A)).toBe("pending")
  })

  it("confirm with correct hash → status becomes 'confirmed'", () => {
    const store = new InMemoryConfirmationStore()
    store.setPending(REQ, HASH_A, ["RC5"])
    store.confirm(REQ, HASH_A)
    expect(store.check(REQ, HASH_A)).toBe("confirmed")
  })

  it("consume after confirmed → status becomes 'consumed'", () => {
    const store = new InMemoryConfirmationStore()
    store.setPending(REQ, HASH_A, ["RC5"])
    store.confirm(REQ, HASH_A)
    store.consume(REQ, HASH_A)
    expect(store.check(REQ, HASH_A)).toBe("consumed")
  })

  it("second consume is a no-op (idempotent)", () => {
    const store = new InMemoryConfirmationStore()
    store.setPending(REQ, HASH_A, ["RC5"])
    store.confirm(REQ, HASH_A)
    store.consume(REQ, HASH_A)
    store.consume(REQ, HASH_A) // no-op
    expect(store.check(REQ, HASH_A)).toBe("consumed")
  })

  it("consumed status → check returns 'consumed', not 'none'", () => {
    const store = new InMemoryConfirmationStore()
    store.setPending(REQ, HASH_A, ["RC5"])
    store.confirm(REQ, HASH_A)
    store.consume(REQ, HASH_A)
    // consumed entries stay consumed (not re-usable)
    expect(store.check(REQ, HASH_A)).toBe("consumed")
  })

  it("invalidate removes the entry → status returns 'none'", () => {
    const store = new InMemoryConfirmationStore()
    store.setPending(REQ, HASH_A, ["RC5"])
    store.invalidate(REQ)
    expect(store.check(REQ, HASH_A)).toBe("none")
  })
})

describe("InMemoryConfirmationStore — hash mismatch rejection", () => {
  it("check with wrong hash returns 'none' even when entry is pending", () => {
    const store = new InMemoryConfirmationStore()
    store.setPending(REQ, HASH_A, ["RC5"])
    expect(store.check(REQ, HASH_B)).toBe("none")
  })

  it("confirm with wrong hash throws", () => {
    const store = new InMemoryConfirmationStore()
    store.setPending(REQ, HASH_A, ["RC5"])
    expect(() => store.confirm(REQ, HASH_B)).toThrow()
  })

  it("confirm when no entry exists throws", () => {
    const store = new InMemoryConfirmationStore()
    expect(() => store.confirm(REQ, HASH_A)).toThrow()
  })

  it("confirm when already confirmed throws (not pending)", () => {
    const store = new InMemoryConfirmationStore()
    store.setPending(REQ, HASH_A, ["RC5"])
    store.confirm(REQ, HASH_A)
    expect(() => store.confirm(REQ, HASH_A)).toThrow()
  })
})

describe("InMemoryConfirmationStore — re-setPending invalidates prior state", () => {
  it("new setPending with different hash makes old hash return 'none'", () => {
    const store = new InMemoryConfirmationStore()
    store.setPending(REQ, HASH_A, ["RC5"])
    store.confirm(REQ, HASH_A)
    // Validation re-run produces a new hash (payload changed)
    store.setPending(REQ, HASH_B, ["RC5", "RC8"])
    expect(store.check(REQ, HASH_A)).toBe("none")
    expect(store.check(REQ, HASH_B)).toBe("pending")
  })

  it("replaying setPending with the same hash preserves an existing confirmation", () => {
    const store = new InMemoryConfirmationStore()
    store.setPending(REQ, HASH_A, ["RC5"])
    store.confirm(REQ, HASH_A)
    store.setPending(REQ, HASH_A, ["RC5"])
    expect(store.check(REQ, HASH_A)).toBe("confirmed")
  })
})

describe("InMemoryConfirmationStore — session isolation", () => {
  it("two separate store instances are completely independent", () => {
    const storeA = new InMemoryConfirmationStore()
    const storeB = new InMemoryConfirmationStore()
    storeA.setPending(REQ, HASH_A, ["RC5"])
    storeA.confirm(REQ, HASH_A)

    // Session B has no knowledge of session A's confirmation
    expect(storeB.check(REQ, HASH_A)).toBe("none")
    expect(() => storeB.confirm(REQ, HASH_A)).toThrow()
  })

  it("confirming in store A does not affect store B's pending state", () => {
    const storeA = new InMemoryConfirmationStore()
    const storeB = new InMemoryConfirmationStore()
    storeA.setPending(REQ, HASH_A, ["RC5"])
    storeB.setPending(REQ, HASH_A, ["RC5"])
    storeA.confirm(REQ, HASH_A)

    expect(storeA.check(REQ, HASH_A)).toBe("confirmed")
    expect(storeB.check(REQ, HASH_A)).toBe("pending")
  })
})

describe("InMemoryConfirmationStore — TTL expiry", () => {
  it("entry expires after the configured TTL", async () => {
    const store = new InMemoryConfirmationStore(50) // 50ms TTL for testing
    store.setPending(REQ, HASH_A, ["RC5"])
    expect(store.check(REQ, HASH_A)).toBe("pending")
    await sleep(100)
    expect(store.check(REQ, HASH_A)).toBe("expired")
  })

  it("confirm throws after TTL expiry", async () => {
    const store = new InMemoryConfirmationStore(50)
    store.setPending(REQ, HASH_A, ["RC5"])
    await sleep(100)
    expect(() => store.confirm(REQ, HASH_A)).toThrow()
  })

  it("confirmed entry also expires after TTL (not just pending)", async () => {
    const store = new InMemoryConfirmationStore(100)
    store.setPending(REQ, HASH_A, ["RC5"])
    store.confirm(REQ, HASH_A)
    expect(store.check(REQ, HASH_A)).toBe("confirmed")
    await sleep(150)
    expect(store.check(REQ, HASH_A)).toBe("expired")
  })

  it("consumed entries do NOT expire (already terminal state)", async () => {
    const store = new InMemoryConfirmationStore(50)
    store.setPending(REQ, HASH_A, ["RC5"])
    store.confirm(REQ, HASH_A)
    store.consume(REQ, HASH_A)
    await sleep(100)
    // consumed is a terminal state — it stays consumed, not expired
    expect(store.check(REQ, HASH_A)).toBe("consumed")
  })
})

describe("InMemoryConfirmationStore — confirmation replay prevention", () => {
  it("confirmed token used twice via consume → second check returns 'consumed'", () => {
    const store = new InMemoryConfirmationStore()
    store.setPending(REQ, HASH_A, ["RC5"])
    store.confirm(REQ, HASH_A)
    store.consume(REQ, HASH_A) // first use
    // second use attempt: status is consumed, not confirmed
    expect(store.check(REQ, HASH_A)).toBe("consumed")
  })
})

describe("InMemoryConfirmationStore — getStoredHash helper", () => {
  it("returns the stored hash for a pending request", () => {
    const store = new InMemoryConfirmationStore()
    store.setPending(REQ, HASH_A, ["RC5"])
    expect(store.getStoredHash(REQ)).toBe(HASH_A)
  })

  it("returns undefined when no entry exists", () => {
    const store = new InMemoryConfirmationStore()
    expect(store.getStoredHash(REQ)).toBeUndefined()
  })
})

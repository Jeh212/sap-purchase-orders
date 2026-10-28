/**
 * File-backed SAP mock implementing SapAdapter.
 * Safe for a single Node.js process. Concurrent multi-process writes are NOT
 * safe with file-backing — use a database or advisory locks for that scenario.
 * Counter is recovered from orders.jsonl via repairCounter() on startup.
 */

import type { SapAdapter } from "./adapter.js"
import type { PurchaseOrder } from "../domain/schemas.js"
import * as fs from "node:fs/promises"
import * as path from "node:path"

interface StoredEntry {
  po_number: string
  date: string
  request_id: string
  payload: PurchaseOrder
}

export interface SupplierRef {
  sap_code: string
  tax_id: string
  active: boolean
}

export class FileSapMock implements SapAdapter {
  private readonly counterPath: string
  private readonly ordersPath: string
  private readonly suppliers: SupplierRef[]
  // In-process serialization: prevents duplicate writes for concurrent calls
  // with the same request_id in a single Node.js process.
  private readonly inflight = new Map<string, Promise<{ po_number: string; date: string }>>()

  constructor(outDir: string, suppliers: SupplierRef[] = []) {
    this.counterPath = path.join(outDir, "sap", "counter.txt")
    this.ordersPath = path.join(outDir, "sap", "orders.jsonl")
    this.suppliers = suppliers
  }

  async lookupSupplier(
    tax_id: string,
  ): Promise<{ sap_code: string; active: boolean } | null> {
    const found = this.suppliers.find((s) => s.tax_id === tax_id)
    return found ? { sap_code: found.sap_code, active: found.active } : null
  }

  async findOrderByReference(
    request_id: string,
  ): Promise<{ po_number: string } | null> {
    const entry = await this.findEntry(request_id)
    return entry ? { po_number: entry.po_number } : null
  }

  async createOrder(
    order: PurchaseOrder,
  ): Promise<{ po_number: string; date: string }> {
    const requestId = order.reference.request_id

    // Serialize concurrent calls for the same requestId within this process.
    // If a create is already in-flight for this requestId, return the same promise
    // so both callers get identical results and only one entry is written.
    const inFlight = this.inflight.get(requestId)
    if (inFlight !== undefined) return inFlight

    const promise = this.doCreate(order)
    this.inflight.set(requestId, promise)
    try {
      return await promise
    } finally {
      this.inflight.delete(requestId)
    }
  }

  private async doCreate(
    order: PurchaseOrder,
  ): Promise<{ po_number: string; date: string }> {
    const existing = await this.findEntry(order.reference.request_id)
    if (existing) {
      return { po_number: existing.po_number, date: existing.date }
    }

    await fs.mkdir(path.dirname(this.counterPath), { recursive: true })

    const counter = await this.readCounter()
    const po_number = `450${String(counter).padStart(7, "0")}`
    const date = new Date().toISOString().slice(0, 10)

    // Atomically advance counter
    const tmpCounter = this.counterPath + ".tmp"
    await fs.writeFile(tmpCounter, String(counter + 1), "utf-8")
    await fs.rename(tmpCounter, this.counterPath)

    const entry: StoredEntry = {
      po_number,
      date,
      request_id: order.reference.request_id,
      payload: order,
    }
    await fs.appendFile(this.ordersPath, JSON.stringify(entry) + "\n", "utf-8")

    return { po_number, date }
  }

  /** Repairs the counter from orders.jsonl after a crash or restart. */
  async repairCounter(): Promise<void> {
    let maxNum = 0
    try {
      const text = await fs.readFile(this.ordersPath, "utf-8")
      for (const line of text.split("\n")) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line) as StoredEntry
          const suffix = entry.po_number.replace(/^450/, "")
          const num = parseInt(suffix, 10)
          if (!isNaN(num) && num > maxNum) maxNum = num
        } catch {
          // skip malformed lines
        }
      }
    } catch {
      // orders.jsonl absent — nothing to repair
    }

    if (maxNum === 0) return

    const current = await this.readCounter()
    if (current <= maxNum) {
      await fs.mkdir(path.dirname(this.counterPath), { recursive: true })
      await fs.writeFile(this.counterPath, String(maxNum + 1), "utf-8")
    }
  }

  private async findEntry(request_id: string): Promise<StoredEntry | null> {
    let text: string
    try {
      text = await fs.readFile(this.ordersPath, "utf-8")
    } catch {
      return null
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as StoredEntry
        if (entry.request_id === request_id) return entry
      } catch {
        // skip
      }
    }
    return null
  }

  private async readCounter(): Promise<number> {
    try {
      const raw = await fs.readFile(this.counterPath, "utf-8")
      const n = parseInt(raw.trim(), 10)
      return isNaN(n) || n < 1 ? 1 : n
    } catch {
      return 1
    }
  }
}

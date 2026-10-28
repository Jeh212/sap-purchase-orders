import type { PurchaseOrder } from "../domain/schemas.js"

/**
 * SapAdapter — mandatory interface per PRD 7.4.
 * The mock implementation writes to out/sap/; the real implementation
 * targets the SAP OData API_PURCHASEORDER_PROCESS_SRV.
 */
export interface SapAdapter {
  /** Resolve a supplier by tax ID. Returns null if not found. */
  lookupSupplier(
    tax_id: string,
  ): Promise<{ sap_code: string; active: boolean } | null>

  /**
   * Create a purchase order. Must be idempotent: if a PO already exists for
   * order.reference.request_id, return the existing PO number.
   */
  createOrder(order: PurchaseOrder): Promise<{ po_number: string; date: string }>

  /**
   * Find an existing PO by the original request_id used as the idempotency key.
   * Returns null if not found.
   */
  findOrderByReference(
    request_id: string,
  ): Promise<{ po_number: string } | null>
}

import type { ToolEvent, ValidationIssue } from "../types"

interface ToolCallCardProps {
  event: ToolEvent
}

const TOOL_LABELS: Record<string, string> = {
  po_read_package: "Read request package",
  po_validate: "Validate business controls",
  po_generate_evidence: "Generate approval evidence",
  po_build_payload: "Build SAP payload",
  po_create: "Create purchase order",
}

function formatValue(value: unknown): string {
  if (typeof value === "number") return new Intl.NumberFormat("en-US").format(value)
  if (value === null) return "Not provided"
  if (typeof value === "string" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

function Issues({ title, items }: { title: string; items: ValidationIssue[] }) {
  if (items.length === 0) return null
  return (
    <section className="tool-issues">
      <h4>{title}</h4>
      {items.map((item) => (
        <div className="tool-issue" key={`${item.code}-${item.message}`}>
          <span className="rule-code">{item.code}</span>
          <p>{item.message}</p>
          {item.values !== undefined && (
            <dl className="value-grid">
              {Object.entries(item.values).map(([key, value]) => (
                <div key={key}>
                  <dt>{key.replaceAll("_", " ")}</dt>
                  <dd>{formatValue(value)}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      ))}
    </section>
  )
}

function cardTone(event: ToolEvent): string {
  if (event.isError || event.details.kind === "error") return "error"
  if (event.details.kind === "validation") {
    if (!event.details.eligible) return "error"
    if (event.details.confirmations.length > 0) return "pending"
  }
  if (event.details.kind === "creation") return "created"
  return "success"
}

export function ToolCallCard({ event }: ToolCallCardProps) {
  const details = event.details
  const tone = cardTone(event)
  const caseId = typeof event.arguments.case_id === "string" ? event.arguments.case_id : null

  return (
    <details className={`tool-card tool-card--${tone}`} open={details.kind === "validation" || details.kind === "creation" || event.isError}>
      <summary>
        <span className="tool-status-dot" aria-hidden="true" />
        <span className="tool-title-group">
          <strong>{TOOL_LABELS[event.name] ?? event.name}</strong>
          <span>{event.resultSummary}</span>
        </span>
        <span className="tool-state">{event.isError ? "Failed" : event.cached ? "Reused" : "Complete"}</span>
      </summary>
      <div className="tool-body">
        <div className="tool-facts">
          <span>Tool <code>{event.name}</code></span>
          {caseId !== null && <span>Case <code>{caseId}</code></span>}
        </div>

        {details.kind === "validation" && (
          <>
            <div className="validation-overview">
              <span className={details.eligible ? "status-pill status-pill--ok" : "status-pill status-pill--error"}>
                {details.eligible ? "Eligible" : "Blocked"}
              </span>
              {details.retroactive && <span className="status-pill status-pill--pending">Retroactive</span>}
            </div>
            <Issues title="Blocking controls" items={details.blockers} />
            <Issues title="Confirmation required" items={details.confirmations} />
            {Object.keys(details.derived).length > 0 && (
              <section className="derived-values">
                <h4>Derived from master data</h4>
                <dl className="value-grid">
                  {Object.entries(details.derived).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key.replaceAll("_", " ")}</dt>
                      <dd>{formatValue(value)}</dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}
          </>
        )}

        {details.kind === "evidence" && details.path !== null && (
          <p className="artifact-path">Evidence: <code>{details.path}</code></p>
        )}
        {details.kind === "payload" && details.traceabilityPath !== null && (
          <p className="artifact-path">Traceability: <code>{details.traceabilityPath}</code></p>
        )}
        {details.kind === "creation" && (
          <section className="po-result" aria-label="Purchase order result">
            <span>Purchase order created</span>
            <strong>{details.poNumber}</strong>
            <small>{details.idempotent ? "Existing order returned safely" : `Created ${details.date ?? "successfully"}`}</small>
          </section>
        )}
        {details.kind === "error" && <p className="tool-error">{details.message}</p>}
      </div>
    </details>
  )
}

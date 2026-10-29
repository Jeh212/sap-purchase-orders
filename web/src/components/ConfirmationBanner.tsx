import type { PendingConfirmation, ValidationIssue } from "../types"

interface ConfirmationBannerProps {
  pending: PendingConfirmation
  disabled: boolean
  onConfirm(): void
}

function displayValue(value: unknown): string {
  if (typeof value === "number") return new Intl.NumberFormat("en-US").format(value)
  if (value === null) return "Not provided"
  if (typeof value === "string" || typeof value === "boolean") return String(value)
  return JSON.stringify(value)
}

function ConfirmationDetail({ item }: { item: ValidationIssue }) {
  return (
    <li>
      <div className="confirmation-rule">
        <span className="rule-code">{item.code}</span>
        <p>{item.message}</p>
      </div>
      {item.values !== undefined && (
        <dl className="confirmation-values">
          {Object.entries(item.values).map(([key, value]) => (
            <div key={key}>
              <dt>{key.replaceAll("_", " ")}</dt>
              <dd>{displayValue(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </li>
  )
}

export function ConfirmationBanner({ pending, disabled, onConfirm }: ConfirmationBannerProps) {
  const details = pending.confirmations.length > 0
    ? pending.confirmations
    : pending.codes.map((code) => ({ code, message: "This business exception requires explicit approval." }))

  return (
    <aside className="confirmation-banner" aria-labelledby="confirmation-title">
      <div className="confirmation-icon" aria-hidden="true">!</div>
      <div className="confirmation-copy">
        <span className="eyebrow">Human decision required</span>
        <h2 id="confirmation-title">Review exceptions before creating the PO</h2>
        <p>
          This action requires your confirmation before proceeding. Your approval applies only to request
          {" "}<strong>{pending.requestId}</strong> in this session.
        </p>
        <ul>
          {details.map((item) => <ConfirmationDetail item={item} key={`${item.code}-${item.message}`} />)}
        </ul>
        <button className="confirm-button" type="button" disabled={disabled} onClick={onConfirm}>
          {disabled ? "Submitting confirmation…" : `Confirm ${pending.codes.join(", ")} and continue`}
        </button>
        <small>Confirmation is single-use and bound to the backend-validated payload.</small>
      </div>
    </aside>
  )
}

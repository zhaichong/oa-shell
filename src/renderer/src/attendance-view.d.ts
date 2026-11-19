declare module "./attendance-view.mjs" {
  export function dateParts(date: string): { day: string; monthLabel: string; ariaLabel: string } | null
  export function monthLabel(monthKey: string): string
  export function totalText(attendance?: { totalText?: string; totalLabel?: string } | null): string
  export function splitDetail(text: string): { period: string; amount: string; notes: string }
  export function emptyDetailMessage(attendance?: { state?: string } | null): string
}

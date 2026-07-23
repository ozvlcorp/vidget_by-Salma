import { useState, useRef, useLayoutEffect } from 'react'
import type { ChangeEvent } from 'react'

/** Keeps digits and at most one decimal separator (comma or dot, normalized to dot). */
function sanitize(input: string): string {
  let seenSep = false
  let out = ''
  for (const ch of input) {
    if (ch >= '0' && ch <= '9') out += ch
    else if ((ch === '.' || ch === ',') && !seenSep) { out += '.'; seenSep = true }
  }
  return out
}

function groupDigits(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
}

function formatDisplay(clean: string): string {
  const [intPart, decPart] = clean.split('.')
  const grouped = groupDigits(intPart || '')
  return decPart !== undefined ? `${grouped}.${decPart}` : grouped
}

function parseAmount(raw: string): number {
  const n = parseFloat(sanitize(raw) || '0')
  return isFinite(n) ? n : 0
}

/** Thousand-grouped numeric text input (e.g. "30 000 000") that reports a plain number via onChange. */
export function GroupedNumberInput({
  value, onChange, placeholder, className = '', autoFocus,
}: {
  value: number
  onChange: (n: number) => void
  placeholder?: string
  className?: string
  autoFocus?: boolean
}) {
  // `value` only ever changes as a result of this input's own onChange, so the
  // display text needs no external-prop resync — the lazy initializer covers mount.
  const [text, setText] = useState<string>(value ? formatDisplay(String(value)) : '')
  const inputRef = useRef<HTMLInputElement>(null)
  const pendingCaretDigits = useRef<number | null>(null)

  useLayoutEffect(() => {
    const target = pendingCaretDigits.current
    const el = inputRef.current
    if (target == null || !el) return
    let count = 0
    let pos = 0
    for (; pos < el.value.length; pos++) {
      if (count >= target) break
      if (el.value[pos] >= '0' && el.value[pos] <= '9') count++
    }
    el.setSelectionRange(pos, pos)
    pendingCaretDigits.current = null
  }, [text])

  function handleChange(e: ChangeEvent<HTMLInputElement>) {
    const el = e.target
    const caret = el.selectionStart ?? el.value.length
    const digitsBefore = (el.value.slice(0, caret).match(/\d/g) ?? []).length

    const clean = sanitize(el.value)
    pendingCaretDigits.current = digitsBefore
    setText(formatDisplay(clean))
    onChange(parseAmount(clean))
  }

  return (
    <input
      ref={inputRef}
      type="text"
      inputMode="decimal"
      value={text}
      placeholder={placeholder}
      autoFocus={autoFocus}
      onChange={handleChange}
      className={className}
    />
  )
}

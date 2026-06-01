/**
 * Sanitize terminal dimensions reported by the host.
 *
 * Some environments report bogus window sizes. The motivating case (WSL,
 * reported by @northframe_17) is `columns=131072, rows=1` — a width that
 * overflows any sane layout and a height of one row that makes the TUI
 * unusable. Node's own `stdout.columns || 80` fallback only catches
 * `0`/`NaN`/`undefined`, so a positive-but-absurd value sails straight into
 * the Ink renderer, which then allocates a 131072-cell-wide screen buffer.
 *
 * We clamp each dimension independently to a sane range. Out-of-range or
 * non-finite values fall back to the conventional 80x24 default rather than
 * the raw garbage.
 */

export const DEFAULT_COLUMNS = 80
export const DEFAULT_ROWS = 24

// Upper bounds are generous (ultrawide multi-monitor terminals, tmux panes
// spanning huge displays) but well below the WSL garbage value. Anything
// beyond these is treated as a broken probe.
export const MAX_COLUMNS = 2000
export const MAX_ROWS = 1000
export const MIN_COLUMNS = 1
export const MIN_ROWS = 1

/**
 * Clamp a single reported dimension into `[min, max]`.
 *
 * Returns `fallback` when the value is non-finite or `<= 0` (the classic
 * "no size yet" signal). A positive value above `max` is clamped to `max`,
 * not replaced by the fallback — an oversized-but-finite report is more
 * likely a real-but-large terminal than a missing one, and clamping keeps
 * the layout sane either way.
 */
export function sanitizeDimension(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    return fallback
  }

  const rounded = Math.floor(value)

  if (rounded < min) {
    return fallback
  }

  if (rounded > max) {
    return max
  }

  return rounded
}

export interface SanitizedTerminalSize {
  columns: number
  rows: number
}

/** Sanitize a (columns, rows) pair using the TUI's bounds. */
export function sanitizeTerminalSize(columns: unknown, rows: unknown): SanitizedTerminalSize {
  return {
    columns: sanitizeDimension(columns, MIN_COLUMNS, MAX_COLUMNS, DEFAULT_COLUMNS),
    rows: sanitizeDimension(rows, MIN_ROWS, MAX_ROWS, DEFAULT_ROWS)
  }
}

interface ClampableStream {
  columns?: number
  rows?: number
}

const PATCHED = Symbol.for('hermes.tui.clampedDimensions')

/**
 * Install clamping getters on `process.stdout` (or a provided stream) so every
 * downstream reader — the Ink renderer's root layout, its `resize` handler,
 * and our React components' `stdout.columns ?? 80` reads — sees sanitized
 * values. Must run before `ink.render`.
 *
 * Idempotent: re-installing on an already-patched stream is a no-op. The raw
 * values are read through the original property descriptor on each access, so
 * live resizes still propagate (just clamped).
 */
export function clampStdoutDimensions(stream: ClampableStream = process.stdout): void {
  const target = stream as ClampableStream & { [PATCHED]?: boolean }

  if (target[PATCHED]) {
    return
  }

  // Capture the original descriptors so we read the live host value on every
  // access rather than freezing a single snapshot.
  const colsDesc = findDescriptor(target, 'columns')
  const rowsDesc = findDescriptor(target, 'rows')

  const readCols = () => (colsDesc ? readValue(target, colsDesc) : target.columns)
  const readRows = () => (rowsDesc ? readValue(target, rowsDesc) : target.rows)

  // Node's own SIGWINCH handler WRITES `stdout.columns`/`stdout.rows` on resize.
  // If we redefine these as getter-only, that write throws
  // "Cannot set property columns of #<WriteStream> which has only a getter"
  // and crashes the render on the first resize event (tmux/cmux fire these
  // constantly). Forward writes to the original descriptor so resizes keep
  // working while reads stay clamped. Fall back to a backing field for exotic
  // streams whose original descriptor is neither a setter nor writable data.
  let colsBacking = readCols()
  let rowsBacking = readRows()
  const writeThrough = (desc: PropertyDescriptor | undefined, value: unknown, fallback: (v: unknown) => void) => {
    if (desc && desc.set) {
      desc.set.call(target, value)
    } else if (desc && 'value' in desc && desc.writable !== false) {
      desc.value = value
    } else {
      fallback(value)
    }
  }

  try {
    Object.defineProperty(target, 'columns', {
      configurable: true,
      enumerable: true,
      get() {
        return sanitizeDimension(readCols(), MIN_COLUMNS, MAX_COLUMNS, DEFAULT_COLUMNS)
      },
      set(value: unknown) {
        colsBacking = value
        writeThrough(colsDesc, value, v => { colsBacking = v })
      }
    })
    Object.defineProperty(target, 'rows', {
      configurable: true,
      enumerable: true,
      get() {
        return sanitizeDimension(readRows(), MIN_ROWS, MAX_ROWS, DEFAULT_ROWS)
      },
      set(value: unknown) {
        rowsBacking = value
        writeThrough(rowsDesc, value, v => { rowsBacking = v })
      }
    })
    target[PATCHED] = true
  } catch {
    // Non-configurable property on an exotic stream — leave it alone rather
    // than crashing startup. Components still have their own `?? 80` guard.
  }
}

function findDescriptor(obj: object, key: string): PropertyDescriptor | undefined {
  let cur: object | null = obj

  while (cur) {
    const desc = Object.getOwnPropertyDescriptor(cur, key)

    if (desc) {
      return desc
    }

    cur = Object.getPrototypeOf(cur) as object | null
  }

  return undefined
}

function readValue(target: object, desc: PropertyDescriptor): unknown {
  if (desc.get) {
    return desc.get.call(target)
  }

  return desc.value
}

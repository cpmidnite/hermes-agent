import { describe, expect, it } from 'vitest'

import {
  clampStdoutDimensions,
  DEFAULT_COLUMNS,
  DEFAULT_ROWS,
  MAX_COLUMNS,
  MAX_ROWS,
  sanitizeDimension,
  sanitizeTerminalSize
} from '../lib/terminalDimensions.js'

describe('sanitizeDimension', () => {
  it('passes through an in-range value', () => {
    expect(sanitizeDimension(120, 1, MAX_COLUMNS, DEFAULT_COLUMNS)).toBe(120)
  })

  it('floors fractional values', () => {
    expect(sanitizeDimension(80.9, 1, MAX_COLUMNS, DEFAULT_COLUMNS)).toBe(80)
  })

  it('clamps an absurd width to the max, not the fallback', () => {
    expect(sanitizeDimension(131072, 1, MAX_COLUMNS, DEFAULT_COLUMNS)).toBe(MAX_COLUMNS)
  })

  it('falls back when value is zero', () => {
    expect(sanitizeDimension(0, 1, MAX_COLUMNS, DEFAULT_COLUMNS)).toBe(DEFAULT_COLUMNS)
  })

  it('falls back when value is negative', () => {
    expect(sanitizeDimension(-5, 1, MAX_COLUMNS, DEFAULT_COLUMNS)).toBe(DEFAULT_COLUMNS)
  })

  it('falls back on NaN / undefined / non-number', () => {
    expect(sanitizeDimension(NaN, 1, MAX_COLUMNS, DEFAULT_COLUMNS)).toBe(DEFAULT_COLUMNS)
    expect(sanitizeDimension(undefined, 1, MAX_COLUMNS, DEFAULT_COLUMNS)).toBe(DEFAULT_COLUMNS)
    expect(sanitizeDimension('80', 1, MAX_COLUMNS, DEFAULT_COLUMNS)).toBe(DEFAULT_COLUMNS)
    expect(sanitizeDimension(Infinity, 1, MAX_COLUMNS, DEFAULT_COLUMNS)).toBe(DEFAULT_COLUMNS)
  })
})

describe('sanitizeTerminalSize', () => {
  it('sanitizes the WSL 131072x1 report', () => {
    // 131072 cols is absurd → clamp to max; 1 row is a valid (degenerate) TTY → keep.
    expect(sanitizeTerminalSize(131072, 1)).toEqual({ columns: MAX_COLUMNS, rows: 1 })
  })

  it('passes a normal terminal through unchanged', () => {
    expect(sanitizeTerminalSize(120, 40)).toEqual({ columns: 120, rows: 40 })
  })

  it('falls back when both dimensions are missing', () => {
    expect(sanitizeTerminalSize(undefined, undefined)).toEqual({
      columns: DEFAULT_COLUMNS,
      rows: DEFAULT_ROWS
    })
  })

  it('clamps an oversized height', () => {
    expect(sanitizeTerminalSize(80, 99999)).toEqual({ columns: 80, rows: MAX_ROWS })
  })
})

describe('clampStdoutDimensions', () => {
  it('clamps a bogus columns getter on a live stream', () => {
    let raw = 131072
    const stream: { columns?: number; rows?: number } = {}
    Object.defineProperty(stream, 'columns', { configurable: true, get: () => raw })
    Object.defineProperty(stream, 'rows', { configurable: true, get: () => 1 })

    clampStdoutDimensions(stream)

    expect(stream.columns).toBe(MAX_COLUMNS)
    expect(stream.rows).toBe(1)

    // Live resize still propagates through the original getter, clamped.
    raw = 100
    expect(stream.columns).toBe(100)

    raw = 0
    expect(stream.columns).toBe(DEFAULT_COLUMNS)
  })

  it('clamps a bogus plain-value columns property', () => {
    const stream: { columns?: number; rows?: number } = { columns: 131072, rows: 24 }

    clampStdoutDimensions(stream)

    expect(stream.columns).toBe(MAX_COLUMNS)
    expect(stream.rows).toBe(24)
  })

  it('is idempotent', () => {
    const stream: { columns?: number; rows?: number } = { columns: 131072, rows: 24 }

    clampStdoutDimensions(stream)
    clampStdoutDimensions(stream)

    expect(stream.columns).toBe(MAX_COLUMNS)
  })

  it('does not crash on a non-configurable property', () => {
    const stream: { columns?: number; rows?: number } = {}
    Object.defineProperty(stream, 'columns', { configurable: false, value: 131072 })

    expect(() => clampStdoutDimensions(stream)).not.toThrow()
  })

  it('forwards writes to a writable data property (Node SIGWINCH resize)', () => {
    // Real WriteStream.columns is a writable data property that Node's own
    // resize handler assigns to. The clamp must keep that write working —
    // otherwise the first resize throws "Cannot set property columns of
    // #<WriteStream> which has only a getter" and crashes the render.
    const stream: { columns?: number; rows?: number } = { columns: 80, rows: 24 }

    clampStdoutDimensions(stream)

    expect(() => { stream.columns = 120 }).not.toThrow()
    expect(() => { stream.rows = 40 }).not.toThrow()
    expect(stream.columns).toBe(120)
    expect(stream.rows).toBe(40)

    // An oversized resize write is still read back clamped.
    stream.columns = 131072
    expect(stream.columns).toBe(MAX_COLUMNS)
  })

  it('forwards writes through an original setter', () => {
    let backing = 80
    const stream: { columns?: number; rows?: number } = { rows: 24 }
    Object.defineProperty(stream, 'columns', {
      configurable: true,
      get: () => backing,
      set: (v: number) => { backing = v }
    })

    clampStdoutDimensions(stream)

    expect(() => { stream.columns = 120 }).not.toThrow()
    expect(backing).toBe(120)
    expect(stream.columns).toBe(120)
  })
})

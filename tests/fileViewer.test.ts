import { describe, it, expect } from 'vitest'
import {
  fileViewKind,
  clampPage,
  clampScale,
  pdfPageSrc,
  MIN_SCALE,
  MAX_SCALE,
} from '../src/components/fileViewerCore'

describe('fileViewKind', () => {
  it('detects images by mime', () => {
    expect(fileViewKind('image/png')).toBe('image')
    expect(fileViewKind('image/jpeg', 'x.jpg')).toBe('image')
    expect(fileViewKind('IMAGE/WEBP')).toBe('image')
  })
  it('detects pdf by mime', () => {
    expect(fileViewKind('application/pdf')).toBe('pdf')
    expect(fileViewKind('application/x-pdf')).toBe('pdf')
  })
  it('falls back to extension when mime is empty/generic', () => {
    expect(fileViewKind(null, 'plan.pdf')).toBe('pdf')
    expect(fileViewKind('', 'photo.JPG')).toBe('image')
    expect(fileViewKind('application/octet-stream', 'scan.png')).toBe('image')
    expect(fileViewKind(undefined, 'doc.pdf')).toBe('pdf')
  })
  it('returns other for unknown types', () => {
    expect(fileViewKind('application/vnd.ms-excel', 'sheet.xlsx')).toBe('other')
    expect(fileViewKind(null, 'notes.txt')).toBe('other')
    expect(fileViewKind(null, null)).toBe('other')
  })
})

describe('clampPage', () => {
  it('clamps lower bound to 1', () => {
    expect(clampPage(0)).toBe(1)
    expect(clampPage(-5)).toBe(1)
    expect(clampPage(1)).toBe(1)
  })
  it('rounds and passes through valid pages when total unknown', () => {
    expect(clampPage(3)).toBe(3)
    expect(clampPage(3.4)).toBe(3)
    expect(clampPage(999)).toBe(999)
  })
  it('clamps to [1..total] when total is known', () => {
    expect(clampPage(10, 5)).toBe(5)
    expect(clampPage(0, 5)).toBe(1)
    expect(clampPage(3, 5)).toBe(3)
  })
  it('ignores non-finite total (lower bound only)', () => {
    expect(clampPage(8, Infinity)).toBe(8)
    expect(clampPage(8, 0)).toBe(8)
    expect(clampPage(8, null)).toBe(8)
  })
  it('handles non-finite page', () => {
    expect(clampPage(NaN)).toBe(1)
    expect(clampPage(Infinity, 5)).toBe(1)
  })
})

describe('clampScale', () => {
  it('clamps to [MIN..MAX]', () => {
    expect(clampScale(0.1)).toBe(MIN_SCALE)
    expect(clampScale(100)).toBe(MAX_SCALE)
    expect(clampScale(2)).toBe(2)
  })
  it('respects custom bounds', () => {
    expect(clampScale(5, 2, 4)).toBe(4)
    expect(clampScale(1, 2, 4)).toBe(2)
  })
  it('returns min for non-finite', () => {
    expect(clampScale(NaN)).toBe(MIN_SCALE)
    expect(clampScale(Infinity)).toBe(MIN_SCALE)
  })
})

describe('pdfPageSrc', () => {
  it('appends page + FitH anchor', () => {
    expect(pdfPageSrc('blob:abc', 2)).toBe('blob:abc#page=2&view=FitH')
  })
  it('replaces existing hash and clamps page', () => {
    expect(pdfPageSrc('blob:abc#page=9', 0)).toBe('blob:abc#page=1&view=FitH')
  })
})

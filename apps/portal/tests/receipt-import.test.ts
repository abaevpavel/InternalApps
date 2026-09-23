import { describe, expect, it } from 'vitest'
import { codeForApplication } from '../src/auth/useAppAccess'
import {
  CSV_MAX_BYTES, activeRun, buildFormData, emptyForm, outcomeFromError, resultLine, submitLabel, toggleTwPerry, validateForm,
  type ImportForm, type ImportRun,
} from '../src/domain/receipt-import'

const file = (name: string, size = 1000) => new File([new Uint8Array(size)], name)

describe('receipt-import form', () => {
  it('opens on Live; dry run is opt-in', () => {
    expect(emptyForm().mode).toBe('live')
  })

  it('toggle on clears the account, toggle off clears the PDF', () => {
    const base: ImportForm = { ...emptyForm(), account: 'chase_cc', pdf: file('s.pdf') }
    expect(toggleTwPerry(base, true).account).toBeNull()
    expect(toggleTwPerry({ ...base, twperryMonth: true }, false).pdf).toBeNull()
  })

  it('validates account, csv and pdf', () => {
    expect(validateForm(emptyForm())).toMatchObject({ account: expect.any(String), csv: expect.any(String) })
    expect(validateForm({ ...emptyForm(), account: 'a', csv: file('x.txt') }).csv).toBeDefined()
    expect(validateForm({ ...emptyForm(), account: 'a', csv: file('x.csv', CSV_MAX_BYTES + 1) }).csv).toBeDefined()
    expect(validateForm({ ...emptyForm(), account: 'a', csv: file('x.CSV') })).toEqual({})
    const tw = { ...emptyForm(), twperryMonth: true, csv: file('x.csv') }
    expect(validateForm(tw)).toEqual({ pdf: expect.any(String) })
    expect(validateForm({ ...tw, pdf: file('s.pdf') })).toEqual({})
  })

  it('button labels', () => {
    expect(submitLabel({ mode: 'dry', twperryMonth: true })).toBe('Run dry run')
    expect(submitLabel({ mode: 'live', twperryMonth: false })).toBe('Import')
    expect(submitLabel({ mode: 'live', twperryMonth: true })).toBe('Import the month')
  })

  it('builds the FormData of the contract', () => {
    const fd = buildFormData({ twperryMonth: false, account: 'chase_cc', csv: file('a.csv'), pdf: null, mode: 'live' })
    expect(fd.get('twperry_month')).toBe('false')
    expect(fd.get('account')).toBe('chase_cc')
    expect(fd.get('mode')).toBe('live')
    expect(fd.has('pdf')).toBe(false)
    const tw = buildFormData({ twperryMonth: true, account: 'stale', csv: file('a.csv'), pdf: file('b.pdf'), mode: 'dry' })
    expect(tw.has('account')).toBe(false)
    expect(tw.get('pdf')).toBeInstanceOf(File)
  })
})

describe('receipt-import responses', () => {
  it('401 without error field → session expired', () => {
    expect(outcomeFromError(401, { msg: 'Missing authorization header' })).toMatchObject({ ok: false, message: 'Your session has expired. Sign in again.' })
  })
  it('400 names the field, 409 points at the running row', () => {
    expect(outcomeFromError(400, { error: 'No amount column.', field: 'csv' })).toMatchObject({ field: 'csv', message: 'No amount column.' })
    expect(outcomeFromError(409, { error: 'Busy.', run_id: 'r1' })).toMatchObject({ runId: 'r1', field: null })
  })
})

describe('receipt-import history', () => {
  const run = (status: ImportRun['status']): ImportRun => ({
    id: status, createdAt: '', createdByName: null, twperryMonth: false, account: null, mode: 'live',
    csvName: null, pdfName: null, status, summary: null, problems: [], details: [], startedAt: null, finishedAt: null,
  })
  it('queued and running lock the form', () => {
    expect(activeRun([run('done'), run('queued')])?.id).toBe('queued')
    expect(activeRun([run('done'), run('failed')])).toBeNull()
  })
  it('result line', () => {
    expect(resultLine(run('running'))).toBe('Live · in progress')
    expect(resultLine({ mode: 'dry', summary: 'nothing was written' })).toBe('Dry run · nothing was written')
  })
  it('application row maps to the app', () => {
    expect(codeForApplication({ id: 'x', name: '', description: null, url: '/receipt-import', icon: null, created_at: '' })).toBe('receipt-import')
  })
})

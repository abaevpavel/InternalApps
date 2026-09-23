import { describe, expect, it } from 'vitest'
import { normalizeValue, validateEmailList, validateValue } from '../src/domain/gmb'
import {
  effectiveEnforced, effectiveName, fromChoice, listingChanged, newListingNote, normalizeDesired, outcome, toChoice,
  type GmbListing,
} from '../src/domain/gmb-listings'

const base: GmbListing = {
  locationId: 'loc1', liveTitle: 'Basement Remodeling Rockville', registryName: 'BasementRemodeling.com Rockville',
  registryApproved: true, address: '1 Main St', storeCode: '001', lastSeenAt: null, lastRenamedAt: null,
  lastRenamedFrom: null, desiredName: null, enforceOverride: null,
}

describe('listing names — the agent’s rule', () => {
  it('three-state control: null is not false', () => {
    expect(toChoice(null)).toBe('follow')
    expect(toChoice(true)).toBe('keep')
    expect(toChoice(false)).toBe('leave')
    expect(fromChoice('follow')).toBeNull()
    expect(fromChoice('leave')).toBe(false)
  })

  it('blank desired name saves as NULL and falls back to the registry name', () => {
    expect(normalizeDesired('   ')).toBeNull()
    expect(normalizeDesired(' Rockville ')).toBe('Rockville')
    expect(effectiveName({ ...base, desiredName: '  ' })).toBe('BasementRemodeling.com Rockville')
    expect(effectiveName({ ...base, desiredName: 'X' })).toBe('X')
  })

  it('override wins over registry_approved', () => {
    expect(effectiveEnforced({ enforceOverride: null, registryApproved: false })).toBe(false)
    expect(effectiveEnforced({ enforceOverride: true, registryApproved: false })).toBe(true)
    expect(effectiveEnforced({ enforceOverride: false, registryApproved: true })).toBe(false)
  })

  it('outcome line', () => {
    expect(outcome(base)).toEqual({
      line: 'Kept as: BasementRemodeling.com Rockville',
      drift: 'Google currently shows ‘Basement Remodeling Rockville’. The next check puts it back.',
    })
    expect(outcome({ ...base, enforceOverride: false }).line).toMatch(/^Not checked/)
    expect(outcome({ ...base, registryName: null }).line).toMatch(/no name/)
    expect(outcome({ ...base, liveTitle: 'BasementRemodeling.com Rockville' }).drift).toBeNull()
  })

  it('new listing: name typed on Follow the agent is not applied', () => {
    const fresh = { ...base, registryApproved: false, desiredName: 'New name' }
    expect(newListingNote(fresh)?.ignoredName).toBeTruthy()
    expect(newListingNote({ ...fresh, enforceOverride: true })?.ignoredName).toBeNull()
    expect(newListingNote(base)).toBeNull()
  })

  it('only real changes count', () => {
    expect(listingChanged(base, { ...base, desiredName: '  ' })).toBe(false)
    expect(listingChanged(base, { ...base, enforceOverride: false })).toBe(true)
  })
})

describe('weekly review email — email_list', () => {
  it('empty list is valid', () => {
    expect(validateEmailList([])).toBeNull()
    expect(validateValue('notify_review_digest_to', 'email_list', [], [])).toBeNull()
  })
  it('refuses several addresses in one row and bad shapes', () => {
    expect(validateEmailList(['a@b.com, c@d.com'])).toMatch(/one address per row/)
    expect(validateEmailList(['a@b.com c@d.com'])).toMatch(/one address per row/)
    expect(validateEmailList(['nope'])).toMatch(/does not look like/)
    expect(validateEmailList(Array.from({ length: 21 }, (_, i) => `u${i}@b.com`))).toMatch(/At most 20/)
  })
  it('allows duplicates and drops blank rows on save', () => {
    expect(validateEmailList(['gmb@basementremodeling.com', 'GMB@basementremodeling.com'])).toBeNull()
    expect(normalizeValue('notify_review_digest_to', 'email_list', [' gmb@basementremodeling.com ', ''])).toEqual(['gmb@basementremodeling.com'])
  })
})

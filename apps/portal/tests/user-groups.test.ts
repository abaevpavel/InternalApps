import { describe, expect, it } from 'vitest'
import { groupUsersByRole, INVITES_GROUP, NO_ROLE_GROUP } from '../src/domain/user-groups'

const admin = { id: 'r-admin', name: 'Admin' }
const pm = { id: 'r-pm', name: 'PM' }
const roles = [admin, pm]

const u = (name: string, rs: { id: string; name: string }[]) => ({ name, roles: rs })

describe('groupUsersByRole — Portal Settings → Users', () => {
  it('роли в порядке справочника, «No role» последним, приглашения первыми', () => {
    const g = groupUsersByRole([u('a', []), u('b', [pm]), u('c', [admin])], [{ email: 'x' }], roles)
    expect(g.map((x) => x.key)).toEqual([INVITES_GROUP, 'r-admin', 'r-pm', NO_ROLE_GROUP])
    expect(g.at(-1)?.users.map((x) => x.name)).toEqual(['a'])
  })

  it('человек с двумя ролями есть в обоих блоках', () => {
    const g = groupUsersByRole([u('b', [admin, pm])], [], roles)
    expect(g.map((x) => [x.key, x.users.map((y) => y.name)])).toEqual([
      ['r-admin', ['b']],
      ['r-pm', ['b']],
    ])
  })

  it('пустые блоки не показываются', () => {
    const g = groupUsersByRole([u('b', [pm])], [], roles)
    expect(g.map((x) => x.key)).toEqual(['r-pm'])
  })

  it('роль, которой нет в справочнике, не теряет человека', () => {
    const g = groupUsersByRole([u('z', [{ id: 'r-old', name: 'Old role' }])], [], roles)
    expect(g.map((x) => x.label)).toEqual(['Old role'])
  })
})

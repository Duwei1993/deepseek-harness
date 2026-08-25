/** Unit coverage for the gate's self-contained pages: modes, banner, escaping. */

import { describe, expect, it } from 'vitest'
import { renderAdminPage, renderLoginPage } from '../src/pages.ts'

describe('renderLoginPage', () => {
  it('renders the login form with the bootstrap warning', () => {
    const html = renderLoginPage({ mode: 'login', bootstrapWarning: true })
    expect(html).toContain('登录 DeepSeek Harness')
    expect(html).toContain('检测到初始管理员账户')
    expect(html).toContain('/auth/login')
    expect(html).not.toContain('/auth/change-password')
  })

  it('renders the forced change form with the account name, without the banner', () => {
    const html = renderLoginPage({ mode: 'change', bootstrapWarning: false, username: 'superadmin' })
    expect(html).toContain('修改密码')
    expect(html).toContain('/auth/change-password')
    expect(html).not.toContain('检测到初始管理员账户')
  })

  it('escapes the interpolated username', () => {
    const html = renderLoginPage({ mode: 'change', bootstrapWarning: false, username: '<b>&"x"' })
    expect(html).toContain('&lt;b&gt;&amp;&quot;x&quot;')
    expect(html).not.toContain('<b>&"x"')
  })
})

describe('renderAdminPage', () => {
  it('renders the administration shell wired to the admin endpoints', () => {
    const html = renderAdminPage()
    expect(html).toContain('账户管理')
    expect(html).toContain('/auth/admin/users')
    expect(html).toContain('/reset-password')
    expect(html).toContain('/set-disabled')
  })
})

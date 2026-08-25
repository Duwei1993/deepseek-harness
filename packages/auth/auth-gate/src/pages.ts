/**
 * Self-contained HTML pages for the auth gate: the login page (credential
 * form, or the forced password-change form when the authenticated account is
 * flagged `mustChangePassword`) and the superadmin account-administration
 * page. Both pages inline their styles and script, call the gate's own JSON
 * endpoints with `fetch`, and load no external resource, so they work before
 * the SPA dist exists and under any deployment path.
 * @module @deepseek-ai/dsh-auth-gate/pages
 */

/**
 * Escape one interpolatable value for HTML text and double-quoted attributes.
 * @param text - the raw value.
 * @returns the value safe to splice into page markup.
 */
function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

/** Shared page chrome: one centered card over a plain background. */
const PAGE_STYLE = `
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #f3f4f6; color: #111827; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { background: #fff; border: 1px solid #e5e7eb; border-radius: 8px; padding: 24px;
    width: 360px; max-width: calc(100vw - 48px); box-shadow: 0 1px 3px rgb(0 0 0 / 8%); }
  h1 { font-size: 18px; margin: 0 0 16px; }
  label { display: block; font-size: 13px; margin: 12px 0 4px; }
  input, select { box-sizing: border-box; width: 100%; padding: 8px; font-size: 14px;
    border: 1px solid #d1d5db; border-radius: 6px; }
  button { margin-top: 16px; width: 100%; padding: 8px; font-size: 14px; border: 0; border-radius: 6px;
    background: #2563eb; color: #fff; cursor: pointer; }
  button:hover { background: #1d4ed8; }
  .error { color: #b91c1c; font-size: 13px; min-height: 1em; margin-top: 12px; }
  .banner { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; border-radius: 6px;
    padding: 10px 12px; font-size: 13px; margin-bottom: 16px; }
  .note { color: #4b5563; font-size: 13px; margin: 0 0 8px; }
`

/** The bootstrap banner text: the seeded superadmin still awaits its first password change. */
const BOOTSTRAP_BANNER = '检测到初始管理员账户（superadmin）仍在使用默认口令，请立即登录并修改密码。'

/** View model for {@link renderLoginPage}: the mode discriminates whether a username is present. */
export type LoginPageView = {
  /** Whether the seeded bootstrap superadmin still awaits its first password change. */
  bootstrapWarning: boolean
} & (
  | { mode: 'login' }
  | { mode: 'change'; username: string }
)

/**
 * Render the login page. In change mode the form posts to the change-password
 * endpoint instead and the page explains why; a clean authenticated visitor is
 * redirected away by the route before this renders.
 * @param view - the form mode, bootstrap warning, and current username.
 * @returns the complete HTML document.
 */
export function renderLoginPage(view: LoginPageView): string {
  const banner = view.bootstrapWarning ? `<div class="banner" id="banner">${BOOTSTRAP_BANNER}</div>` : ''
  const changeMode = view.mode === 'change'
  const heading = changeMode ? '修改密码' : '登录 DeepSeek Harness'
  const note = changeMode
    ? `<p class="note">账户 ${escapeHtml(view.username)} 的口令已被标记为必须修改，设置新口令后即可继续使用。</p>`
    : ''
  const form = changeMode
    ? `<form id="form">
        ${note}
        <label for="oldPassword">当前密码</label>
        <input id="oldPassword" name="oldPassword" type="password" autocomplete="current-password" required>
        <label for="newPassword">新密码</label>
        <input id="newPassword" name="newPassword" type="password" autocomplete="new-password" required>
        <label for="confirmPassword">确认新密码</label>
        <input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" required>
        <button type="submit">修改密码</button>
      </form>`
    : `<form id="form">
        <label for="username">用户名</label>
        <input id="username" name="username" type="text" autocomplete="username" required autofocus>
        <label for="password">密码</label>
        <input id="password" name="password" type="password" autocomplete="current-password" required>
        <button type="submit">登录</button>
      </form>`
  const script = changeMode
    ? `
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        error.textContent = ''
        if (form.newPassword.value !== form.confirmPassword.value) {
          error.textContent = '两次输入的新密码不一致。'
          return
        }
        const response = await fetch('/auth/change-password', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ oldPassword: form.oldPassword.value, newPassword: form.newPassword.value }),
        })
        if (response.ok) { location.href = '/'; return }
        const body = await response.json().catch(() => undefined)
        error.textContent = body && body.error ? body.error : '修改失败，请重试。'
      })
    `
    : `
      form.addEventListener('submit', async (event) => {
        event.preventDefault()
        error.textContent = ''
        const response = await fetch('/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ username: form.username.value, password: form.password.value }),
        })
        if (response.ok) { location.href = '/'; return }
        const body = await response.json().catch(() => undefined)
        error.textContent = body && body.error ? body.error : '登录失败，请重试。'
      })
    `
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${heading}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<h1>${heading}</h1>
${banner}
${form}
<div class="error" id="error" role="alert"></div>
</main>
<script>
const form = document.getElementById('form')
const error = document.getElementById('error')
${script}
</script>
</body>
</html>
`
}

/**
 * Render the account-administration page shell. The route answers it only for
 * an authenticated superadmin; the inline script loads the user list from the
 * gate's admin endpoints and re-renders rows after every mutation.
 * @returns the complete HTML document.
 */
export function renderAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>账户管理</title>
<style>
  ${PAGE_STYLE}
  main { width: 720px; }
  table { border-collapse: collapse; width: 100%; margin-top: 16px; font-size: 13px; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid #e5e7eb; }
  .row-actions button { width: auto; margin: 0 4px 0 0; padding: 4px 8px; font-size: 12px; }
  .row-actions button.danger { background: #b91c1c; }
  .row-actions button.danger:hover { background: #991b1b; }
  #create { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; margin-top: 8px; }
  #create button { grid-column: 1 / -1; }
  h2 { font-size: 15px; margin: 24px 0 4px; }
</style>
</head>
<body>
<main>
<h1>账户管理</h1>
<table>
  <thead><tr><th>用户名</th><th>显示名</th><th>角色</th><th>状态</th><th>操作</th></tr></thead>
  <tbody id="rows"></tbody>
</table>
<h2>创建用户</h2>
<form id="create">
  <label for="username">用户名</label>
  <label for="displayName">显示名（可选）</label>
  <input id="username" name="username" type="text" required>
  <input id="displayName" name="displayName" type="text">
  <label for="password">初始密码</label>
  <label for="role">角色</label>
  <input id="password" name="password" type="password" autocomplete="new-password" required>
  <select id="role" name="role"><option value="user">user</option><option value="superadmin">superadmin</option></select>
  <button type="submit">创建</button>
</form>
<div class="error" id="error" role="alert"></div>
<div class="note" id="status"></div>
</main>
<script>
const rows = document.getElementById('rows')
const error = document.getElementById('error')
const statusLine = document.getElementById('status')
const create = document.getElementById('create')

async function call(url, body) {
  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (response.status === 401 || response.status === 403) { location.href = '/auth/login'; return undefined }
  const data = await response.json().catch(() => undefined)
  if (!response.ok) {
    throw new Error(data && data.error ? data.error : '操作失败（' + response.status + '）')
  }
  return data
}

function describeState(user) {
  const states = []
  states.push(user.disabled ? '已禁用' : '启用')
  if (user.mustChangePassword) states.push('待改密')
  return states.join(' · ')
}

async function refresh() {
  const data = await call('/auth/admin/users')
  if (data === undefined) return
  rows.textContent = ''
  for (const user of data.users) {
    const tr = document.createElement('tr')
    for (const text of [user.username, user.displayName, user.role, describeState(user)]) {
      const td = document.createElement('td')
      td.textContent = text
      tr.append(td)
    }
    const actions = document.createElement('td')
    actions.className = 'row-actions'
    const reset = document.createElement('button')
    reset.type = 'button'
    reset.textContent = '重置密码'
    reset.addEventListener('click', async () => {
      const password = prompt('为 ' + user.username + ' 设置新密码：')
      if (password === null || password === '') return
      error.textContent = ''
      try {
        await call('/auth/admin/users/' + encodeURIComponent(user.username) + '/reset-password', { password })
        statusLine.textContent = '已重置 ' + user.username + ' 的密码（下次登录需修改）。'
        await refresh()
      } catch (failure) { error.textContent = failure.message }
    })
    const toggle = document.createElement('button')
    toggle.type = 'button'
    toggle.className = user.disabled ? '' : 'danger'
    toggle.textContent = user.disabled ? '启用' : '禁用'
    toggle.addEventListener('click', async () => {
      error.textContent = ''
      try {
        await call('/auth/admin/users/' + encodeURIComponent(user.username) + '/set-disabled', { disabled: !user.disabled })
        statusLine.textContent = (user.disabled ? '已启用 ' : '已禁用 ') + user.username + '。'
        await refresh()
      } catch (failure) { error.textContent = failure.message }
    })
    actions.append(reset, toggle)
    tr.append(actions)
    rows.append(tr)
  }
}

create.addEventListener('submit', async (event) => {
  event.preventDefault()
  error.textContent = ''
  try {
    const data = await call('/auth/admin/users', {
      username: create.username.value,
      displayName: create.displayName.value === '' ? undefined : create.displayName.value,
      password: create.password.value,
      role: create.role.value,
    })
    if (data === undefined) return
    statusLine.textContent = '已创建 ' + data.user.username + '（首次登录需修改密码）。'
    create.reset()
    await refresh()
  } catch (failure) { error.textContent = failure.message }
})

refresh().catch((failure) => { error.textContent = failure.message })
</script>
</body>
</html>
`
}

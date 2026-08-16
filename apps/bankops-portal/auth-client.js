(() => {
  function cookie(name) {
    const found = document.cookie.split(';').map(value => value.trim()).find(value => value.startsWith(`${name}=`))
    return found ? decodeURIComponent(found.slice(name.length + 1)) : ''
  }
  async function api(path, options = {}) {
    const method = String(options.method ?? 'GET').toUpperCase(), headers = new Headers(options.headers ?? {})
    if (!['GET','HEAD','OPTIONS'].includes(method)) {
      const csrf = cookie('bankops_csrf')
      if (csrf) headers.set('x-csrf-token',csrf)
    }
    const response = await fetch(path,{ ...options,headers })
    const body = response.status === 204 ? null : await response.json().catch(() => ({}))
    if (response.status === 401 && !path.endsWith('/login')) {
      location.href = `/login?next=${encodeURIComponent(location.pathname)}`
      throw new Error('登录状态已失效')
    }
    if (!response.ok) throw Object.assign(new Error(body?.message ?? body?.error ?? `HTTP ${response.status}`),{ status:response.status,body })
    return body
  }
  async function me() {
    const result = await api('/api/v1/auth/me'), user = result.user
    document.querySelectorAll('[data-user-name]').forEach(node => { node.textContent=user.displayName })
    document.querySelectorAll('[data-user-department]').forEach(node => { node.textContent=user.department.name })
    document.querySelectorAll('[data-user-avatar]').forEach(node => { node.textContent=user.displayName.slice(0,2).toUpperCase() })
    document.querySelectorAll('[data-role]').forEach(node => {
      const roles=node.dataset.role.split(',');node.hidden=!roles.some(role=>user.roles.includes(role))
    })
    return user
  }
  async function logout() { await api('/api/v1/auth/logout',{ method:'POST' });location.href='/login' }
  window.BankOpsAuth={ api,me,logout,cookie }
})()

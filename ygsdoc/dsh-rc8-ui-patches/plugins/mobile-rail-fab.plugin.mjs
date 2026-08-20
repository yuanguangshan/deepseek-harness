/**
 * mobile-rail-fab — 手机竖屏下，侧边栏收起（56px 导轨被设为 0 而看不见）时，
 * 在屏幕左下角浮一个 ☰ 小按钮，点一下就把左侧栏展开（翻 narrowExpanded）。
 * 不改宿主源码，仅通过 DOM 找宿主已有的切换按钮来触发。
 *
 * 浏览器端专用：在 Node.js 环境下跳过（避免 "document is not defined"）。
 */
export const name = 'mobile-rail-fab'
export const inject = []
export function apply(ctx) {
  // 浏览器端专用：在 Node.js 环境下跳过
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    return
  }
  const css = `.mrf-fab{position:fixed;left:12px;bottom:18px;z-index:30;width:44px;height:44px;border-radius:22px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-floating-fill);display:none;align-items:center;justify-content:center;box-shadow:0 4px 16px rgba(0,0,0,.18);cursor:pointer}.mrf-fab[data-show="1"]{display:flex}.mrf-fab:active{transform:scale(.96)}`
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = css
    document.head.appendChild(style)
    const btn = document.createElement('button')
    btn.className = 'mrf-fab'
    btn.setAttribute('aria-label', '展开侧边栏')
    btn.textContent = '☰'
    btn.style.fontSize = '18px'
    document.body.appendChild(btn)
    const update = () => {
      const narrow = window.innerWidth < 1024
      const collapsed = document.documentElement.hasAttribute('data-sidebar-collapsed') || document.body.hasAttribute('data-dsh-sidebar-collapsed')
      btn.dataset.show = (narrow && collapsed) ? '1' : '0'
    }
    const ro = new ResizeObserver(update)
    ro.observe(document.documentElement)
    window.addEventListener('resize', update)
    const mo = new MutationObserver(update)
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] })
    mo.observe(document.body, { attributes: true, attributeFilter: ['data-dsh-sidebar-collapsed'] })
    update()
    btn.addEventListener('click', () => {
      const hostToggle = document.querySelector('[aria-label*="侧边栏"],[aria-label*="Expand"],[aria-label*="Collapse"]')
      if (hostToggle instanceof HTMLElement) { hostToggle.click(); return }
      try {
        const s = window.__dshLayoutStore
        if (s && typeof s.getState === 'function' && typeof s.setState === 'function') {
          const cur = s.getState()
          if (cur && typeof cur.narrowExpanded === 'boolean') s.setState({ narrowExpanded: !cur.narrowExpanded })
        }
      } catch {}
    })
    return () => {
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('resize', update)
      btn.remove()
      style.remove()
    }
  })
}

/**
 * mobile-sidebar-always-visible — 手机端左侧菜单常显
 * 在窄屏 (<1024px) 时强制保持侧边栏展开，避免自动收起
 */
export const name = 'mobile-sidebar-always-visible'
export const inject = []
export function apply(ctx) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  const css = `
    @media (max-width: 1024px) {
      /* 强制侧边栏在手机端保持可见，不自动收起为 56px 导轨 */
      [data-dsh-frame][data-sidebar-collapsed] [class*="sidebarCol"] {
        display: flex !important;
        visibility: visible !important;
        width: 280px !important;
        min-width: 280px !important
      }
      [data-dsh-frame][data-sidebar-collapsed] {
        grid-template-columns: 280px minmax(0, 1fr) 0px !important;
      }
      /* 确保侧边栏内容不被折叠样式隐藏 */
      [data-dsh-frame][data-sidebar-collapsed] [class*="sidebarCol"] [class*="root"] {
        opacity: 1 !important;
        visibility: visible !important;
      }
    }
  `
  ctx.effect(() => {
    // 注入 CSS 保持侧边栏常显
    const style = document.createElement('style')
    style.textContent = css
    style.setAttribute('data-plugin', 'mobile-sidebar-always-visible')
    document.head.appendChild(style)

    // 同时通过 JS 强制展开：监听折叠状态，若在窄屏下被折叠则自动展开
    const tryExpand = () => {
      const isNarrow = window.innerWidth < 1024
      if (!isNarrow) return
      const frame = document.querySelector('[data-dsh-frame]')
      if (!frame) return
      const collapsed = frame.hasAttribute('data-sidebar-collapsed')
      if (collapsed) {
        const toggle = document.querySelector('[aria-label*="侧边栏"],[aria-label*="Expand"],[aria-label*="Collapse"],[class*="toggle"]')
        if (toggle instanceof HTMLElement) {
          // 使用 rAF 避免与布局动画冲突
          requestAnimationFrame(() => toggle.click())
        }
      }
    }

    // 初始检查
    const observer = new MutationObserver(tryExpand)
    const frame = document.querySelector('[data-dsh-frame]')
    if (frame) {
      observer.observe(frame, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] })
    }
    // 也监听 DOM 变化以捕获 frame 尚未挂载的情况
    const bodyObserver = new MutationObserver(() => {
      const f = document.querySelector('[data-dsh-frame]')
      if (f) {
        try { observer.observe(f, { attributes: true, attributeFilter: ['data-sidebar-collapsed'] }) } catch {}
      }
      tryExpand()
    })
    bodyObserver.observe(document.body, { childList: true, subtree: true })
    window.addEventListener('resize', tryExpand)
    // 延迟一次检查确保初始状态
    setTimeout(tryExpand, 500)

    return () => {
      style.remove()
      observer.disconnect()
      bodyObserver.disconnect()
      window.removeEventListener('resize', tryExpand)
    }
  })
}

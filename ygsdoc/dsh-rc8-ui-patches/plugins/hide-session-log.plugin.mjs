/**
 * hide-session-log — 去掉输入框上方的 session log 展示
 * 通过 CSS 隐藏 composer 上方的 session 日志区域，保留输入框本身
 */
export const name = 'hide-session-log'
export const inject = []
export function apply(ctx) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  const css = `
    /* 隐藏输入框上方的 session log 区域 - 尝试多种可能的选择器 */
    [data-slot="conversation.composer.dock"],
    [data-dsh-stats],
    [class*="sessionLog"],
    [class*="SessionLog"] {
      display: none !important;
      height: 0 !important;
      overflow: hidden !important;
    }
    /* 同时隐藏可能的外层容器 */
    [data-slot="conversation.composer.dock"]:empty {
      display: none !important;
    }
  `
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = css
    style.setAttribute('data-plugin', 'hide-session-log')
    document.head.appendChild(style)
    return () => style.remove()
  })
}

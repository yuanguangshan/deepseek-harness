/**
 * hide-session-log — 去掉输入框上方的 session log 展示
 * 通过 CSS 隐藏 composer 上方的 session 日志区域，保留输入框本身
 * 仅隐藏文字，保留图标：span 隐藏，按钮收窄
 */
export const name = 'hide-session-log'
export const inject = []
export function apply(ctx) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  const css = `
    [data-slot="conversation.composer.dock"],
    [data-dsh-stats] {
      display: none !important;
      height: 0 !important;
      overflow: hidden !important;
    }
    .nL4_yW_sessionLogButton span, button[class*="sessionLogButton"] span, [class*="sessionLogButton"] span {
      display: none !important;
    }
    .nL4_yW_sessionLogButton, button[class*="sessionLogButton"] {
      width: auto !important;
      min-width: 32px !important;
      padding: 4px 8px !important;
      gap: 0 !important;
    }
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

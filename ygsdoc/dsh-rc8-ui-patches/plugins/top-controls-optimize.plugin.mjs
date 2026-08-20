/**
 * top-controls-optimize — 上方控件优化：
 * 1) 标准模型 -> 标准
 * 2) 标准模式 -> 标准
 * 3) session log 文字不显示（保留图标，按钮收窄）
 */
export const name = 'top-controls-optimize'
export const inject = []
export function apply(ctx) {
  if (typeof document === 'undefined' || typeof window === 'undefined') return
  const css = `
    .nL4_yW_sessionLogButton span, button[class*="sessionLogButton"] span, [class*="sessionLogButton"] span {
      display: none !important;
    }
    .nL4_yW_sessionLogButton, button[class*="sessionLogButton"] {
      width: auto !important;
      min-width: 32px !important;
      padding: 4px 8px !important;
      gap: 0 !important;
    }
    /* 模型选择框收窄 */
    [class*="modelSelection"], [class*="ModelSelection"], button[class*="model"], [data-slot*="model"] {
      max-width: 140px !important;
      width: auto !important;
    }
    [class*="modelSelection"] span, [class*="ModelSelection"] span, button[class*="model"] span {
      max-width: 100px !important;
      overflow: hidden !important;
      text-overflow: ellipsis !important;
      white-space: nowrap !important;
    }
  `
  ctx.effect(() => {
    const style = document.createElement('style')
    style.textContent = css
    style.setAttribute('data-plugin', 'top-controls-optimize')
    document.head.appendChild(style)

    const doReplace = () => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null)
      let node
      while (node = walker.nextNode()) {
        const t = node.nodeValue
        if (!t) continue
        if (t.includes('标准模型') || t.includes('标准模式')) {
          const newVal = t.replace(/标准模型/g, '标准').replace(/标准模式/g, '标准')
          if (newVal !== t) node.nodeValue = newVal
        }
      }
    }

    doReplace()
    const mo = new MutationObserver(doReplace)
    mo.observe(document.body, { childList: true, subtree: true, characterData: true })
    return () => {
      mo.disconnect()
      style.remove()
    }
  })
}

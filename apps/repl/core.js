/**
 * dsh-repl 纯逻辑核心：不依赖任何 UI/终端组件，可独立单测。
 *
 * - 格式化：fmtTokens / fmtDuration
 * - 模型注册表：loadModelsFromConfig / pickRoute
 * - 会话统计：createStats / statsOnEvent / formatStatsLine
 */
import { load as yamlLoad, Schema as YamlSchema, Type as YamlType } from 'js-yaml'

// cordis.yml 使用 !!js 表达式标签，解析时按字符串处理（只读 models）
const cordisSchema = new YamlSchema({ explicit: [new YamlType('tag:yaml.org,2002:js', { kind: 'scalar', construct: s => s })] })

// ---- 格式化 ----

/** 紧凑 token 数：517 / 12.3K / 517K / 1.2M（三位以内保留一位小数）。 */
export function fmtTokens(n) {
  const scaled = v => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}

/** 紧凑时长：45.2s 以内秒，之后 m+s。 */
export function fmtDuration(ms) {
  const s = ms / 1_000
  if (s < 60) return `${Math.round(s * 10) / 10}s`
  const whole = Math.round(s)
  return `${Math.floor(whole / 60)}m${whole % 60}s`
}

// ---- 模型注册表 ----

/**
 * 解析运行时配置（cordis.yml）的 llm-pi-ai providers，合并所有 route 的模型。
 * 同一模型 id 在多个 route 出现时保留第一个（配置顺序 = responses 优先）。
 * @param configText - cordis.yml 文本。
 * @returns [{ id, name, contextWindow, maxTokens, provider }]
 */
/** 把 yaml 字段转 number；空/非法返回 undefined（js-yaml 自定义 schema 下数字可能是字符串）。 */
function numOrUndefined(v) {
  if (v === undefined || v === null || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

export function loadModelsFromConfig(configText) {
  if (typeof configText !== 'string' || configText.trim() === '') return []
  let doc
  try {
    doc = yamlLoad(configText, { schema: cordisSchema })
  } catch {
    return []
  }
  const entry = Array.isArray(doc) ? doc.find(e => e && e.id === 'llm-pi-ai') : undefined
  const providers = entry?.config?.providers ?? {}
  if (typeof providers !== 'object' || providers === null) return []
  const seen = new Set()
  const models = []
  for (const [provider, cfg] of Object.entries(providers)) {
    if (!cfg || typeof cfg !== 'object' || !Array.isArray(cfg.models)) continue
    for (const m of cfg.models) {
      if (!m || typeof m !== 'object' || typeof m.id !== 'string' || m.id === '') continue
      if (seen.has(m.id)) continue
      seen.add(m.id)
      models.push({
        id: m.id,
        name: typeof m.name === 'string' && m.name !== '' ? m.name : m.id,
        contextWindow: numOrUndefined(m.contextWindow),
        maxTokens: numOrUndefined(m.maxTokens),
        provider,
      })
    }
  }
  return models
}

/**
 * 按模型 id 选 route（接口）：模型在哪个 route 声明就用哪个，找不到回退 fallback。
 * @param modelId - 目标模型 id。
 * @param modelList - loadModelsFromConfig 的结果。
 * @param fallback - 未命中时的默认 route。
 */
export function pickRoute(modelId, modelList, fallback) {
  const found = (modelList ?? []).find(m => m.id === modelId)
  return found?.provider ?? fallback
}

// ---- 会话统计 ----

/** 新建统计对象（含计时临时态）。 */
export function createStats(providerName = '', modelName = '') {
  return {
    turns: 0, steps: 0,
    llmMs: 0, toolMs: 0,
    ttftMs: 0, ttftSteps: 0,
    decodeMs: 0, decodeTokens: 0,
    billedInput: 0, outputTokens: 0, cacheRead: 0,
    contextWindow: undefined,
    lastBilledInput: 0,
    providerName, modelName,
    // 计时临时态
    stepStart: undefined, decodeStart: undefined, toolStart: undefined, sawChunk: false,
  }
}

/**
 * 把一个 session 事件应用到统计对象（就地更新）。
 * @param stats - createStats 的结果。
 * @param event - { type, time, data }。
 * @returns 是否发生了变化（决定 UI 是否重渲染指标行）。
 */
export function statsOnEvent(stats, event) {
  const { type, time, data } = event
  switch (type) {
    case 'turn/start':
      stats.turns += 1
      return true
    case 'step/start':
      stats.steps += 1
      stats.stepStart = time
      stats.decodeStart = undefined
      stats.sawChunk = false
      return true
    case 'assistant/chunk': {
      const chunk = data?.chunk
      if (chunk && typeof chunk === 'object' && !stats.sawChunk && stats.stepStart !== undefined) {
        stats.sawChunk = true
        stats.ttftMs += Math.max(0, time - stats.stepStart)
        stats.ttftSteps += 1
        stats.decodeStart = time
        return true
      }
      return false
    }
    case 'assistant/message': {
      let changed = false
      if (stats.stepStart !== undefined) {
        stats.llmMs += Math.max(0, time - stats.stepStart)
        changed = true
        if (stats.decodeStart !== undefined) {
          stats.decodeMs += Math.max(0, time - stats.decodeStart)
        }
      }
      const usage = data?.usage
      if (usage && typeof usage === 'object') {
        const input = (usage.inputTokens ?? 0) + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
        const out = usage.outputTokens ?? 0
        stats.billedInput += input
        stats.outputTokens += out
        stats.cacheRead += usage.cacheReadTokens ?? 0
        stats.lastBilledInput = input
        if (stats.decodeStart !== undefined) stats.decodeTokens += out
        changed = true
      }
      return changed
    }
    case 'request/context': {
      let changed = false
      if (typeof data?.contextWindow === 'number') {
        stats.contextWindow = data.contextWindow
        changed = true
      }
      if (typeof data?.model === 'string' && data.model !== '') {
        stats.modelName = data.model
        stats.providerName = typeof data.provider === 'string' && data.provider ? data.provider : stats.providerName
        changed = true
      }
      return changed
    }
    case 'tool/call':
      stats.toolStart = time
      return true
    case 'tool/result':
      if (stats.toolStart !== undefined) {
        stats.toolMs += Math.max(0, time - stats.toolStart)
        stats.toolStart = undefined
        return true
      }
      return false
    default:
      return false
  }
}

// ---- 指标行渲染（样式可注入，UI 层传 ANSI 上色函数）----

const NO_STYLE = { gray: s => s, cyan: s => s, green: s => s, yellow: s => s }

/**
 * 生成底部指标行字符串（对应 web StatsLine）。
 * @param stats - createStats 的结果。
 * @param st - 可选样式函数集；缺省无色。
 * @returns 指标字符串，空会话返回 ''。
 */
export function formatStatsLine(stats, st = NO_STYLE) {
  const g = []
  if (stats.steps > 0) {
    g.push(`${stats.turns} ${st.gray('轮')} · ${stats.steps} ${st.gray('步')}`)
    const d = []
    if (stats.llmMs > 0) d.push(`${st.cyan('LLM')} ${fmtDuration(stats.llmMs)}`)
    if (stats.toolMs > 0) d.push(`${st.cyan('工具调用')} ${fmtDuration(stats.toolMs)}`)
    if (d.length > 0) g.push(d.join(' · '))
    const sp = []
    if (stats.ttftSteps > 0) sp.push(`${st.cyan('首 token 平均')} ${fmtDuration(stats.ttftMs / stats.ttftSteps)}`)
    if (stats.decodeMs > 0) {
      const tps = stats.decodeTokens / (stats.decodeMs / 1_000)
      sp.push(`${Math.round(tps * 10) / 10} ${st.cyan('tok/s')}`)
    }
    if (sp.length > 0) g.push(sp.join(' · '))
  }
  if (stats.billedInput > 0 || stats.outputTokens > 0) {
    if (stats.cacheRead > 0) {
      g.push(`${st.green('缓存命中')} ${Math.round(stats.cacheRead / stats.billedInput * 100)}%`)
    }
    g.push(`${st.gray('输入')} ${fmtTokens(stats.billedInput)} tokens · ${st.gray('输出')} ${fmtTokens(stats.outputTokens)} tokens`)
    if (stats.contextWindow !== undefined && stats.lastBilledInput > 0) {
      const pct = Math.min(100, Math.round(stats.lastBilledInput / stats.contextWindow * 100))
      g.push(`${st.yellow('ctx')} ${pct}%`)
    }
  }
  return g.join(`  ${st.gray('|')}  `)
}

/** 模型标签（状态栏右侧）：provider · model。 */
export function formatModelTag(providerName, modelName) {
  return `${providerName} · ${modelName}`
}

#!/usr/bin/env node
/**
 * dsh-repl 开发模式：监听源码变更，自动重启 REPL。
 *
 * - 改 apps/repl/tui-repl.mjs / core.js 保存后自动重启（无需手动）
 * - 用户 /exit 退出后不自动重启；Ctrl+C 结束开发模式
 * - 生产环境仍用 `dr`（手动启动）
 */
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { join, resolve } from 'node:path'

const ROOT = resolve('/Users/ygs/ygs/deepseek-harness')
const WATCH_FILES = ['apps/repl/tui-repl.mjs', 'apps/repl/core.js']
const REPL_BIN = join(ROOT, 'apps/repl/tui-repl.mjs')

let child = null
let restarting = false

function start() {
  console.log('\n[dsh-repl-dev] 启动 REPL（源码变更自动重启）…')
  child = spawn(process.execPath, [REPL_BIN], {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: process.env,
  })
  child.on('exit', (code) => {
    child = null
    if (restarting) return
    console.log(`\n[dsh-repl-dev] REPL 退出 (${code ?? 'unknown'})。Ctrl+C 结束开发模式。`)
  })
}

for (const rel of WATCH_FILES) {
  watch(join(ROOT, rel), () => {
    if (child === null || restarting) return
    restarting = true
    console.log(`\n[dsh-repl-dev] ${rel} 变更，重启 REPL…`)
    child.kill('SIGTERM')
    setTimeout(() => {
      restarting = false
      start()
    }, 400)
  })
}

process.on('SIGINT', () => {
  if (child) child.kill('SIGINT')
  process.exit(0)
})

start()

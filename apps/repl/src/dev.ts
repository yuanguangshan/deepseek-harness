/**
 * dsh-repl dev mode: watch source changes and auto-restart the TUI.
 *
 * - Saving a watched source file (the TUI shell, core, status bar, text2card) restarts the REPL automatically.
 * - A user /exit does not restart; Ctrl+C ends dev mode.
 * - Production launches run `pnpm repl` directly.
 */
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './core.ts'

// repoRoot() derives the repository root; moving the tree or changing machines needs no code edit.
const root = repoRoot()
const watchFiles = ['apps/repl/src/tui-repl.ts', 'apps/repl/src/core.ts', 'apps/repl/src/status-bar.ts', 'apps/repl/src/text2card.ts']
const replBin = join(root, 'apps/repl/src/bin.ts')

let child: ReturnType<typeof spawn> | null = null
let restarting = false

const start = (): void => {
  console.log('\n[dsh-repl-dev] 启动 REPL（源码变更自动重启）…')
  child = spawn(process.execPath, ['--import', 'tsx/esm', replBin], {
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

for (const rel of watchFiles) {
  watch(join(root, rel), () => {
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
  if (child !== null) child.kill('SIGINT')
  process.exit(0)
})

start()

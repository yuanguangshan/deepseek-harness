/**
 * dsh-repl dev mode: watch source changes and auto-restart the TUI.
 *
 * - Saving any file under `apps/repl/src` restarts the REPL automatically
 *   (recursive watch, so new modules are picked up without editing this list).
 * - A user /exit does not restart; Ctrl+C ends dev mode.
 * - Production launches run `pnpm repl` directly.
 */
import { spawn } from 'node:child_process'
import { watch } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './core.ts'

// repoRoot() derives the repository root; moving the tree or changing machines needs no code edit.
const root = repoRoot()
const srcDir = join(root, 'apps/repl/src')
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

// Recursive watch over the whole source dir: any .ts change restarts the REPL.
// Editors emit several events per save; the restarting flag + 400 ms debounce
// collapses them into one restart.
watch(srcDir, { recursive: true }, (_event, filename) => {
  if (child === null || restarting) return
  if (filename !== null && !filename.endsWith('.ts')) return
  restarting = true
  console.log(`\n[dsh-repl-dev] ${filename ?? 'src'} 变更，重启 REPL…`)
  child.kill('SIGTERM')
  setTimeout(() => {
    restarting = false
    start()
  }, 400)
})

process.on('SIGINT', () => {
  if (child !== null) child.kill('SIGINT')
  process.exit(0)
})

start()

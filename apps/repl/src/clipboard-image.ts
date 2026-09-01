/**
 * Clipboard image ingest for ctrl+v: grab the macOS pasteboard's PNG payload
 * (if any) and write it to a temp file so it can ride the next prompt as an
 * image attachment. The grab runs as a JXA (`osascript -l JavaScript`) script
 * that reads its target path from the environment — no shell quoting of paths.
 * @module @deepseek-ai/dsh-repl/clipboard-image
 */

import { runCommand, type RunResult } from './run.ts'

/**
 * JXA program: read `CLIP_IMAGE_TARGET` from the environment, copy the
 * pasteboard's PNG data to that path, and print one machine-readable verdict.
 * `NO_IMAGE` means the pasteboard holds no PNG; `WRITE_FAILED` means Cocoa
 * could not write the file.
 */
export const CLIPBOARD_IMAGE_JXA = [
  "ObjC.import('AppKit')",
  "ObjC.import('Foundation')",
  'const env = $.NSProcessInfo.processInfo.environment',
  "const target = env.objectForKey('CLIP_IMAGE_TARGET')",
  "if (target === undefined || target.isNil() || target.js === '') { 'NO_TARGET' }",
  'else {',
  '  const pb = $.NSPasteboard.generalPasteboard',
  '  const data = pb.dataForType($.NSPasteboardTypePNG)',
  "  if (data.isNil()) { 'NO_IMAGE' }",
  '  else { data.writeToFileAtomically(target, true) ? \'OK\' : \'WRITE_FAILED\' }',
  '}',
].join('\n')

/** Outcome of one clipboard grab. */
export interface ClipboardImageResult {
  ok: boolean
  /** Set when `ok`. */
  path?: string
  /** Human-readable failure reason when not `ok`. */
  error?: string
}

/** Map a JXA verdict to a result; exported for tests. */
export function interpretClipboardVerdict(verdict: string, targetPath: string): ClipboardImageResult {
  switch (verdict.trim()) {
    case 'OK': return { ok: true, path: targetPath }
    case 'NO_IMAGE': return { ok: false, error: '剪贴板里没有图片（只支持 PNG 截图/复制的图片）' }
    case 'NO_TARGET': return { ok: false, error: '目标路径未传入（CLIP_IMAGE_TARGET 缺失）' }
    case 'WRITE_FAILED': return { ok: false, error: `剪贴板图片写入失败: ${targetPath}` }
    default: return { ok: false, error: `剪贴板读取异常: ${verdict.trim() || '(空输出)'}` }
  }
}

/**
 * Grab the pasteboard image to `targetPath`. Resolves `{ ok: false }` with a
 * user-facing reason on any failure — never throws.
 */
export async function clipboardImageTo(
  targetPath: string,
  runner: (bin: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => Promise<RunResult> = defaultRunner,
): Promise<ClipboardImageResult> {
  if (process.platform !== 'darwin') {
    return { ok: false, error: '剪贴板贴图目前仅支持 macOS' }
  }
  try {
    const result = await runner('osascript', ['-l', 'JavaScript', '-e', CLIPBOARD_IMAGE_JXA], {
      env: { ...process.env, CLIP_IMAGE_TARGET: targetPath },
    })
    return interpretClipboardVerdict(result.stdout, targetPath)
  } catch (error) {
    return { ok: false, error: `剪贴板读取失败: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/** Adapt the shared {@link runCommand} to an injectable env option. */
const defaultRunner: (bin: string, args: readonly string[], options?: { env?: NodeJS.ProcessEnv }) => Promise<RunResult> =
  (bin, args, options) => runCommand(bin, args, options?.env === undefined ? {} : { env: options.env })

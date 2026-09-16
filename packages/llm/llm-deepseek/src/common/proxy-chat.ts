/**
 * Upstream-proxy conversation pinning headers.
 *
 * A local DeepSeek proxy in front of the provider keeps one upstream
 * conversation per `x-chat-id`, so a harness session must repeat the same id to
 * continue a conversation instead of starting a fresh upstream turn. Title
 * generation shares one namespace across sessions (a per-session id would leak
 * one throwaway upstream conversation per title), and compaction must reset the
 * upstream conversation because the summarised context replaces the history.
 *
 * @module dsh-llm-deepseek/proxy-chat
 */

import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

/** Upstream-proxy headers pinning one conversation; empty without a session scope. */
export type ProxyChatHeaders = Readonly<Record<string, string>>

/** Namespace every session's title generation shares instead of pinning its own upstream conversation. */
const TITLE_CHAT_ID = 'dsh-title-gen'

/**
 * Resolve the upstream-proxy conversation-pinning headers for one request.
 * @param options - request options carrying the session scope and call purpose.
 * @returns `x-chat-id` for a session-scoped request, plus `x-chat-reset` when compaction rewrites the context; empty for a call with no session.
 */
export function proxyChatHeaders(options: GenerateOptions): ProxyChatHeaders {
  if (options.sessionId === undefined) return {}
  return {
    'x-chat-id': options.purpose === 'session-title' ? TITLE_CHAT_ID : String(options.sessionId),
    ...options.purpose === 'compaction' ? { 'x-chat-reset': '1' } : {},
  }
}

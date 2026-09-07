# Agent Note: Per-conversation session header for `llm-pi-ai` routes

Status: implemented

English | [中文](2026-09-08-pi-ai-session-header.zh.md)

## Problem

OpenCode Go's Console Go gateway began rejecting requests that do not carry an
`x-opencode-session` header on 2026-09-05, answering `400 MissingSessionID`.
The header is the gateway's per-conversation routing key: it wants a stable id
per conversation so a conversation keeps landing on the same upstream replica
and its prompt cache stays warm.

The existing profile surface could not express this. `headers` holds static
values, so every conversation on a route shares one id. That satisfies the
gateway's presence check — it does not reject a fixed value — while defeating
the thing the header exists for: a single fixed value collapses every
conversation into one routing bucket, so switching conversations keeps hitting
the same replica with unrelated prefixes. Users who adopted the static
workaround reported exactly that outcome as slower responses and higher spend.
Meanwhile `GenerateOptions.sessionId` was already threaded into every
`streamSimple` call but reached no header, and the repository's drift gates
withhold pi-ai's `sendSessionAffinityHeaders` and `sessionAffinityFormat`, so
no upstream compat switch could supply the header either.

## Decision

`PiAiProviderProfile` gains a `sessionHeader?: string` field. When a route sets
it, the adapter stamps that header with the conversation's session id on every
request the route makes, sourcing the value from the same
`GenerateOptions.sessionId` already forwarded to pi-ai. Routes that do not set
it are byte-for-byte unchanged.

The rules at the single injection site (`requestHeaders` in
`packages/llm/llm-pi-ai/src/adapter.ts`):

- **The runtime value replaces a same-named static `headers` entry**, matched
  case-insensitively. A fixed value cannot do a per-conversation id's job, so
  silently merging or losing to it would preserve the bug the field exists to
  remove. A deployment that configures both gets the per-conversation id.
- **Harness attribution still wins.** `user-agent` remains reserved, so the
  field cannot be used to impersonate the harness.
- **No session id means no header.** A request with `sessionId` unset sends the
  header name not at all rather than sending an empty or invented value.

The field is opt-in and protocol-neutral: it rides on request headers, so
`openai-completions`, `openai-responses`, and `anthropic-messages` routes are
all covered with no per-protocol work. It is deliberately not gated on a
provider id or hostname — which gateway wants a session header, and under what
name, is a deployment fact that belongs in configuration, not in a
hardcoded route-name list the harness would have to update per gateway.

Auxiliary calls are covered because they already carry the conversation id:
session titles (`dsh-session-title-llm`) and compaction summaries
(`dsh-compaction-basic`) both set `sessionId`, so a turn's chat, title, and
summary requests present the same id to the gateway. Model discovery is
untouched — it lists models for a draft configuration that has no conversation.

## Alternatives considered

- **Hardcode `x-opencode-session` on routes whose id starts with `opencode`, or whose base URL host is `opencode.ai`.** Zero configuration, and it is what unblocks users fastest. Rejected as the shipped shape: it encodes one vendor's contract in the harness, breaks for a self-hosted or proxied Console Go deployment, and hides a wire-visible behavior behind hostname matching that a configuration surface cannot show or override. The field reaches the same wire result with one config line and no vendor name in the source.
- **Send the header unconditionally on every provider request.** Rejected: an unrelated provider receiving an OpenCode-specific header is a leak, and the gateway's requirement is not universal. Discovery probes in particular have no conversation to identify.
- **Upstream pi-ai's `sendSessionAffinityHeaders` / `sessionAffinityFormat`.** Rejected as a prerequisite: both are withheld by this package's drift gates, the switch defaults to false, and its wire formats (`session_id`, `x-client-request-id`, `x-session-affinity`) do not include `x-opencode-session`. Adopting it would need upstream work before it could help this gateway.
- **Derive a bare UUID from the `session-<uuid>` conversation id.** Rejected: verified against the live gateway, which returns `200` for the full `session-<uuid>` shape, so normalization would add code to solve a problem the gateway does not have.
- **Extend `dsh-llm`'s attribution layer so all adapters carry it.** Rejected for now: `dsh-llm-deepseek` already sends its own session header with different semantics and its own decision, and this gateway's requirement arrived on the pi-ai path. Promoting a shared mechanism is a separate decision if another adapter needs it.

## Consequences

Cost: one more profile field to document, and a deployment must add one line
per OpenCode Go route rather than getting it for free. A route that configures
`sessionHeader` and also has a same-named static entry sees the static entry
silently ignored — deliberate, but it is a configuration surprise worth stating
in the field's JSDoc.

Bought: per-conversation routing works on every protocol and every auxiliary
call, with no vendor name in the source and no per-protocol code. The
static-header failure mode — all conversations sharing one bucket — becomes
unreachable on a route that adopts the field. And because the value comes from
the id the session log already records, the header is reconstructable from the
log, keeping the model-visible/logged invariant intact.

## Testing

Four wire-level specs in `packages/llm/llm-pi-ai/tests/adapter.spec.ts` assert
the header against the mock server: the value is stamped, it replaces a
same-named static entry case-insensitively while other entries survive, it is
absent when the request carries no session id, and a static entry still arrives
untouched when no `sessionHeader` is configured.

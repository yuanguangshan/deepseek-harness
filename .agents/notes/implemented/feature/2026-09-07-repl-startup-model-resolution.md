# Agent Note: REPL startup model resolution from last-used, env, and user settings

Status: implemented

English | [中文](2026-09-07-repl-startup-model-resolution.zh.md)

## Problem

`dsh-repl` hardcoded its startup route: `PROVIDER` defaulted to `ccswitch` and `MODEL` to `glm-5.3-flash`, overridable only by `DSH_REPL_PROVIDER` / `DSH_REPL_MODEL`. That default had two effects. A `/model` switch lasted exactly one process — every restart dropped the user back onto the fallback, so the model the user actually chose was lost. And the REPL ignored `agent-default-model` in `<DSH_HOME>/settings.yaml`, the block `dsh web` already honors, so the two front-ends disagreed about which model a session starts on.

The zhipu coding-plan route expiring (glm moved to `ccswitch`) made the second point concrete: a route can disappear between runs, so any remembered or configured model must be validated before it is used, or startup fails on a model the route table no longer declares.

## Decision

`resolveStartupModel()` in `apps/repl/src/tui-repl.ts` picks the startup pair, in order:

1. `~/.dsh/last-model.json` — written by `writeLastModel()` on every successful `/model` switch and startup. Accepted only when the runtime route table declares that provider+model. `DSH_REPL_LAST_MODEL_FILE` relocates the file; `DSH_REPL_NO_LAST_MODEL=1` skips this step.
2. `DSH_REPL_PROVIDER` / `DSH_REPL_MODEL` — read as a pair; whichever side is unset falls back to the hardcoded value for that side, so a half-set pair cannot produce a provider/model mismatch.
3. `agent-default-model` in `<DSH_HOME>/settings.yaml` — parsed by `parseAgentDefaultModel()` in `apps/repl/src/core.ts` and accepted only when the route table declares the pair. `DSH_HOME` overrides the directory, `<DSH_HOME>/settings.yaml` is the same file `dsh web` reads.
4. Hardcoded fallback `{ provider: 'ccswitch', model: 'glm-5.3-flash' }`.

Route-table validation reads the config once and is reused across steps; an unreadable config or settings file falls through to the next step instead of failing startup. A malformed or partial `last-model.json` is treated as no history.

`~/.dsh/last-model.json` is the same file the weclaw `dsh-openai-server.mjs` uses, so a model chosen through that channel carries into the REPL and back.

## Testing

`tests/core.spec.ts` pins `parseAgentDefaultModel`: it parses a well-formed block, returns undefined when the block is missing or has only one field, and returns undefined for empty text, unparsable YAML, a non-object block, a sequence root, and `null`/`undefined` input.

## Alternatives considered

- **Persisting the model in the REPL's own memory dir** (`~/.dsh-repl/memory/…`). Rejected: the weclaw `dsh-openai-server` already owns `~/.dsh/last-model.json`; a second store would fork the two channels instead of letting them agree.
- **Trusting `agent-default-model` without route validation.** Rejected: the zhipu coding-plan route expired out from under a previously valid default; an unvalidated remembered model turns a route removal into a startup failure.
- **Letting a half-set env pair pass through** (using the other side's remembered or configured value). Rejected: mixing a remembered provider with an env model produces a pair nobody chose; both sides of an env override now come from the same source.
- **Reusing the existing YAML load path in `tui-repl.ts` directly.** Rejected: `core.ts` is the assertion-worthy pure module and the only place the REPL's parsing logic can be unit-tested; the parse lives there and is exported.

## Consequences

A `/model` choice survives restarts, and the REPL and `dsh web` start on the same configured model. A removed or renamed route can no longer break startup — the stale entry is skipped, and resolution continues down the list. Users who want a pinned startup model set `DSH_REPL_NO_LAST_MODEL=1` (plus env or settings), which is the escape hatch when a remembered model is not wanted.

## Related

The REPL's own model-switching surface: [the REPL productivity command suite note](2026-09-01-repl-productivity-command-suite.md).

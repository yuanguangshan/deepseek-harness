# @deepseek-ai/dsh-command-title

English | [中文](README.zh.md)

Human-facing `/rename <title>` slash command pinning the current session's title. The command delegates validation and acceptance to `ctx.sessionTitle.rename()` (see [`@deepseek-ai/dsh-session-title`](../session-title)): it appends the `session/title` event with the `user` source, which also stops automatic title generation for that session.

## Behavior

- `/rename` or `/rename   ` (whitespace only) returns `Usage: /rename <new title>` without touching the log.
- `/rename <title>` normalizes the text, appends the `session/title` event, and returns `Title set: <normalized title>`.
- Domain validation failures (`SessionTitleInvalidError` — e.g. a title that normalizes to empty or exceeds `maxTitleBytes`) return a usage error result carrying the service's message.
- Any other handler failure propagates unchanged to the executor.

## Usage

```yaml
# cordis.yml
- id: command-title
  name: '@deepseek-ai/dsh-command-title'
```

The plugin injects `commands` and `sessionTitle`; it registers one global command named `rename` whose descriptor is:

```json
{ "name": "rename", "description": "rename the current session (pins the title; automatic generation stops)", "input": { "hint": "<new title>" } }
```

Disposing the plugin unregisters the command.

## Model Experience

### `/rename` command state

#### What the model sees

Nothing. `/rename` is a UI-command seam: the handler runs on `ctx.sessionTitle.rename()` and appends the log-only `session/title` event, which never enters the session surface, `deriveMessages()`, system prompt, tool schemas, or request prefix.

#### Token effect

Zero. The command's result text goes to the invoking client only; title events add no tokens to any agent request.

#### KV Cache effect

None. Title events do not change the reconstructed request content or cache key.

## Known Limitations and Deferred Work

- The command accepts no scoped variants: it always renames the invoking agent's session and provides no batch or cross-session rename.
- Input grammar is a single hint (`<new title>`); rich editing (multiline titles, attachments) is not accepted and silently falls back to usage on a mismatched invocation shape.

# Agent Note: Capture generated Remote namespaces at construction

Status: implemented

English | [中文](2026-09-08-caller-bound-remote-namespace.zh.md)

## Problem

The Client Remote Service materializes each generated namespace as a `remote.<namespace>` child Service ([Typert Gateway targeted method calls](./2026-08-02-typert-remote-method-calls.md)). Reading `ctx.remote.session` is not a plain property read: Cordis resolves it through the `associate` branch of the traceable service proxy, which binds the lookup to the context performing the read, and a non-`noShadow` service has its shadow stripped before that lookup. A Cordis Service method invoked through the context proxy runs with `this.ctx` rebound to the caller's extended context, so a generated-namespace read inside such a method resolves against the caller's fiber chain.

The failure is invisible while every caller lives in the service's own package: that package's plugin injects the namespace, so the caller's fiber chain contains it. `ui-model-selection`'s `ModelDirectoryResolver.directoryFor` read `this.ctx.remote.session`; `ui-conversation` — a different package — captured the service through its own `ctx.inject(['modelDirectories'])` barrier and called `directoryFor`, whose fiber chain has no `remote.session`. The composer model seat then crashed its slot with `cannot get property "remote.session" without inject`.

## Decision

A Client service that needs a generated Remote namespace captures it in its constructor, where `this.ctx` is the service's own context and the namespace is a declared injection, and reads the captured face from its methods. `ModelDirectoryResolver` stores `ctx.remote.session` in a readonly field at construction and hands that field to `ModelDirectory`.

A method that genuinely needs the namespace per call reads `ctx.get('<service>.<namespace>')`, the unguarded store read. `ctx.get('<service>').<namespace>` does not help: the `.<namespace>` step still takes the `associate` path and binds to the reading context.

## Alternatives considered

**Keep the in-method read and make callers inject `remote.session`.** Rejected: `ui-conversation` never reads the namespace, so the edge would exist only to satisfy another package's internal resolution, and every future cross-package caller would have to discover and repeat it.

**Read `this.ctx.get('remote').session`.** Rejected: `ctx.get` only changes how the `remote` service is obtained; the `.<namespace>` step still resolves through `associate` against the reading context and fails identically.

**Move directory resolution into `ui-conversation`.** Rejected: the per-session directory is the shared state of both selection entries and belongs to the owning service; the consumer needs only the current model name.

## Consequences

- The service's public methods work from any package, which is the contract a `ctx.<name>` service advertises; adding a cross-package caller can no longer reintroduce the crash.
- The face is resolved once per service instance. A namespace re-provided after a reconnect or HMR is not picked up automatically; a service that must track re-provisioning reads it per call through `ctx.get(...)`.
- The regression test needs a Service-backed remote (a plain-object double carries no tracker), the namespace provided from a child fiber, and a foreign-plugin caller. The previous plain double with a root-provided namespace could not fail.

## Related

Generated-namespace mechanism and its Agent Scope binding: [Typert Gateway targeted method calls](./2026-08-02-typert-remote-method-calls.md).

# Agent Note: 生成的 Remote 命名空间在构造时捕获

Status: implemented

English | [中文](2026-09-08-caller-bound-remote-namespace.md)

## Problem

客户端 Remote Service 把每个生成命名空间物化为 `remote.<namespace>` 子 Service（见[Typert 网关定向方法调用](./2026-08-02-typert-remote-method-calls.zh.md)）。读取 `ctx.remote.session` 不是普通属性读取：Cordis 通过可追踪服务代理的 `associate` 分支解析它，而该分支把查找绑定到**执行读取的 ctx**，且非 `noShadow` 服务在查找前会先剥掉 shadow。经 ctx 代理调用的 Cordis Service 方法运行时 `this.ctx` 被重绑到调用方的扩展 ctx，于是方法内部读取生成命名空间时，解析走的是**调用方的 fiber 链**。

只要调用方都住在该服务自己的包内，这个差异不可见：该包的插件注入了命名空间，调用方 fiber 链上就有它。`ui-model-selection` 的 `ModelDirectoryResolver.directoryFor` 读 `this.ctx.remote.session`；而 `ui-conversation`（另一个包）经自己的 `ctx.inject(['modelDirectories'])` 屏障拿到该服务并调用 `directoryFor`，其 fiber 链没有 `remote.session`。于是 composer 的模型席位把整个 slot 崩成 `cannot get property "remote.session" without inject`。

## Decision

需要生成 Remote 命名空间的客户端服务**在构造函数中捕获它**——此时 `this.ctx` 是服务自己的 ctx，命名空间是已声明的注入——方法内只读捕获到的 face。`ModelDirectoryResolver` 在构造时把 `ctx.remote.session` 存进只读字段，并把这个字段传给 `ModelDirectory`。

确实需要每次调用都读命名空间的方法，用 `ctx.get('<service>.<namespace>')`（无守卫的 store 读取）。`ctx.get('<service>').<namespace>` 不解决问题：`.<namespace>` 这一步仍走 `associate` 路径并绑定到读取方 ctx。

## Alternatives considered

**保留方法内读取，要求调用方注入 `remote.session`。** 否决：`ui-conversation` 从不读该命名空间，这条依赖边只为满足另一个包的内部解析而存在，且未来每个跨包调用方都得自己发现并重复它。

**改读 `this.ctx.get('remote').session`。** 否决：`ctx.get` 只改变 `remote` 服务的获取方式；`.<namespace>` 这一步仍经 `associate` 按读取方 ctx 解析，同样失败。

**把目录解析搬进 `ui-conversation`。** 否决：每会话目录是两个选择入口共享的状态，属于拥有它的服务；消费方只需要当前模型名。

## Consequences

- 服务的公开方法对任何包都可用，这正是 `ctx.<name>` 服务所宣称的契约；新增跨包调用方不会再引入该崩溃。
- face 每个服务实例只解析一次。重连或 HMR 之后重新 provide 的命名空间不会被自动拾取；需要跟踪重新提供场景的服务仍按调用用 `ctx.get(...)` 读取。
- 回归测试需要「Service 版 remote（普通对象替身不带 tracker）+ 命名空间由子 fiber 提供 + 外部插件调用方」三者齐备。此前「普通替身 + root provide 命名空间」的装配无法复现。

## Related

生成命名空间机制及其 Agent Scope 绑定：[Typert 网关定向方法调用](./2026-08-02-typert-remote-method-calls.zh.md)。

# 开发大坑_cordis跨包调用服务方法踩remote.session_2026-09-08

> 现象：fork 构建的 GUI 输入栏一渲染就崩，控制台 `cannot get property "remote.session" without inject`
> 根因：cordis 的命名空间访问 `ctx.<svc>.<ns>` 绑定到**读取方 ctx**；Service 方法被跨包调用时 `this.ctx` 被重绑到调用方语境，而调用方 fiber 链里没有该命名空间
> 修复：`ModelDirectoryResolver` 在**构造时**捕获 `ctx.remote.session`，方法内不再依赖调用方语境
> 关联提交：dev `2f45ac2059`

---

## 现象

fork 构建（dev 分支，`http://127.0.0.1:3081`）打开会话即崩，输入栏整块消失：

```
Error: cannot get property "remote.session" without inject
    at Object.get (index.js:130:95)
    at Proxy.directoryFor (service.ts:78:23)
    at Object.apply (index.js:120:36)
    at useSeatModelName (apply.ts:323:78)
    at InputBar (InputBar.tsx:70:21)
scoped-slots.tsx:334 slot entry crashed in 'conversation.composer.bar'
```

同一台机器上 3080（全局 alpha.2）完全正常 —— 这个「一边崩一边不崩」是第一条线索：问题不在 GUI 本身，而在 **fork 的代码路径**。

行号也对得上：dev 的 `ui-conversation/src/client/apply.ts:323` 正是 `seatDirectories?.directoryFor(sessionId)`；`ui-model-selection/src/client/service.ts:78` 正是 `this.ctx.remote.session`，报错列 23 落在 `.session` 上。

## 根因链

### 1. `ctx.remote.session` 不是普通属性访问

`remote` 是一个带 tracker 的 cordis Service（`associate: 'remote'`，见 `vendor/cordis/src/service.ts:46-55`），而 `session` 并不是它的自有属性，是**另一条 ctx 服务**：

```ts
// packages/api/gateway/src/client/index.ts:660
ctx.provide(`remote.${namespace}`, face)   // 生成 remote.session / remote.commands / ...
```

于是读 `ctx.remote.session` 时，`createTraceable` 的 get trap 命中 associate 分支，转成对 **ctx 属性** `'remote.session'` 的读取：

```ts
// vendor/cordis/src/utils.ts:180-181
if (tracker.associate && ctx.reflect.props[`${tracker.associate}.${prop}`]) {
  return Reflect.get(ctx, `${tracker.associate}.${prop}`, ...)
}
```

### 2. 这里的 `ctx` 是「读取方」的 ctx，且 shadow 被剥掉

`createTraceable` 对**非 noShadow** 服务会先把 shadow 摘掉：

```ts
// vendor/cordis/src/utils.ts:170-172
if (ctx[symbols.shadow] && !tracker.noShadow) {
  ctx = Object.getPrototypeOf(ctx)   // ← shadow 没了，退回绑定该 traceable 的 ctx
}
```

reflect 的 get trap 随后沿 `ctx[symbols.shadow] ?? ctx` 的 fiber 向上找实现，找不到就抛错：

```ts
// vendor/cordis/src/reflect.ts:144 / 155 / 163
const error = new Error(`cannot get property "${prop}" without inject`)
let fiber = (ctx[symbols.shadow] as Context ?? ctx).fiber
...
if (!fiber.runtime) throw error
```

### 3. 为什么 `this.ctx.sessions` 没事、`this.ctx.remote.session` 就炸

Service 方法被 traceable 代理调用时，`this` 被换成 `ctx.extend({ shadow: origin })`：

- `this.ctx.sessions`（**直接注入**）→ 沿 shadow origin（服务自己的 fiber）解析 → 服务声明了 `sessions` → 正常；
- `this.ctx.remote.session`（**嵌套命名空间**）→ 第一跳 `remote` 也走 origin，但第二跳 `.session` 走 associate，绑定回**调用方 ctx** → 调用方 fiber 链里没有 `remote.session` → 抛错。

### 4. 为什么上游不炸、fork 炸

上游 alpha.2 的 `ModelDirectoryResolver` 用同样的 `this.ctx.remote.session`，但它的调用方全在**本包内**（`ui-model-selection/src/client/index.ts` 的两个入口，fiber 链包含 `remote.session`）。

fork 的 `ui-conversation` 用自己的屏障拿到服务后**跨包**调用：

```ts
// packages/client/ui-conversation/src/client/apply.ts:319-323
ctx.inject(['modelDirectories'], (scope) => {
  seatDirectories = scope.modelDirectories
})
const useSeatModelName = (sessionId) => seatDirectories?.directoryFor(sessionId)
```

调用方 ui-conversation 的 inject 里没有 `remote.session` → 炸。这是上游从未覆盖的用法，merge 时踩出来的。

对照：fork 的 **master** 版 resolver 用 `this.ctx.get('connection').api.sessions`（无守卫读）所以不炸；dev 合并上游后改成了嵌套命名空间写法，才引入此坑。

## 排查过程

### 最小复现（决定性一步）

用 vendored cordis 搭三个插件（provider 提供 `remote` Service + `remote.session`；resolver 是 Service；foreign 插件经自己的 inject 屏障调用），四种写法矩阵：

| 写法 | 结果 |
|---|---|
| `this.ctx.remote.session` | ❌ `cannot get property "remote.session" without inject` |
| `this.ctx.get('remote').session` | ❌ 同样抛错（`.session` 仍走 associate，绑回调用方 ctx） |
| `this.ctx.get('remote.session')` | ✅ |
| 构造时 `const x = ctx.remote.session` 存字段 | ✅ |

注意第二个：`ctx.get('remote')` 并不能救 —— 它只是换了个入口拿 `remote`，`.session` 的 associate 解析照样绑调用方。

### 为什么仓库单测抓不到

`packages/test-support/client-runtime/src/remote.ts` 的 `TestRemote` 是**普通类**（`ctx.provide('remote', this)`），没有 `symbols.tracker`，`ctx.remote.session` 退化成普通自有属性访问，根本走不到 associate 分支；而且规格里命名空间是在 **root ctx** 上 provide 的，跨包也能沿链走到 root。

要复现必须同时满足三点：

1. remote 是**真实 Service**（带 tracker）；
2. 命名空间由**子 fiber** provide（真实网关就是 `ctx.provide` 在自己的 plugin fiber 上）；
3. 调用方是**另一个插件**、经自己的 inject 屏障拿服务。

按这三条给规格补了回归用例：修复前它失败并吐出**逐字相同**的原始错误串，修复后通过。

## 修复

`packages/client/ui-model-selection/src/client/service.ts`：构造时（服务自己的 fiber 语境）捕获命名空间。

```ts
/**
 * Session wire face captured at construction. `ctx.remote.session` resolves
 * the generated namespace through the context that reads it, so reading it
 * inside {@link directoryFor} fails for a caller from another package; the
 * service's own context has the namespace injected.
 */
private readonly sessionRemote: ConstructorParameters<typeof ModelDirectory>[0]

constructor(ctx, config) {
  super(ctx, 'modelDirectories')
  this.sessionRemote = ctx.remote.session
  ...
}

directoryFor(sessionId) {
  ...
  const directory = new ModelDirectory(this.sessionRemote, ...)
}
```

验证：该规格 14/14 通过；oxlint 0 error；`pnpm run typecheck` 通过；`pnpm run test:gui` 4636 通过（另有 2 个 dev 既有红灯，stash 后同样失败，与本修复无关：`ui-theme` 的 CSS 边框 lint、`ui-model-selection` 的 removed-model 标签用例）。

## 教训

1. **`ctx.<svc>.<ns>` 的 `<ns>` 是按「读取方 ctx」解析的**。Service 方法里读嵌套命名空间，等于隐式依赖**调用方**的 inject；跨包调用必炸。要跨包安全：构造时捕获，或直接 `ctx.get('<svc>.<ns>')`。
2. **直接注入 ≠ 嵌套命名空间**。`this.ctx.sessions` 沿 shadow origin（服务自己的 fiber），`this.ctx.remote.session` 的第二跳沿调用方 ctx —— 两者语义不同，别都当“读依赖”。
3. **测试替身必须同构**。普通对象 double 测不出 Service 的 tracker 语义；命名空间在 root provide 也测不出真实拓扑。替身和装配的「形状」不对，绿灯是假的。
4. **上游合并后要复测 fork 的跨包路径**。上游自己的调用方都在包内，fork 的跨包调用是上游没覆盖的用法 —— 这类「合法但上游没走过」的路径是 merge 后最该补测试的地方。

## 附：相关位置

| 位置 | 作用 |
|---|---|
| `vendor/cordis/src/utils.ts:170-172` | 非 noShadow 服务剥掉 shadow |
| `vendor/cordis/src/utils.ts:180-181` | associate 分支：转成 ctx 属性读取 |
| `vendor/cordis/src/reflect.ts:144,155,163` | 沿 fiber 链找实现，找不到抛 `without inject` |
| `packages/api/gateway/src/client/index.ts:660` | `ctx.provide('remote.<ns>', face)` |
| `packages/client/ui-model-selection/src/client/service.ts:47,58,87` | 修复点（捕获 / 赋值 / 使用） |
| `packages/client/ui-conversation/src/client/apply.ts:319-323` | 跨包调用方 |
| `packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts` | 回归用例（ServiceRemote + 子 fiber + 外部调用方） |
| dev `2f45ac2059` | 修复提交 |

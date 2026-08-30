# Agent Note: REPL 运行时生命周期加固——显式唤醒的阻塞式订阅

Status: implemented

English | [中文](2026-08-30-repl-subscription-wake-lifecycle.md)

## Problem

TUI 的会话事件订阅循环可能空转或误报死亡。旧循环用轮询 `setTimeout` 混搭 `sub.next()`：运行时活跃时空转烧 CPU；且循环的身份检查（`sessionId`/`runtimeEpoch`）排在流死亡抛错之后——一次*计划内*的重启（本要关闭客户端再重订）会被报成「会话事件流已断开」，而不是安静地重订阅；`client.close()` 与通知之间的先后次序全凭运气。

第二个生命周期隐患：resume 选择器在 UI 路径上同步扫描整个会话存储；连续两次 `/resume` 可能让两场在途扫描竞速，渲染出过期的目录清单。

## Decision

订阅循环阻塞在 `Promise.race([sub.next(), wake])` 上。模块级 `wakeSubscription` resolver 是唯一的调度者：`notifySessionSwitch()` 解析它，内部等待返回 `undefined`，循环在*任何抛错之前*重查身份。只有真正死掉的流才会到达「会话事件流已断开（运行时可能已退出）」错误；计划内重启安静退出等待。

调用方拥有次序规则：`newSession()`/`resumeTo()` 先设 `sessionId`，`restartRuntime()` 先升 `runtimeEpoch`，*然后*才调 `notifySessionSwitch()`；`restartRuntime` 还在 `client.close()` 之前通知，让唤醒路径稳赢流死亡竞速。循环的 `finally` 清空 `wakeSubscription` 并关闭订阅，迟到的 `next()` rejection 不会活过循环。

resume 选择器（`showResumePicker`）异步化并由 `resumeScanSeq` 单调守卫保护：先设「扫描历史会话…」状态行，await `listSessions()`，只有最新序号的调用负责渲染。空存储渲染空列表加空闲提示；Escape 隐藏浮层并恢复空闲状态。调用点以 `void showResumePicker()` 触发。

## Alternatives considered

- 保留轮询定时器并把任何身份错位都当死亡。否决：空闲时定时器空转；把计划内重启折进死亡错误里，等于训练用户忽视这条报错。
- 每次切换都重建订阅（急切 close + 重订）。否决：`subscribeSessionTree` 每条运行时连接只注册一次；唤醒设计复用存活订阅、只重读其事件，切换零线上往返。
- 用布尔 busy 标志串行化 resume 扫描。否决：标志无法告诉旧扫描「新扫描已接管」；单调序列让过期判定只需一次比较。

## Consequences

- 空闲 TUI 成本降为一个挂起 promise；重启与会话切换共用一条安静路径，流死亡错误重获本义（仅限真实运行时死亡）。
- 次序规则（先变身份 → 再通知 → 后关闭）是承重墙并记录于此；未来调用方若先关闭，就会重新引入它本要阻止的竞速。
- `wakeSubscription` 为模块级：每个 REPL 进程至多一条订阅循环。
- resume 扫描无法交错；状态行加序列守卫让大存储下选择器行为可观察、可确定。

## Related

选择器等待的异步扫描由[会话存储读取层 note](../architecture/2026-08-30-repl-session-store-reader.zh.md)所有。

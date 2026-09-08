# Agent Note：JSONL 会话所有权的 append 围栏

Status: implemented

[English](2026-09-05-jsonl-append-fence.md) | 中文

## Problem

JSONL 后端的跨进程所有权锁只守住了获取：backend map 里已有的 claim 让后续每次 `ensureOwnership` 直接短路返回，`appendLines` 则盲写 EOF、不关心文件实际内容。当第二个进程在第一个 writer 的两次 append 之间接管了锁 —— 生产现场即微信桥 runtime 被打断的回合在 web runtime 已 resume 该会话并写入启动事件之后，又迟来补写了一条工具结果 —— 被夺权的 writer 把自己带过期 seq 的事件排到了后继者后面，产生 seq gap，直到下次加载才以 `corrupt session log: seq gap in committed region` 爆出。锁对"活 owner 在场时的获取"是正确的，但对"claim 事后被夺走"的 writer 没有任何围栏。

## Decision

backend 在**每次**持久 append 前校验两条不变量，而不仅在获取时：

- **锁完好**：`.lock` 文件仍然精确记录本进程的 claim（pid、hostname、startedAt —— `verifySessionOwnership`）。被替换或消失的锁意味着后继者（或运维）介入过。
- **尾部未动**：日志文件恰好结束在本 backend 上次写入或观察到的字节（获取时播种，`materialize`/`appendLines`/`repair` 推进）。锁完好之下的外来字节是锁本身看不见的并发 writer。

任一漂移都会把该会话在本进程生命周期内围栏：触发的那次 append 以 `fenced session "<id>" (…)` 失败，之后每次持久写立即拒绝 —— 内存里的 seq cursor 已不可信，唯一出路是全新进程重读日志（被围栏后重开的会话正常 resume 并继续写入）。锁已丢失的被围栏 writer 丢弃 claim，保证 teardown 不会释放后继者的锁；claim 完好的被围栏 writer 保留它，让 `close()` 仍然为下一个 writer 解锁。被围栏会话的读取与列举不受影响 —— 被夺权的进程降级为只读，与所有权契约的读路径一致。

## Alternatives considered

**只在获取时校验所有权（改动前的状态）。** 否决：现场损坏恰恰来自获取**之后**被夺走的 claim，获取时的检查看不见它。

**每次 append 前重新获取锁。** 否决：这不能围栏失败方——writer 要么与后继者争锁，要么在已不可信的 claim 下继续写；失败必须停止写入，而不是重新争夺所有权。

**依赖操作系统咨询锁（`flock`/`fcntl`）。** 否决：锁语义跨平台与文件系统（NFS、Windows）不一致，而后端本来就持有一份携带 pid、hostname、startedAt 的可移植 claim 文件；append 围栏校验的是后端自己维护的数据。

**只在加载时检测 seq gap。** 否决：那是在损坏已经持久化之后才报告，且指向的是下一个加载者而非肇事的 writer；围栏让即将漂移的那次 append 直接失败。

**由后继者带外通知被夺权的 writer。** 否决：这需要一个 JSONL 后端没有、也无法在任意进程之间假定的 IPC 通道；锁与尾部的检查无需协调即可发现同一条件。

## Consequences

- 被夺权的 writer 在漂移的那次 append 处以具名的 `fenced session` 错误停止，而不是把过期 seq 持久化地交错进去；下次加载不再看到 committed 区域的 gap。
- 被围栏的会话在该进程生命周期内降级为只读；恢复途径是全新进程重读日志，它会正常 resume 并继续写入。
- 每次持久 append 都要读锁并校验尾部位置，写路径增加少量文件系统开销。
- 丢失锁的 writer 丢弃 claim，保证 teardown 不会释放后继者的锁；claim 完好的 writer 保留它，`close()` 仍然为下一个 writer 解锁。
- 围栏是进程级且进程内不可逆：后端无法再证明内存中的 seq cursor 可信，因此永不自行解除围栏。

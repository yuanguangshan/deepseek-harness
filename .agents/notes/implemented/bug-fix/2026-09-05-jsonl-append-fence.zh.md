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

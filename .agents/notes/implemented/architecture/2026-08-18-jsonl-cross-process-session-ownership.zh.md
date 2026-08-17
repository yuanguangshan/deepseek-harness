# Agent Note: JSONL 后端的跨进程会话所有权锁

Status: implemented

[English](2026-08-18-jsonl-cross-process-session-ownership.md) | 中文

## 问题

JSONL 后端的写入路径假设每会话只有一个存活 writer：seq 游标与按 id 的串行化链都在持有进程内（`PersistenceCoordinator`）。预发布 README 把这记录为限制（"其他后端实例或进程不得写入同一会话"），但没有强制执行。

真实部署中有两个前端共享一个会话根：`dsh web`（自己的 host 进程）和 `dsh-repl --web-sessions`（spawn 自己的 runtime 子进程）。当两者恢复同一会话时，每个进程都从自己的内存游标继续 seq，在一个仅追加的文件里交错写入批次。结果是 seq 重复与断裂——日志在 load 时无法通过 `events[i].seq === i` 校验，甚至会让整个 `dsh web` 启动失败（`corrupt Zstandard session log`）。外部 workaround（CoW 副本+退出合并的协调脚本、给已安装 `dsh` 注入的 `shlock` 补丁）使情况更糟：合并用朴素 magic 扫描切帧并整文件非原子重写，补丁只覆盖两个写者之一。

## 决策

JSONL 后端现在为每个会话持有显式的跨进程写所有权锁：

- **锁文件**：会话自己目录内的 `.lock`，O_EXCL 创建，内容 `{ pid, hostname, startedAt }`。会话目录保留给会话自有产物，发现只读固定的 transcript 文件名，因此锁对列表/加载不可见。
- **获取点**：`appendBatch` 与 `commitRepair`（后端仅有的两个变更钩子）在该 id 的第一次持久写入前获取。获取按进程幂等（同 pid 重取自己的记录）。
- **释放**：后端的 `close()` 钩子——coordinator 的 dispose effect 在静止排空*之后*等待它——释放所有持有的锁。崩溃的所有者会留下文件；接管规则处理它。
- **拒绝**：同主机存活所有者（`process.kill(pid, 0)`；EPERM 视为存活）显式失败：`session "id" is owned by another writer (held by live pid N); stop that writer or resume after it exits`。消息点名 pid，用户能找到进程。
- **陈旧接管**：同主机死 pid 在警告后被接管。其他 hostname 无法探测，在被那台机器移除前始终有效——显式失败好过静默破坏可能是 NFS 共享的根。
- **不可读锁**（崩溃时写了一半的载荷）：视为无名所有者；删除后重试。
- **读取永不阻塞**：`load`/`inspect`/`list`/`readFrom` 不获取任何锁。被其他进程持有的会话完全可读——只有写入拒绝。这保证 web 端浏览 TUI 持有的会话仍然工作。

锁按设计只属于 JSONL 后端：`PersistenceBackend` seam 保持无锁，SQLite 的写者排除来自它自己的数据库层，第三方后端保留自己的并发规则。同进程双挂载不变：coordinator 的进程内所有者规则已经覆盖该场景，锁的同 pid 幂等与此一致。

## 备选方案

- **在 coordinator（`dsh-session-persistence`）加锁**——否决：seam 会把存储侧锁布局强加给后端（SQLite 不需要；它有事务），锁文件的位置是 JSONL 磁盘布局决策。
- **建议性 `flock`**——否决：锁随进程消失（好），但无法事后检视（"谁持有？"），NFS 可移植性比带载荷的文件更差。
- **基于 socket/端口的所有权**——否决：比问题本身重；当前消费者是单机部署形态。
- **只显式失败、不接管**——否决：崩溃的所有者会把会话永久卡死直到手动删除；同主机接管是安全的（死 pid 不会再写）。

## 后果

新增一个模块（`src/ownership.ts`，打进 `lib/index.js`）、两个变更钩子中的获取、一个 `close()` 钩子，以及一个 process-bound 规格（`tests/ownership.spec.ts`），覆盖创建/幂等/存活拒绝（真实 spawn 的 sleeper pid）/死接管/外部主机/不可读载荷/EPERM，另通过 tsx 驱动的子进程（`tests/fixtures/second-writer.ts`）覆盖真实第二进程拒绝与 dispose 后交接。README 的限制条目现在描述机制而非裸警告。TUI/web 共享根工作流保留原有行为（共享根、等另一边退出后恢复），但失去了损坏模式。

# Agent Note: REPL 启动模型的解析顺序——上次使用、环境变量、用户设置

Status: implemented

English | [中文](2026-09-07-repl-startup-model-resolution.md)

## 问题

`dsh-repl` 的启动路由是硬编码的：`PROVIDER` 默认 `ccswitch`、`MODEL` 默认 `glm-5.3-flash`，只能被 `DSH_REPL_PROVIDER` / `DSH_REPL_MODEL` 覆盖。这个默认带来两个后果。一是 `/model` 切换只在当前进程有效——每次重启都回落到兜底值，用户真正选过的模型丢了。二是 REPL 完全无视 `<DSH_HOME>/settings.yaml` 里的 `agent-default-model`（`dsh web` 早已遵循的那一块），于是两个前端对"会话从哪个模型开始"给出了不同答案。

zhipu coding-plan 路由到期（glm 改走 `ccswitch`）把第二点变成了现实问题：路由可能在两次运行之间消失，因此任何被记住或被配置的模型在用之前都必须校验，否则启动会栽在一个路由表里已经不存在的模型上。

## 决策

`apps/repl/src/tui-repl.ts` 里的 `resolveStartupModel()` 按以下顺序选出启动用的 provider/model：

1. `~/.dsh/last-model.json` —— 由 `writeLastModel()` 在每次 `/model` 切换成功和启动时写入。只有当运行时路由表确实声明了该 provider+model 时才采纳。`DSH_REPL_LAST_MODEL_FILE` 可改文件位置；`DSH_REPL_NO_LAST_MODEL=1` 跳过本步。
2. `DSH_REPL_PROVIDER` / `DSH_REPL_MODEL` —— 成对读取：哪一侧没设，就取硬编码兜底值补上，因此半设的环境变量不可能拼出 provider/model 错配。
3. `<DSH_HOME>/settings.yaml` 的 `agent-default-model` —— 由 `apps/repl/src/core.ts` 的 `parseAgentDefaultModel()` 解析，同样只在路由表声明了该组合时采纳。`DSH_HOME` 可改目录；`<DSH_HOME>/settings.yaml` 与 `dsh web` 读的是同一个文件。
4. 硬编码兜底 `{ provider: 'ccswitch', model: 'glm-5.3-flash' }`。

路由表校验只读取一次配置并在各步间复用；配置或设置文件不可读时下沉到下一步，而不是让启动失败。损坏或字段不全的 `last-model.json` 视为没有历史。

`~/.dsh/last-model.json` 与 weclaw 的 `dsh-openai-server.mjs` 用的是同一份文件，因此从该渠道选的模型能带进 REPL，反之亦然。

## 测试

`tests/core.spec.ts` 固定住 `parseAgentDefaultModel` 的行为：解析格式正确的块；块缺失或只有一个字段时返回 undefined；空文本、无法解析的 YAML、非对象块、序列根节点，以及 `null`/`undefined` 输入都返回 undefined。

## 备选方案

- **把模型记在 REPL 自己的记忆目录**（`~/.dsh-repl/memory/…`）。否决：weclaw 的 `dsh-openai-server` 已经在用 `~/.dsh/last-model.json`；再建一份会让两个渠道分叉，而不是让它们一致。
- **不经路由校验就信任 `agent-default-model`。** 否决：zhipu coding-plan 路由就在一个原本有效的默认值底下过期了；不校验的记住值会把"路由被移除"变成"启动失败"。
- **允许半设的环境变量对穿过**（另一侧取记住值或配置值）。否决：把记住的 provider 和环境变量给的 model 混在一起，得到的是谁都没选过的组合；环境变量覆盖的两侧现在来自同一来源。
- **在 `tui-repl.ts` 里直接复用现有 YAML 加载路径。** 否决：`core.ts` 才是值得断言的纯模块，也是 REPL 解析逻辑唯一能被单元测试到的地方；解析函数放在那里并导出。

## 后果

`/model` 的选择能跨重启保留，REPL 与 `dsh web` 从同一个配置模型启动。被移除或改名的路由不会再弄挂启动——过期条目被跳过，解析继续往下走。想固定启动模型的用户可以设 `DSH_REPL_NO_LAST_MODEL=1`（再配环境变量或 settings），这是不想要记住值时的逃生口。

## 相关

REPL 自身的模型切换界面：[REPL 生产力命令套件 Note](2026-09-01-repl-productivity-command-suite.zh.md)。

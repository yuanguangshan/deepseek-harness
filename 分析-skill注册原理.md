# 你的 skill 功能：实现质量与注册原理

## 一、整体架构：三层分离（很干净）

你的 companion 功能分了三层，各司其职，非常符合 dsh 的 capability-seam 哲学：

- 第1层 纯逻辑库（无 dsh 依赖，可独立复用）
  - @deepseek-ai/dsh-memory → 五轨记忆存储（纯 markdown 文件）
  - @deepseek-ai/dsh-usage → 用量/余额查询

- 第2层 工具注册（Consumer，模型真正能调用的）
  - @deepseek-ai/dsh-tool-companion
    - 注册 memory 工具（add/entries/remove/clear）
    - 注册 usage_status 工具

- 第3层 Skill 定义（给模型的"使用说明书"）
  - .agents/skills/dsh-memory/SKILL.md
  - .agents/skills/dsh-usage/SKILL.md

这个分层的关键价值：第 1 层不依赖任何 dsh 运行时（MemoryStore 是纯 Node），第 2 层把库包成模型工具，第 3 层告诉模型"什么时候用、怎么用"。换任何前端都能复用同一个 store。

## 二、注册成 skill 的原理（完整链路）

### 1. Skill 本体 = 带 frontmatter 的 Markdown
SKILL.md 头部是 name + description（注册元数据），正文是完整指令。dsh 靠这个约定发现 skill。

### 2. 发现：dsh-skill-filesystem 扫描六类根目录
packages/skill/skill-filesystem/src/index.ts 里，每个项目会扫描这些根（有固定 rank 顺序）：
- 项目根/.dsh/skills (project-dsh)
- 项目根/.agents/skills (project-agents) ← 你的 skill 在这
- 自定义 customSkillDirs
- 用户级 user-dsh / user-agents
- bundled（$DSH_BUNDLED_SKILL_DIR）

它读 YAML frontmatter → 解析成 SkillDefinition → 注册进 ctx.skills。

### 3. 注册表：ctx.skills（分层注册表）
dsh-skill 提供 ctx.skills，形状是 host + per-scope 分层（跟工具注册表同一个模式）：全局层 + 每个 preset/agent scope 一层，合并后每个 agent 看到自己的目录。base bundle 的 skill-filesystem 行在 web-app 里被 disabled，preset 拥有本地发现——你的 skill 是通过 preset 的 skill-filesystem 行挂进来的。

### 4. 模型可见：dsh-tool-skill（Consumer）
模型不能直接读文件，所以 tool-skill 做了两件事：
- 把 skill 目录（name+description）以 <system-reminder> 形式注入会话，模型知道有哪些 skill 可用
- 提供 skill 工具，模型调用它加载某个 skill 的完整正文到上下文

会话开头那一大段 <system-reminder>（包括 dsh-memory、vision-tools 的说明），就是这么来的——注册不是模型自动会的，是注入目录 + 提供加载工具。

### 5. 真正执行：tool-companion 注册的工具
Skill 只是"说明书"；让模型能动手的是 apply() 里的 ctx.tools.register(defineTool(...))：

```
ctx.tools.register(defineTool({
  name: 'memory',
  parameters: { op: { enum: ['add','entries','remove','clear'] }, target: {...} },
  execute(args, exec) {
    const cwd = exec.agent?.session.header.cwd ?? process.cwd()
    return Promise.resolve({ text: runMemoryOp(config, args, cwd) })
  },
  ...
}))
```

注意 exec.agent?.session.header.cwd——它从会话日志的 header 取工作目录，所以 memory 的 project 轨能精确落到当前 workspace 的哈希目录。这正符合 dsh 的"模型可见 ⟺ 已记录"不变式：工具的输入输出都走 tool/call + tool/result 事件进日志，可回放。

## 三、实现质量评价

做得好的：
- 零框架依赖的库层：memory 用纯 Node fs + markdown \n§\n 分隔，人类可读、无数据库、无网络，可靠且可审计
- 五轨设计合理：全局记忆 / 用户画像 / 日记 / 项目 / 分支关键事实，projectHash（SHA-1 稳定哈希）+ [branch:main] 标签过滤，粒度刚好
- UI 呈现也做了：presentCall 返回 { card: 'generic', title: 'Memory', kind: 'other' }，GUI 里有卡片展示
- 测试齐全：tests/ 目录 + invariant.ts 符合仓库规矩
- 注入即上下文：renderMemorySnapshot() 生成快照块，可拼进 prompt 当 standing context

可以改进的（诚实说）：
- memory 工具同时承担了 skill 的功能：既然模型已经有 memory 工具，dsh-memory skill 的指令正文其实是"教模型怎么用这个工具"——两套描述（tool description + SKILL.md）需要保持同步，有漂移风险
- gitBranch shell 调用（execFileSync('git', ...)）：同步阻塞 + 依赖 git 环境，SKILL.md 自己也承认了
- usage 的 provider 发现是关键词匹配（baseURL 含 opencode.ai/deepseek.com），自定义网关不识别——你自己的 Known limitation
- 敏感信息边界：memory 内容直接写 ~/.dsh-repl/memory/ 明文，如果记了密钥类内容需要留意

## 四、一句话总结

实现的是 dsh 标准的"库 → 工具 → skill 说明书"三段式：memory/usage_status 是模型能直接调用的工具（tool-companion 注册），dsh-memory/dsh-usage 是告诉模型何时用、怎么用的 SKILL.md（skill-filesystem 扫描 + tool-skill 注入目录），两者通过 ctx.skills 分层注册表和 <system-reminder> 目录注入衔接，非常符合 dsh 的生态范式。实现质量在"可复用、可回放、可测试"三个维度上都站得住，主要风险是工具描述与 skill 正文的重复维护。

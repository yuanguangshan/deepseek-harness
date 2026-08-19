# DeepSeek Harness v0.1.0-rc.8 版本介绍

## 版本信息
- **版本号**: 0.1.0-rc.8
- **发布时间**: 2026-08-19 23:00:28 UTC
- **发布提交**: f1f7dc36fa

## 主要更新内容

### 1. SQLite持久化布局优化
**提交**: `93b4b98ef3 feat(session): optimize SQLite persistence layout`

- 优化了SQLite数据库的存储布局，提升了持久化性能
- 引入了物理块行压缩技术，减少了存储空间占用
- 新增了差分压缩算法，优化了事件存储效率
- 更新了相关的测试套件和文档

### 2. 推理内容返回修复
**提交**: `583894f7ae fix(llm-deepseek): pass reasoning content back on every reasoned turn`

- 修复了DeepSeek模型推理内容返回的问题
- 确保每个推理轮次都能正确返回推理内容
- 解决了网关重新编码对话时丢失上游思考签名的问题
- 增强了推理链的完整性和可追溯性

### 3. 代理团队重构
**提交**: `4dd1be1a1f refactor: rename experimental agent team directories`

- 重命名了实验性代理团队目录结构
- 更新了代理团队服务键名
- 为实验性包添加了前缀，提高了命名一致性

### 4. 品牌指南国际化
**提交**: `89b0f17f84 docs: split brand guidelines into bilingual pair`

- 将品牌指南文档拆分为中英文双语版本
- 改进了国际化支持，方便不同语言用户查阅
- 更新了相关的翻译文件和元数据

### 5. 客户端构建优化
**提交**: `319d9a7984 feat(client): compose deployment branding through slots`

- 通过插槽机制组合部署品牌信息
- 提升了构建配置的灵活性和可维护性
- 支持更复杂的部署场景定制

### 6. 构建环境注入
**提交**: `1943a532f6 feat(client): inject public build environment`

- 注入公共构建环境变量
- 简化了不同环境下的构建配置
- 提高了构建过程的可移植性

## 技术改进

### 性能优化
- SQLite持久化性能显著提升
- 存储空间占用减少
- 查询效率提高

### 稳定性增强
- 修复了推理内容丢失的问题
- 改进了错误处理和恢复机制
- 增强了系统健壮性

### 开发体验
- 文档更加完善，支持双语查阅
- 构建配置更加灵活
- 实验性功能组织更加清晰

## Muse模型测试结果

### 测试环境
- **API端点**: `https://opencode.ai/zen/go/v1`
- **认证方式**: OPENCODE_GO_API_KEY
- **测试工具**: `dsh-muse-verify.mjs` 验证脚本

### 测试结果
| 模型 | 测试结果 | 状态 |
|------|---------|------|
| `muse-spark-1.2` | ✅ PASS — clean stop (patch works) | 正常工作 |
| `muse-spark-1.2-contributor` | ✅ PASS — clean stop (patch works) | 正常工作 |

### 补丁状态
- **补丁位置**: `/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js`
- **补丁内容**: 当流已自然结束但缺`finish_reason`且已收集到正文时，按正常完成处理
- **补丁效果**: 解决了Muse模型流式响应缺少终止帧的问题

### 测试详情
```bash
# 测试muse-spark-1.2模型
node dsh-muse-verify.mjs
# 输出: [verify] RESULT: PASS — clean stop (patch works)

# 测试muse-spark-1.2-contributor模型
node dsh-muse-verify.mjs muse-spark-1.2-contributor
# 输出: [verify] RESULT: PASS — clean stop (patch works)
```

## 版本稳定性
- 当前版本为预发布版本，可能存在兼容性破坏性变更
- 建议在测试环境中验证后再用于生产环境
- 如有问题，请通过GitHub Discussions反馈

## 升级建议
1. 备份现有会话和配置数据
2. 更新到最新版本后重新应用相关补丁
3. 测试Muse模型功能确保正常工作
4. 验证SQLite持久化功能正常

## 相关资源
- **项目仓库**: https://github.com/deepseek-ai/deepseek-harness
- **文档网站**: https://docs.dsh.dev
- **社区支持**: GitHub Discussions
- **补丁说明**: Muse-Spark补丁说明.md
- **诊断报告**: muse_spark_diagnosis.md
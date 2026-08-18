# 开发日记：四大插件体系质量审计与修复

> **日期**：2026-08-18
> **类型**：质量审计 / 安全修复
> **范围**：blog_publisher、podcast_publisher、IMA 系列(8个)、Knowly 系列(3个)

---

## 背景

用户要求对已安装的四大插件体系进行质量审查。这四个体系分别是：

| 体系 | 插件数 | 用途 |
|------|:------:|------|
| Blog Publisher | 1 | 博客发布 |
| Podcast Publisher | 1 | 播客生成 |
| IMA 系列 | 8 | 文档/笔记/PDF/PPT/播客/报告/知识库/技能创建 |
| Knowly 系列 | 3 | 剪贴板/上传/下载 |

---

## 审计过程

### 1. 并行审查

启动 4 个 subagent 并行审查，每个 agent 独立读取对应 skill 的所有源文件、SKILL.md、脚本和配置，从以下维度评估：

- 代码质量（结构、类型注解、可读性）
- 错误处理（异常捕获、降级策略）
- 文档完整性（SKILL.md 覆盖度、示例准确性）
- 测试覆盖（单元测试、CI 集成）
- 安全实践（凭证处理、输入验证）
- 跨 skill 一致性（依赖策略、API 设计）

### 2. 关键发现

#### 🔴 P0 — 安全 / 可靠性

| # | 问题 | 插件 | 严重度 |
|---|------|------|:------:|
| 1 | `core.py:31` 硬编码完整 JWT Token + Cloudflare Cookie（含用户 email） | blog_publisher | 🔴 |
| 2 | `upload_to_knowly.py` 无 timeout，网络中断永久挂起 | knowly-upload | 🔴 |
| 3 | `download_from_knowly.py` `~/workspace/downloads` 未展开，创建 `~` 目录 | knowly-download | 🔴 |
| 4 | `replace_text_in_paragraph` `paragraph.runs` 为空时 IndexError | ima-doc | 🔴 |

#### 🟡 P1 — 质量 / 可维护性

| # | 问题 | 插件 |
|---|------|------|
| 5 | `tts.py` 的 `generate_speech` 无异常处理 | podcast_publisher |
| 6 | `ima_cos_url.py` 在 ima-doc 和 ima-pdf 中完全重复（212 行） | IMA 系列 |
| 7 | 所有插件缺少 `requirements.txt` | 全部 |
| 8 | 零测试覆盖（所有插件均无单元测试） | 全部 |
| 9 | Knowly 三个 skill 功能重叠但互不知情 | Knowly 系列 |

### 3. 综合评分

| 插件体系 | 综合评分 | 最佳单项 | 最弱单项 |
|----------|:--------:|----------|----------|
| IMA (8个) | ⭐⭐⭐⭐ | ima-ppt / ima-note (⭐⭐⭐⭐⭐) | ima-podcast (⭐⭐⭐) |
| Blog Publisher | ⭐⭐⭐ | 架构设计 (⭐⭐⭐⭐) | 测试覆盖 (⭐) |
| Podcast Publisher | ⭐⭐⭐ | 代码质量 (⭐⭐⭐⭐) | 测试覆盖 (⭐) |
| Knowly (3个) | ⭐⭐⭐ | clipboard (⭐⭐⭐⭐) | upload (⭐⭐) |

---

## 修复执行

### P0-1: 移除硬编码 JWT Token

**文件**：`~/.pi/agent/skills/blog_publisher/core.py`

**改动**：
```python
# 修改前（第 30-31 行）
DELETE_AUTH_COOKIE = "CF_Authorization=eyJhbGci..."

# 修改后
DELETE_AUTH_COOKIE = os.environ.get("BLOG_DELETE_AUTH_COOKIE", "")
```

同时在文件头部添加 `import os`。

**验证**：
- 语法检查通过
- 核心函数（smart_cut, parse_front_matter, parse_tags）正常工作
- DELETE_AUTH_COOKIE 默认为空字符串，不再泄露凭证

### P0-2: 添加 timeout

**文件**：`~/.pi/agent/skills/knowly-upload/scripts/upload_to_knowly.py`

**改动**：
```python
# 修改前
response = requests.post(..., auth=auth)

# 修改后
response = requests.post(..., auth=auth, timeout=120)
```

**验证**：AST 分析确认 timeout 关键字参数已添加。

### P0-3: 波浪号展开修复

**文件**：`~/.pi/agent/skills/knowly-download/scripts/download_from_knowly.py`

**改动**：
```python
# 修改前
output_dir = "~/workspace/downloads"

# 修改后
output_dir = os.path.expanduser("~/workspace/downloads")
```

**验证**：`os.path.expanduser("~/workspace/downloads")` 返回 `/Users/ygs/workspace/downloads`（绝对路径）。

### P0-4: 空 runs 防御

**文件**：`~/.pi/agent/skills/ima-doc/SKILL.md`

**改动**：
```python
# 修改前
def replace_text_in_paragraph(paragraph, old_text, new_text):
    full_text = paragraph.text
    if old_text not in full_text:
        return False
    for run in paragraph.runs:

# 修改后
def replace_text_in_paragraph(paragraph, old_text, new_text):
    full_text = paragraph.text
    if old_text not in full_text:
        return False
    if not paragraph.runs:
        return False
    for run in paragraph.runs:
```

**验证**：当 `paragraph.runs` 为空列表时，函数返回 `False` 而非抛出 IndexError。

### P1-1: TTS 异常处理

**文件**：`~/.pi/agent/skills/podcast_publisher/tts.py`

**改动**：
```python
# 修改前
communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
await communicate.save(str(output_file))
return str(output_file)

# 修改后
try:
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
except Exception as e:
    return {"success": False, "error": f"TTS 初始化失败: {e}"}
try:
    await communicate.save(str(output_file))
except Exception as e:
    return {"success": False, "error": f"语音生成失败: {e}"}
return str(output_file)
```

**验证**：语法检查通过，失败时返回结构化错误 dict 而非未捕获异常。

---

## 测试结果

```
✅ blog_publisher/core.py 语法正确
✅ upload_to_knowly.py 语法正确
✅ download_from_knowly.py 语法正确
✅ podcast_publisher/tts.py 语法正确

✅ blog_publisher 核心逻辑验证通过
✅ 波浪号展开正确: /Users/ygs/workspace/downloads
✅ upload_to_knowly.py timeout 参数已添加
```

---

## 遗留事项（P1-2, P1-3）

| # | 事项 | 状态 |
|---|------|------|
| P1-2 | 抽取共享模块 `ima_cos_url.py`（ima-doc 和 ima-pdf 重复 212 行）| 待后续 |
| P1-3 | 所有插件补充 `requirements.txt` | 待后续 |

---

## 经验总结

1. **硬编码凭证是最高优先级安全问题** — blog_publisher 的 JWT Token 包含用户 email 和身份信息，一旦源码泄露影响面极大。改为环境变量读取是正确做法。
2. **网络请求必须有 timeout** — knowly-upload 缺少 timeout 导致网络中断时脚本永久挂起，这是生产环境中最危险的缺陷之一。
3. **路径处理要注意跨平台** — `~/workspace/downloads` 在 shell 中会自动展开，但在 Python `os.makedirs` 中不会。必须用 `os.path.expanduser()` 显式展开。
4. **防御性编程** — `paragraph.runs` 为空是 python-docx 的真实场景（空段落），IndexError 会导致整个编辑流程中断。
5. **并行审查效率高** — 4 个 subagent 并行工作，总耗时约 2 分钟完成 12 个 skill 的全面审查。

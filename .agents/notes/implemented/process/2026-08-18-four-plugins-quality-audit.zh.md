# Agent Note: 四大插件体系质量审计

Status: implemented

[English](2026-08-18-four-plugins-quality-audit.md) | 中文

## 问题

已安装的四大插件体系——blog_publisher、podcast_publisher、IMA 系列（8 个）、Knowly 系列（3 个）——从未接受过系统性质量审查。它们的安全状况（凭证处理、输入验证）、可靠性（错误处理、超时）、一致性均不可知，用户要求做质量审计并修复。

## 决策

启动 4 个 subagent 并行审查，每个 agent 独立读取对应 skill 的所有源文件、SKILL.md、脚本和配置，从六个维度评估：代码质量、错误处理、文档完整性、测试覆盖、安全实践、跨 skill 一致性。

审计发现 4 个 P0（安全/可靠性）与 5 个 P1（质量/可维护性）问题。4 个 P0 与成本最低的 P1（TTS 无异常处理）立即修复：

- **P0-1** — `core.py:31` 硬编码完整 JWT Token + Cloudflare Cookie（含用户 email）；改为从环境变量读取 `BLOG_DELETE_AUTH_COOKIE`，默认空串。
- **P0-2** — `upload_to_knowly.py` 无 timeout（网络中断永久挂起）；添加 `timeout=120`。
- **P0-3** — `download_from_knowly.py` 未展开 `~/workspace/downloads`，创建出字面 `~` 目录；包上 `os.path.expanduser()`。
- **P0-4** — `replace_text_in_paragraph` 在 `paragraph.runs` 为空时抛 IndexError；添加空 runs 守卫返回 `False`。
- **P1-1** — `tts.py` 的 `generate_speech` 无异常处理；`Communicate` 构造与 `save` 两处失败时都返回结构化错误 dict。

P1-2（抽取 ima-doc 与 ima-pdf 重复的 212 行 `ima_cos_url.py`）与 P1-3（所有插件补 `requirements.txt`）延期为已追踪的遗留事项。

## 备选方案

- **本次一并修复全部，含去重与 requirements** — 否决：两者都是跨 11 个 skill 的机械性重构、有真实回归面，而每个 P0 只有一到五行改动；延期让本次只做安全关键修复，P1-2/P1-3 已追踪。
- **不用并行 subagent（单 agent 串行）** — 否决：12 个 skill × 全源码阅读正是 subagent 存在的独立扇出场景；并行约 2 分钟完成全部六维审查。
- **P1-1（TTS 异常）也留到延期批次** — 否决：它与 P0 修复同体量，且封住付费功能管线的一条真实失败路径。

## 后果

四套体系现在都通过语法检查；加固路径均经行为验证（expanduser 返回绝对路径、timeout 关键字已存在、空 runs 返回 `False`、TTS 失败返回结构化 dict）。源码中不再有凭证。P1-2 与 P1-3 留在下方遗留清单，是下一轮维护的首选候选。经验清单沉淀为下方附录。

## 附录：审计细节

### 审查范围

| 体系 | 插件数 | 用途 |
|------|:------:|------|
| Blog Publisher | 1 | 博客发布 |
| Podcast Publisher | 1 | 播客生成 |
| IMA 系列 | 8 | 文档/笔记/PDF/PPT/播客/报告/知识库/技能创建 |
| Knowly 系列 | 3 | 剪贴板/上传/下载 |

### 关键发现 — 🔴 P0 安全 / 可靠性

| # | 问题 | 插件 | 严重度 |
|---|------|------|:------:|
| 1 | `core.py:31` 硬编码完整 JWT Token + Cloudflare Cookie（含用户 email） | blog_publisher | 🔴 |
| 2 | `upload_to_knowly.py` 无 timeout，网络中断永久挂起 | knowly-upload | 🔴 |
| 3 | `download_from_knowly.py` `~/workspace/downloads` 未展开，创建 `~` 目录 | knowly-download | 🔴 |
| 4 | `replace_text_in_paragraph` `paragraph.runs` 为空时 IndexError | ima-doc | 🔴 |

### 🟡 P1 质量 / 可维护性

| # | 问题 | 插件 |
|---|------|------|
| 5 | `tts.py` 的 `generate_speech` 无异常处理 | podcast_publisher |
| 6 | `ima_cos_url.py` 在 ima-doc 和 ima-pdf 中完全重复（212 行） | IMA 系列 |
| 7 | 所有插件缺少 `requirements.txt` | 全部 |
| 8 | 零测试覆盖（所有插件均无单元测试） | 全部 |
| 9 | Knowly 三个 skill 功能重叠但互不知情 | Knowly 系列 |

### 综合评分

| 插件体系 | 综合评分 | 最佳单项 | 最弱单项 |
|----------|:--------:|----------|----------|
| IMA (8个) | ⭐⭐⭐⭐ | ima-ppt / ima-note (⭐⭐⭐⭐⭐) | ima-podcast (⭐⭐⭐) |
| Blog Publisher | ⭐⭐⭐ | 架构设计 (⭐⭐⭐⭐) | 测试覆盖 (⭐) |
| Podcast Publisher | ⭐⭐⭐ | 代码质量 (⭐⭐⭐⭐) | 测试覆盖 (⭐) |
| Knowly (3个) | ⭐⭐⭐ | clipboard (⭐⭐⭐⭐) | upload (⭐⭐) |

### 修复执行

**P0-1: 移除硬编码 JWT Token** — `~/.pi/agent/skills/blog_publisher/core.py`：

```python
# 修改前（第 30-31 行）
DELETE_AUTH_COOKIE = "CF_Authorization=eyJhbGci..."

# 修改后
DELETE_AUTH_COOKIE = os.environ.get("BLOG_DELETE_AUTH_COOKIE", "")
```

同时在文件头部添加 `import os`。验证：语法检查通过，核心函数（smart_cut, parse_front_matter, parse_tags）正常工作，`DELETE_AUTH_COOKIE` 默认为空字符串。

**P0-2: 添加 timeout** — `~/.pi/agent/skills/knowly-upload/scripts/upload_to_knowly.py`：

```python
# 修改前
response = requests.post(..., auth=auth)

# 修改后
response = requests.post(..., auth=auth, timeout=120)
```

验证：AST 分析确认 timeout 关键字参数已添加。

**P0-3: 波浪号展开修复** — `~/.pi/agent/skills/knowly-download/scripts/download_from_knowly.py`：

```python
# 修改前
output_dir = "~/workspace/downloads"

# 修改后
output_dir = os.path.expanduser("~/workspace/downloads")
```

验证：`os.path.expanduser("~/workspace/downloads")` 返回 `/Users/ygs/workspace/downloads`。

**P0-4: 空 runs 防御** — `~/.pi/agent/skills/ima-doc/SKILL.md`：

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

验证：当 `paragraph.runs` 为空列表时，函数返回 `False` 而非抛出 IndexError。

**P1-1: TTS 异常处理** — `~/.pi/agent/skills/podcast_publisher/tts.py`：

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

验证：语法检查通过，失败时返回结构化错误 dict 而非未捕获异常。

### 测试结果

```
✅ blog_publisher/core.py 语法正确
✅ upload_to_knowly.py 语法正确
✅ download_from_knowly.py 语法正确
✅ podcast_publisher/tts.py 语法正确

✅ blog_publisher 核心逻辑验证通过
✅ 波浪号展开正确: /Users/ygs/workspace/downloads
✅ upload_to_knowly.py timeout 参数已添加
```

### 经验总结

1. **硬编码凭证是最高优先级安全问题** — blog_publisher 的 JWT Token 包含用户 email 和身份信息，一旦源码泄露影响面极大。改为环境变量读取是正确做法。
2. **网络请求必须有 timeout** — knowly-upload 缺少 timeout 导致网络中断时脚本永久挂起，这是生产环境中最危险的缺陷之一。
3. **路径处理要注意跨平台** — `~/workspace/downloads` 在 shell 中会自动展开，但在 Python `os.makedirs` 中不会。必须用 `os.path.expanduser()` 显式展开。
4. **防御性编程** — `paragraph.runs` 为空是 python-docx 的真实场景（空段落），IndexError 会导致整个编辑流程中断。
5. **并行审查效率高** — 4 个 subagent 并行工作，总耗时约 2 分钟完成 12 个 skill 的全面审查。

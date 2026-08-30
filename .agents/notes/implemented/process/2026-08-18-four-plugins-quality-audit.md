# Agent Note: Four-plugin-system quality audit

Status: implemented

English | [中文](2026-08-18-four-plugins-quality-audit.zh.md)

## Problem

The four installed plugin systems — blog_publisher, podcast_publisher, the IMA series (8 skills), and the Knowly series (3 skills) — had never received a systematic quality review. Nothing was known about their security posture (credential handling, input validation), reliability (error handling, timeouts), or consistency, and the user asked for a quality audit with fixes.

## Decision

Four subagents audited the systems in parallel, each reading all source files, SKILL.md, scripts, and configuration of its skills, scoring six dimensions: code quality, error handling, documentation completeness, test coverage, security practices, and cross-skill consistency.

The audit found 4 P0 (security/reliability) and 5 P1 (quality/maintainability) issues. All 4 P0s and the cheapest P1 (unhandled TTS exceptions) were fixed immediately:

- **P0-1** — `core.py:31` hardcoded a full JWT token + Cloudflare cookie (user email included); now reads `BLOG_DELETE_AUTH_COOKIE` from the environment, defaulting to empty.
- **P0-2** — `upload_to_knowly.py` had no timeout (permanent hang on network loss); added `timeout=120`.
- **P0-3** — `download_from_knowly.py` never expanded `~/workspace/downloads`, creating a literal `~` directory; wrapped in `os.path.expanduser()`.
- **P0-4** — `replace_text_in_paragraph` raised IndexError on an empty `paragraph.runs`; added an empty-runs guard returning `False`.
- **P1-1** — `tts.py` `generate_speech` ran without exception handling; both the `Communicate` construction and `save` now return a structured error dict on failure.

P1-2 (deduplicate the 212-line `ima_cos_url.py` shared by ima-doc and ima-pdf) and P1-3 (add `requirements.txt` to every plugin) were deferred as tracked remaining items.

## Alternatives considered

- **Fix everything in this pass, including the dedup and the requirements files** — rejected: both are mechanical refactors across 11 skills with real regression surface, while every P0 was a one-to-five-line change; deferring keeps this change security-critical-only, with P1-2/P1-3 tracked.
- **Audit without parallel subagents (one agent, sequential)** — rejected: 12 skills × full-source reading is exactly the independent fan-out subagents exist for; the parallel run finished all six-dimension reviews in about 2 minutes.
- **Leave P1-1 (TTS exceptions) for the deferred batch** — rejected: it is the same size as the P0 fixes and closes a real failure path of a paid-feature pipeline.

## Consequences

All four plugin systems now pass syntax checks; the hardened paths were verified behaviorally (expanduser returns the absolute path, the timeout keyword is present, empty runs return `False`, TTS failures return structured dicts). No credentials remain in source. P1-2 and P1-3 stay on the remaining-items list below and are the first candidates for the next maintenance pass. The lessons list fed the following appendix.

## Appendix: audit detail

### Systems in scope

| System | Plugins | Purpose |
|------|:------:|------|
| Blog Publisher | 1 | blog publishing |
| Podcast Publisher | 1 | podcast generation |
| IMA series | 8 | documents/notes/PDF/PPT/podcast/reports/knowledge base/skill creation |
| Knowly series | 3 | clipboard/upload/download |

### Critical findings — 🔴 P0 security / reliability

| # | Issue | Plugin | Severity |
|---|------|------|:------:|
| 1 | `core.py:31` hardcoded full JWT token + Cloudflare cookie (user email included) | blog_publisher | 🔴 |
| 2 | `upload_to_knowly.py` no timeout — permanent hang on network loss | knowly-upload | 🔴 |
| 3 | `download_from_knowly.py` `~/workspace/downloads` never expanded, created a `~` directory | knowly-download | 🔴 |
| 4 | `replace_text_in_paragraph` IndexError when `paragraph.runs` is empty | ima-doc | 🔴 |

### 🟡 P1 quality / maintainability

| # | Issue | Plugin |
|---|------|------|
| 5 | `tts.py` `generate_speech` has no exception handling | podcast_publisher |
| 6 | `ima_cos_url.py` fully duplicated across ima-doc and ima-pdf (212 lines) | IMA series |
| 7 | No `requirements.txt` anywhere | all |
| 8 | Zero test coverage (no unit tests in any plugin) | all |
| 9 | The three Knowly skills overlap functionally without knowing about each other | Knowly series |

### Overall scores

| System | Overall | Strongest | Weakest |
|----------|:--------:|----------|----------|
| IMA (8) | ⭐⭐⭐⭐ | ima-ppt / ima-note (⭐⭐⭐⭐⭐) | ima-podcast (⭐⭐⭐) |
| Blog Publisher | ⭐⭐⭐ | architecture design (⭐⭐⭐⭐) | test coverage (⭐) |
| Podcast Publisher | ⭐⭐⭐ | code quality (⭐⭐⭐⭐) | test coverage (⭐) |
| Knowly (3) | ⭐⭐⭐ | clipboard (⭐⭐⭐⭐) | upload (⭐⭐) |

### Fixes applied

**P0-1: remove the hardcoded JWT token** — `~/.pi/agent/skills/blog_publisher/core.py`:

```python
# 修改前（第 30-31 行）
DELETE_AUTH_COOKIE = "CF_Authorization=eyJhbGci..."

# 修改后
DELETE_AUTH_COOKIE = os.environ.get("BLOG_DELETE_AUTH_COOKIE", "")
```

`import os` added at the top of the file. Verified: syntax check passes, core functions (smart_cut, parse_front_matter, parse_tags) work, and `DELETE_AUTH_COOKIE` defaults to an empty string.

**P0-2: add a timeout** — `~/.pi/agent/skills/knowly-upload/scripts/upload_to_knowly.py`:

```python
# 修改前
response = requests.post(..., auth=auth)

# 修改后
response = requests.post(..., auth=auth, timeout=120)
```

Verified: AST analysis confirms the timeout keyword argument.

**P0-3: tilde expansion** — `~/.pi/agent/skills/knowly-download/scripts/download_from_knowly.py`:

```python
# 修改前
output_dir = "~/workspace/downloads"

# 修改后
output_dir = os.path.expanduser("~/workspace/downloads")
```

Verified: `os.path.expanduser("~/workspace/downloads")` returns `/Users/ygs/workspace/downloads`.

**P0-4: empty-runs guard** — `~/.pi/agent/skills/ima-doc/SKILL.md`:

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

Verified: with an empty `paragraph.runs` the function returns `False` instead of raising IndexError.

**P1-1: TTS exception handling** — `~/.pi/agent/skills/podcast_publisher/tts.py`:

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

Verified: syntax check passes; failures return a structured error dict instead of an uncaught exception.

### Test results

```
✅ blog_publisher/core.py 语法正确
✅ upload_to_knowly.py 语法正确
✅ download_from_knowly.py 语法正确
✅ podcast_publisher/tts.py 语法正确

✅ blog_publisher 核心逻辑验证通过
✅ 波浪号展开正确: /Users/ygs/workspace/downloads
✅ upload_to_knowly.py timeout 参数已添加
```

### Lessons

1. **Hardcoded credentials are the highest-priority security issue** — the blog_publisher JWT carried the user's email and identity; a source leak would expose it wholesale. Reading from an environment variable is the correct shape.
2. **Network requests need timeouts** — the missing timeout in knowly-upload hangs the script forever on network loss, one of the most dangerous production defects.
3. **Path handling must be cross-platform-aware** — the shell expands `~/workspace/downloads`; Python's `os.makedirs` does not. Expand explicitly with `os.path.expanduser()`.
4. **Defensive programming** — an empty `paragraph.runs` is a real python-docx scenario (empty paragraphs); the IndexError would abort the whole editing flow.
5. **Parallel review is efficient** — 4 subagents reviewed 12 skills across all six dimensions in about 2 minutes total.

# Agent Note: Publishing channels preference

Status: implemented

English | [中文](2026-08-18-publishing-channels-preference.zh.md)

## Problem

Content publishing happens through several channels (blog, IMA notes, Knowly, WeChat), each reachable either through a heavyweight skill or a plain API call. Without a recorded preference, each session re-derives the choice, sometimes landing on the slower skill path.

## Decision

The user prefers the simple `api.yuangs.cc` / `upload.want.biz` API endpoints as the first-choice publishing channel, with the corresponding skills as fallback for advanced operations (delete, batch).

| Channel | First choice | Fallback |
|------|----------|----------|
| 📝 Blog | `POST https://api.yuangs.cc/api/publish` | blog_publisher skill |
| 📄 IMA notes | `POST https://api.yuangs.cc/api/ima/import` | ima-knowledge skill |
| 📚 Knowly | `POST https://upload.want.biz/api/upload` | knowly-upload skill |
| 📱 WeChat | `POST api.yuangs.cc/weixinpush` | machine-u weclaw |

### Quick-publish templates

#### Blog

```python
import json, urllib.request

payload = json.dumps({
    'title': '文章标题',
    'content': '纯文本内容',
    'content_md': 'Markdown 内容',
    'tags': '标签1,标签2',
    'targets': ['blog']
}).encode('utf-8')

req = urllib.request.Request(
    'https://api.yuangs.cc/api/publish',
    data=payload,
    headers={'Content-Type': 'application/json'},
    method='POST'
)
resp = urllib.request.urlopen(req, timeout=30)
result = json.loads(resp.read().decode())
# result['blog']['redirect_url'] 即文章链接
```

#### IMA notes

```python
import json, urllib.request

payload = json.dumps({
    'title': '笔记标题',
    'content': 'Markdown 内容',
    'content_format': 1,
    'tags': '标签1,标签2'
}).encode('utf-8')

req = urllib.request.Request(
    'https://api.yuangs.cc/api/ima/import',
    data=payload,
    headers={'Content-Type': 'application/json'},
    method='POST'
)
resp = urllib.request.urlopen(req, timeout=30)
result = json.loads(resp.read().decode())
# result['url'] 即笔记链接
```

#### Knowly

```bash
curl -X POST https://upload.want.biz/api/upload -F "file=@文件路径"
```

#### WeChat

```bash
python3 ~/.pi/agent/skills/wechat-send/scripts/send.py "消息内容" --text-only
```

### Rationale

| Dimension | Simple API | Complex skill |
|------|----------|------------|
| Dependencies | none (standard library) | skill loading required |
| Authentication | none | some require it |
| Code volume | 10 lines | 50+ lines |
| Error handling | basic | complete |
| Feature completeness | core features | full features (delete, batch, etc.) |

**Principle**: use the simple API for everyday publishing; reach for the skill only when advanced operations (delete, batch) are needed.

## Alternatives considered

- Always use the full skill for every channel: rejected — it adds a loading step and 50+ lines of indirection for routine single-shot publishes.
- Always use raw HTTP and drop the skills: rejected — delete, batch, and other administrative operations exist only in the skills.

## Consequences

- Every publishing session starts from the API-first table above instead of re-deriving the channel choice.
- The skills remain installed as the fallback path for operations the simple APIs do not cover.
- If an endpoint moves or gains authentication, this note and its templates are the first thing to update.

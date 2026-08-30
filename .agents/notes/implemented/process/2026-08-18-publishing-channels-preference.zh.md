# Agent Note: 内容分发渠道优先级

Status: implemented

[English](2026-08-18-publishing-channels-preference.md) | 中文

## 问题

内容发布涉及多个渠道（博客、IMA 笔记、Knowly、微信），每个渠道既可以通过重量级 skill 触达，也可以通过普通 API 调用完成。若不记录偏好，每次会话都要重新推导渠道选择，有时会落到更慢的 skill 路径上。

## 决策

用户偏好使用 `api.yuangs.cc` / `upload.want.biz` 的简单 API 端点作为首选发布渠道，对应 skill 作为高级操作（删除、批量）的备用。

| 渠道 | 首选方式 | 备用方式 |
|------|----------|----------|
| 📝 博客 | `POST https://api.yuangs.cc/api/publish` | blog_publisher skill |
| 📄 IMA 笔记 | `POST https://api.yuangs.cc/api/ima/import` | ima-knowledge skill |
| 📚 Knowly | `POST https://upload.want.biz/api/upload` | knowly-upload skill |
| 📱 微信 | `POST api.yuangs.cc/weixinpush` | u 机 weclaw |

### 快速发布模板

#### 博客

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

#### IMA 笔记

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

#### 微信

```bash
python3 ~/.pi/agent/skills/wechat-send/scripts/send.py "消息内容" --text-only
```

### 选择依据

| 维度 | 简单 API | 复杂 Skill |
|------|----------|------------|
| 依赖 | 无（标准库） | 需要 skill 加载 |
| 认证 | 无 | 部分需要 |
| 代码量 | 10 行 | 50+ 行 |
| 错误处理 | 基础 | 完善 |
| 功能完整度 | 核心功能 | 全功能（删除、批量等）|

**原则**：日常发布用简单 API，需要高级功能（如删除、批量操作）时再用 skill。

## 备选方案

- 所有渠道一律使用完整 skill：否决——常规一次性发布要多付一次 skill 加载和 50+ 行间接层。
- 一律使用裸 HTTP 并弃用 skill：否决——删除、批量等管理操作只存在于 skill 中。

## 后果

- 每次发布会话都从上面的 API 优先表格出发，而不是重新推导渠道选择。
- skill 保留安装，作为简单 API 未覆盖操作的备用路径。
- 若某个端点迁移或增加认证，本 note 与其中的模板是第一个要更新的地方。

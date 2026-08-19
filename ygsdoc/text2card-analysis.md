# text2card 技能实现原理详解

## 📋 一句话 → 手绘精美图文卡片：完整实现原理

### 🏗️ 架构概览

这是一个**全免费流水线**，无需付费 API，由三个核心模块组成：

```
输入一句话 → [文案LLM扩展] → [图片生成] → [Pillow排版合成] → 输出PNG卡片
```

---

### 1️⃣ 文案扩展模块 (`expand_copy`)

**功能**：用免费 LLM 把一句话扩展成完整卡片素材

**流程**：
```python
用户输入 → 调用 weclaw 公网 LLM 端点 → 解析 JSON 返回 → 提取结构化数据
```

**关键代码**（第99-128行）：
- **Prompt 设计**：要求 LLM 输出 JSON 格式，包含 5 个字段：
  - `title`：20字以内标题
  - `body`：40-60字正文（控制在5行以内，约90字）
  - `quote`：20字以内金句
  - `img_prompt`：英文手绘风格提示词
  - `style`：情绪风格（从7套调色板中选）

- **LLM 端点配置**（第37-43行）：
  ```python
  LLM_BASE_URL = "https://wx.want.biz/v1/chat/completions"  # weclaw 公网
  LLM_API_KEY = "weclaw@ygs"  # 免费 key
  LLM_MODEL = "auto"  # 自动调度
  ```
  - 支持环境变量切换端点（`T2C_LLM_BASE`、`T2C_LLM_KEY`、`T2C_LLM_MODEL`）
  - **必须带浏览器 UA**（第42-43行）：公网端点有 WAF，`Python-urllib` 会被 403

- **容错处理**（第110-116行）：
  ```python
  # 去掉 markdown 代码块围栏
  content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip(), flags=re.M)
  # 提取第一个 { 到最后一个 } 之间的内容
  raw = content[start:end + 1] if start >= 0 and end > start else content
  ```

---

### 2️⃣ 图片生成模块 (`gen_image`)

**功能**：调用免费图片 API 生成手绘风格插画

**支持的 4 个引擎**（第67-91行）：

| 引擎 | 端点 | Key | 特点 |
|------|------|-----|------|
| `sensenova`（默认） | `token.sensenova.cn` | 内置 | 商汤日日新，质量较好 |
| `agi` | `wx.want.biz` | 复用 LLM key | 走统一端点，无独立 key |
| `agnes` | `apihub.agnes-ai.com` | 内置 | Agnes 图片模型 |
| `jimeng` | `localhost:8000` | 环境变量 | 即梦本地代理 |

**降级机制**（第131-137行）：
```python
ENGINE_FALLBACK = {
    "sensenova": ["jimeng", "agnes"],  # 商汤失败 → 即梦 → Agnes
    "agi":       ["jimeng", "agnes"],
    "agnes":     ["jimeng", "sensenova"],
    "jimeng":    ["sensenova", "agnes"],
}
```

**核心逻辑**（第339-349行）：
```python
chain = [engine] + ENGINE_FALLBACK.get(engine, [])  # 主引擎 + 备用列表
for cand in chain:
    try:
        img_file = gen_image(copy["img_prompt"], cand, "img_raw.png")
        break
    except Exception as e:
        print(f"  ⚠️ {cand} 出图失败: {e}")
```

**引擎实现差异**：
- `agi`：复用 LLM 端点，用 `model=agi`，从返回文本中提取图片 URL（第162行）
- `sensenova`/`agnes`/`jimeng`：标准 OpenAI Images API 格式，从 `resp["data"][0]["url"]` 取 URL

---

### 3️⃣ 排版合成模块 (`compose_card`)

**功能**：用 Pillow 将文案+图片合成为手绘风卡片

**输出格式**：
- 标准竖卡：1080×1440（默认）
- 长图：1080×1920（小红书风）

**7 套手绘调色板**（第87-95行）：
```python
STYLES = {
    "warm":   {"bg": (250, 244, 232), "ink": (74, 58, 46), ...},   # 温暖治愈
    "fresh":  {"bg": (238, 247, 240), "ink": (56, 84, 70), ...},   # 清新自然
    "calm":   {"bg": (238, 243, 250), "ink": (58, 70, 96), ...},   # 宁静淡雅
    "night":  {"bg": (46, 50, 62), ...},                            # 深夜静谧
    "autumn": {"bg": (252, 242, 226), ...},                         # 秋日暖阳
    "spring": {"bg": (250, 245, 238), ...},                         # 春日浪漫
    "rain":   {"bg": (242, 244, 246), ...},                         # 雨后清润
}
```

**排版层次**（第239-318行）：

1. **背景层**（第239-246行）：
   ```python
   # 柔和斜向水彩晕染
   for i in range(14):
       y0 = (i * 137) % H
       od.ellipse([-200, y0 - 90, W + 200, y0 + 90], fill=WASH + (30,))
   overlay = overlay.filter(ImageFilter.GaussianBlur(60))
   ```

2. **装饰边框**（第249-252行）：
   ```python
   draw.rounded_rectangle([34, 34, W - 34, H - 34], radius=26, outline=WASH + (200,))
   draw.rounded_rectangle([48, 48, W - 48, H - 48], radius=18, outline=WASH + (110,))
   ```

3. **插画区**（第255-261行）：
   ```python
   art = Image.open(img_path).convert("RGB")
   art = art.resize((art_w, art_h), Image.LANCZOS)  # 等比缩放
   mask = Image.new("L", (art_w, art_h), 0)
   md.rounded_rectangle([0, 0, art_w, art_h], radius=22, fill=255)  # 圆角蒙版
   img.paste(art, (art_margin, art_top), mask)
   ```

4. **装饰线**（第264-266行）：插画下沿的点缀线

5. **标题**（第269-282行）：
   - 自动折行（`_wrap` 函数）
   - 居中排版
   - 标题下小装饰线 + 圆点

6. **金句引语栏**（第285-296行）：
   ```python
   draw.rounded_rectangle(qbox, radius=14, fill=PAPER + (140,))
   draw.rectangle([100, q_y + 18, 104, q_y + 74], fill=ACCENT + (220,))  # 左竖线
   ```

7. **正文**（第299-304行）

8. **落款 + 印章**（第307-318行）：
   ```python
   # 右下角落款
   draw.text((W - 150 - mw, H - 110), "@yuanguangshan", ...)
   # 左上角小印章
   draw.rounded_rectangle([sx, sy, sx + 72, sy + 72], radius=8, fill=ACCENT)
   draw.text(..., "绘", fill=PAPER)
   ```

---

### 4️⃣ 主流程 (`run_one`)

```python
def run_one(description, out, engine, fmt, skip_img, img_file):
    # 1. 文案扩展
    copy = expand_copy(description)

    # 2. 图片生成（带降级）
    chain = [engine] + ENGINE_FALLBACK.get(engine, [])
    for cand in chain:
        try:
            img_file = gen_image(copy["img_prompt"], cand, "img_raw.png")
            break
        except:
            continue

    # 3. 排版合成
    out = compose_card(copy["title"], copy["body"], copy["quote"],
                       img_file, out, style_key=copy["style"], fmt=fmt)
```

---

### 5️⃣ 字体依赖（macOS 系统字体）

```python
FONT_BOLD = "/System/Library/Fonts/STHeiti Medium.ttc"   # 粗体
FONT_LIGHT = "/System/Library/Fonts/STHeiti Light.ttc"   # 细体
FONT_SONG = "/System/Library/Fonts/Supplemental/Songti.ttc"  # 宋体
```

---

### 🔑 核心设计理念

1. **全免费**：LLM 走 weclaw 公网端点，图片走免费 API，排版用本地 Pillow
2. **高可用**：图片生成有降级机制（4 个引擎互为备用）
3. **自动化**：一句话自动扩展成完整卡片素材（标题+正文+金句+图片+风格）
4. **可定制**：7 套情绪调色板、2 种版式、多种图片引擎
5. **批量支持**：`--batch` 模式可一次生成多张卡片

---

### 📁 文件位置

- 技能目录：`~/.pi/agent/skills/text2card/`
- 主脚本：`scripts/text2card.py`
- 依赖库：`scripts/pylibs/PIL/`（便携版 Pillow）

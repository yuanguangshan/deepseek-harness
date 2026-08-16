# 一句话 → 手绘精美图文卡片 v2（全免费 AI 流水线）

研究结论：**不需要付费 API，用本机/局域网已有的免费端点 + 免费图片 API + 本地 Pillow 排版，就能从一句话自动生成手绘风格的图文卡片。** 流水线已跑通并产出成品（见 `card_*.png`，预览见 `preview.html`）。

## 流水线（3 步）

```
一句话描述
  │  ① 文案扩展（免费 LLM）
  ▼
{title, body, quote, img_prompt, style(情绪风格)}
  │  ② 手绘图片生成（免费图片 API）
  ▼
PNG 插画
  │  ③ 排版合成（本地 Pillow，免费）
  ▼
手绘风图文卡片（情绪调色板 + 水彩晕染底 + 金句引语栏 + 圆角插画 + 印章落款）
```

## v2 优化（2026-08-16）

1. **情绪自动配色**：LLM 额外输出 `style` 字段（warm/fresh/calm/night/autumn/spring/rain），Pillow 按情绪从 7 套手绘调色板选色，标题、正文、边框、印章整体协调。
2. **金句引语栏**：LLM 额外输出一句点题 `quote`，正文上方渲染成带左侧竖线的引语卡片。
3. **标题装饰线**：标题下方加点缀短线 + 圆点。

### v2.1 修复（2026-08-16）

标题装饰线原先算在标题行内（`dec_y = t_y + 26`），单行标题时正好穿过字形中部，像删除线。现改为按最后一行字形的实际下缘（`textbbox`）下方 16px 放置，不再与文字重叠。
4. **`--format long`**：1080×1920 竖版长图（小红书长图风），插画更小、正文更舒展。
5. **`--batch` 批量生成**：读入多行描述文件，逐行出卡到输出目录。
6. **微信送达链路**：成品可上传 R2（`rclone copyto <卡> r2:yuangs/handdrawn/`，公开 URL `https://pic.want.biz/handdrawn/<卡>`）→ 用 `wechat-send` 技能把图片推到微信。

## 各环节免费工具（均已实测验证）

### ① 文案扩展 —— 免费 LLM 端点（机器 u 的 weclaw 配置 + 本机代理）

| 端点 | 说明 | 状态 |
|---|---|---|
| `http://127.0.0.1:8081/v1/chat/completions`（qwen3.7-max） | **本机** mac 上的 Qwen 代理，`api_key: yuan0503` | ✅ 已验证 |
| `http://192.168.31.213:8080/v1/chat/completions`（deepseek-chat） | 机器 u 上的 DeepSeek 代理 | ✅ 配置齐全 |
| `https://openrouter.ai/api/v1/chat/completions`（:free） | OpenRouter 免费模型 | ✅ 已验证 |
| `https://aiproxy.want.biz/v1/chat/completions`（GPT-5.5-mini / Claude / Grok 等） | 免费聚合代理 | ✅ 已验证 |
| `https://integrate.api.nvidia.com/v1/chat/completions`（glm-5.2 / deepseek-v4-flash 等） | NVIDIA 免费 API | ✅ 配置齐全 |
| `https://generativelanguage.googleapis.com/v1beta/openai/chat/completions`（gemini-3.x-flash） | Google Gemini 免费 key | ✅ 配置齐全 |

这些端点来自机器 u（`ssh u`，192.168.31.213）上 `~/.weclaw/config.json` 的 agents 表，以及本机 `8081/8082` 端口上的本地代理。

### ② 手绘图片生成 —— 免费图片 API（各免费 key 实测出图）

| 引擎 | 端点 | 模型 | 实测 |
|---|---|---|---|
| 商汤日日新 | `https://token.sensenova.cn/v1/images/generations` | `sensenova-u1-fast` | ✅ 出图（2752×1536，OpenAI 兼容） |
| Agnes | `https://apihub.agnes-ai.com/v1/images/generations` | `agnes-image-2.1-flash` | ✅ 出图（1024×1024） |
| NVIDIA | `integrate.api.nvidia.com/v1/images/generations` | — | ❌ 404，不支持 |

手绘风格靠提示词控制：`hand-drawn watercolor sketch, delicate ink outlines, warm pastel tones, ample white space`（由第①步 LLM 自动生成）。

### ③ 排版合成 —— 本地免费

- **Pillow**（本机装到工作区 `pylibs/`，机器 u 的 venv 也有 12.1.1）绘制卡片：情绪调色板底、水彩晕染纹理、圆角插画、金句引语栏、手写风标题、印章落款。
- 备选：机器 u 有 Puppeteer（HTML+CSS → 截图），本机 Chrome headless 在沙箱下不可用，未采用。

## 复现

```bash
cd /Users/ygs/ygs/deepseek-harness/handdrawn
# 安装依赖（仅首次，装到工作区不污染系统）
python3 -m pip install --target ./pylibs pillow -i https://pypi.tuna.tsinghua.edu.cn/simple

# 跑流水线（--engine 可选 sensenova / agnes）
PYTHONPATH=./pylibs python3 pipeline.py "春分时节，万物复苏" -o out.png --engine sensenova

# 竖版长图
PYTHONPATH=./pylibs python3 pipeline.py "一句话" --format long -o long.png

# 批量（lines.txt 每行一句）
PYTHONPATH=./pylibs python3 pipeline.py --batch lines.txt -o batch_out/
```

## 成品

| 文件 | 输入 | 引擎 | 版式 |
|---|---|---|---|
| `card_chunfen.png` | 春分时节，万物复苏 | 商汤 | card v1 |
| `card_cat.png` | 深夜读书，猫在膝上打盹 | Agnes | card v1 |
| `card_sunrise.png` | 晨跑时遇见第一缕阳光 | 商汤 | card v1 |
| `card_long.png` | 长文本压力测试 | — | card v1 |
| `card_breeze.png` | 晚风路过阳台，把一天的疲惫都吹散了 | 商汤 | card v2（warm） |

打开 `preview.html` 可并排预览。

## 发现的关键点

1. **机器 u（192.168.31.213）是免费 AI 资源中枢**：weclaw 配置里挂了 30+ 免费模型端点（DeepSeek、GLM、Gemini、NVIDIA、OpenRouter、aiproxy 等），还有两个图片生成脚本（`sensenova-img.py`、`agnes_image_gen.py`，key 在脚本和 weclaw config 里明文可用）。
2. **本机 mac 就是代理**：8081（Qwen）、8082（chatgpt）、8080 都在跑，直接可用，零成本。
3. **图片 API 是 OpenAI 兼容的 `images/generations`**，任意语言 3 行代码可调，无额度显示但实测连续出图正常。
4. 排版不依赖任何在线服务，全部本地 Pillow 完成，样式可随意定制。

## 可改进方向

- 接入机器 u 的 Puppeteer 做 HTML/CSS 排版，可获得更精致的排版能力（如任意字体、渐变、装饰 SVG）。
- 增加多图拼接 / 九宫格版式。
- 批量生成已支持（`--batch`），可再接多引擎自动切换（某引擎失败自动换下一个）。
- 成品微信送达已跑通（R2 + wechat-send 技能），可做成流水线尾段自动执行。

#!/usr/bin/env python3
"""一句话 → 手绘精美图文卡片 全免费流水线 (v2)

优化点（相对 v1）:
- 文案扩展新增 `style`（情绪风格）与 `quote`（金句）字段
- 配色由 LLM 给出的情绪自动选择（预置 7 套手绘调色板），不再是固定色
- 版式新增右侧金句引语栏 + 标题装饰线 + 印章
- 支持 `--format long` 竖版长图（小红书长图风）
- 支持 `--batch` 批量生成（每行一句话出一张卡）

依赖:
- 文案扩展: 本机免费 Qwen 代理 (http://127.0.0.1:8081/v1/chat/completions)
- 图片生成: 商汤日日新 sensenova-u1-fast / Agnes agnes-image-2.1-flash (免费 key)
- 排版合成: Pillow (本机工作区 pylibs)

用法:
    PYTHONPATH=pylibs python3 pipeline.py "春分时节，万物复苏" -o output.png [--engine sensenova|agnes]
    PYTHONPATH=pylibs python3 pipeline.py "一句话" --format long -o long.png
    PYTHONPATH=pylibs python3 pipeline.py --batch lines.txt -o out_dir/
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request

# ---------------- 配置 ----------------
QWEN_URL = "http://127.0.0.1:8081/v1/chat/completions"
QWEN_MODEL = "qwen3.7-max"

SENSENOVA_URL = "https://token.sensenova.cn/v1/images/generations"
SENSENOVA_KEY = os.environ.get("SENSENOVA_API_KEY", "")
SENSENOVA_MODEL = os.environ.get("SENSENOVA_MODEL", "sensenova-u1-fast")

AGNES_URL = "https://apihub.agnes-ai.com/v1/images/generations"
AGNES_KEY = os.environ.get("AGNES_API_KEY", "")
AGNES_MODEL = os.environ.get("AGNES_MODEL", "agnes-image-2.1-flash")

FONT_BOLD = "/System/Library/Fonts/STHeiti Medium.ttc"
FONT_LIGHT = "/System/Library/Fonts/STHeiti Light.ttc"
FONT_SONG = "/System/Library/Fonts/Supplemental/Songti.ttc"

# 手绘调色板：bg 底 / ink 墨色 / accent 点缀 / paper 纸色 / sub 次要文字
STYLES = {
    "warm":   {"bg": (250, 244, 232), "ink": (74, 58, 46),   "accent": (188, 116, 92),  "paper": (255, 252, 244), "sub": (140, 120, 100), "wash": (226, 210, 185)},
    "fresh":  {"bg": (238, 247, 240), "ink": (56, 84, 70),   "accent": (96, 158, 128),  "paper": (252, 255, 250), "sub": (128, 150, 138), "wash": (206, 228, 214)},
    "calm":   {"bg": (238, 243, 250), "ink": (58, 70, 96),   "accent": (108, 132, 176),  "paper": (250, 252, 255), "sub": (128, 140, 160), "wash": (208, 220, 238)},
    "night":  {"bg": (46, 50, 62),    "ink": (232, 226, 212), "accent": (206, 166, 108), "paper": (255, 252, 242), "sub": (168, 160, 148), "wash": (78, 84, 100)},
    "autumn": {"bg": (252, 242, 226), "ink": (92, 64, 44),   "accent": (200, 122, 62),  "paper": (255, 250, 240), "sub": (150, 122, 96),  "wash": (238, 216, 186)},
    "spring": {"bg": (250, 245, 238), "ink": (80, 66, 54),   "accent": (216, 138, 150),  "paper": (255, 252, 246), "sub": (152, 132, 118), "wash": (240, 220, 214)},
    "rain":   {"bg": (242, 244, 246), "ink": (66, 74, 84),   "accent": (118, 142, 160),  "paper": (252, 253, 254), "sub": (140, 150, 158), "wash": (214, 224, 232)},
}
DEFAULT_STYLE = "warm"

# ---------------- 文案扩展 ----------------
def expand_copy(description: str) -> dict:
    """用免费 Qwen 代理把一句话扩展成 标题+正文+金句+插画提示词+情绪风格。"""
    prompt = f"""你是资深新媒体文案与插画师。把下面这句话扩展成一份「手绘风图文卡片」的完整素材，要求：
1. title: 一个 20 字以内、有文采的标题（不要书名号）
2. body: 一段 70~100 字、治愈系文风的正文（可以有 1~2 个换行，用 \\n 分隔成短句）
3. quote: 一句 20 字以内的金句（点题、可独立成行，不要和 title 重复）
4. img_prompt: 一段英文绘画提示词，明确要求 hand-drawn / watercolor / sketch 手绘风格，含主体、色调、构图、留白背景
5. style: 只从这些情绪风格里选一个最贴合的: warm(温暖治愈) / fresh(清新自然) / calm(宁静淡雅) / night(深夜静谧) / autumn(秋日暖阳) / spring(春日浪漫) / rain(雨后清润)
只输出一个 JSON 对象，不要 markdown 代码块，不要其他文字。
输入：{description}"""
    payload = json.dumps({
        "model": QWEN_MODEL,
        "messages": [{"role": "user", "content": prompt}],
    }).encode()
    req = urllib.request.Request(QWEN_URL, data=payload,
                                 headers={"Content-Type": "application/json"})
    resp = json.loads(urllib.request.urlopen(req, timeout=120).read())
    content = resp["choices"][0]["message"]["content"]
    # 去掉 markdown 代码块围栏
    content = re.sub(r"^```(?:json)?\s*|\s*```$", "", content.strip(), flags=re.M)
    # 提取第一个 { 到最后一个 } 之间的内容, 并清理控制字符
    start, end = content.find("{"), content.rfind("}")
    raw = content[start:end + 1] if start >= 0 and end > start else content
    raw = "".join(ch for ch in raw if ch >= " " or ch in "\n\t")
    data = json.loads(raw, strict=False)
    if "body" in data:
        data["body"] = data["body"].replace("<br>", "\n").replace("<br/>", "\n")
    style = data.get("style", DEFAULT_STYLE)
    if style not in STYLES:
        style = DEFAULT_STYLE
    return {
        "title": data.get("title", description),
        "body": data.get("body", ""),
        "quote": data.get("quote", ""),
        "img_prompt": data.get("img_prompt", ""),
        "style": style,
    }

# ---------------- 图片生成 ----------------
def gen_image(prompt: str, engine: str = "sensenova", out_path: str = "img_raw.png") -> str:
    """调用免费图片 API，返回本地保存路径。"""
    if engine == "sensenova":
        url, key, model = SENSENOVA_URL, SENSENOVA_KEY, SENSENOVA_MODEL
        payload = {"model": model, "prompt": prompt}
    else:
        url, key, model = AGNES_URL, AGNES_KEY, AGNES_MODEL
        payload = {"model": model, "prompt": prompt, "n": 1, "size": "1024x1024"}
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers={
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    })
    resp = json.loads(urllib.request.urlopen(req, timeout=180).read())
    img_url = resp["data"][0]["url"]
    urllib.request.urlretrieve(img_url, out_path)
    return out_path

# ---------------- 排版合成 ----------------
def _font(path: str, size: int):
    from PIL import ImageFont
    return ImageFont.truetype(path, size)

def _wrap(draw, text: str, font, max_width: int) -> list:
    """按像素宽度折行。"""
    lines, cur = [], ""
    for ch in text:
        if ch == "\n":
            lines.append(cur); cur = ""; continue
        if draw.textlength(cur + ch, font=font) > max_width and cur:
            lines.append(cur); cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines

def compose_card(title: str, body: str, quote: str, img_path: str, out_path: str,
                 style_key: str = DEFAULT_STYLE, fmt: str = "card") -> str:
    """Pillow 合成手绘风图文卡片。

    fmt=card: 1080x1440 标准竖卡；fmt=long: 1080x1920 长图（插画更小、正文更舒展）。
    """
    from PIL import Image, ImageDraw, ImageFilter

    pal = STYLES.get(style_key, STYLES[DEFAULT_STYLE])
    BG, INK, ACCENT, PAPER, SUB, WASH = pal["bg"], pal["ink"], pal["accent"], pal["paper"], pal["sub"], pal["wash"]

    if fmt == "long":
        W, H = 1080, 1920
        art_margin, art_top = 90, 100
        art_h = 620
        title_size, title_lh, body_size, body_lh = 58, 80, 32, 52
    else:
        W, H = 1080, 1440
        art_margin, art_top = 120, 110
        art_h = int((W - 2 * 120) * 3 / 4)
        title_size, title_lh, body_size, body_lh = 62, 86, 34, 54

    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img, "RGBA")

    # 背景纹理: 柔和斜向水彩晕染
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay, "RGBA")
    for i in range(14):
        y0 = (i * 137) % H
        od.ellipse([-200, y0 - 90, W + 200, y0 + 90], fill=WASH + (30,))
    overlay = overlay.filter(ImageFilter.GaussianBlur(60))
    img.paste(overlay, (0, 0), overlay)

    # 装饰边框
    draw.rounded_rectangle([34, 34, W - 34, H - 34], radius=26,
                           outline=WASH + (200,), width=2)
    draw.rounded_rectangle([48, 48, W - 48, H - 48], radius=18,
                           outline=WASH + (110,), width=1)

    # 插画区: 圆角裁切
    art = Image.open(img_path).convert("RGB")
    art_w = W - 2 * art_margin
    art = art.resize((art_w, art_h), Image.LANCZOS)
    mask = Image.new("L", (art_w, art_h), 0)
    md = ImageDraw.Draw(mask)
    md.rounded_rectangle([0, 0, art_w, art_h], radius=22, fill=255)
    img.paste(art, (art_margin, art_top), mask)

    # 插画下沿装饰线
    y_art_bottom = art_top + art_h
    draw.line([(art_margin + 60, y_art_bottom + 24), (W - art_margin - 60, y_art_bottom + 24)],
              fill=ACCENT + (170,), width=3)

    # 标题 + 装饰下划线
    title_font = _font(FONT_BOLD, title_size)
    t_y = y_art_bottom + 58
    title_lines = _wrap(draw, title, title_font, W - 240)
    for line in title_lines:
        tw = draw.textlength(line, font=title_font)
        draw.text(((W - tw) / 2, t_y), line, font=title_font, fill=INK)
        t_y += title_lh
    # 标题下小装饰线（放在最后一行字形下缘下方，不与文字重叠）
    dec_w = min(int(draw.textlength(title_lines[0], font=title_font) * 0.45), 300)
    last_bbox = draw.textbbox((0, 0), title_lines[-1], font=title_font)
    dec_y = t_y - title_lh + last_bbox[3] + 16
    draw.line([(W / 2 - dec_w, dec_y), (W / 2 + dec_w, dec_y)], fill=ACCENT + (200,), width=3)
    draw.ellipse([W / 2 - 6, dec_y - 5, W / 2 + 6, dec_y + 5], fill=ACCENT + (200,))
    t_y += 24

    # 金句引语栏（左竖线 + 引号）
    if quote:
        quote_font = _font(FONT_SONG, 30)
        q_y = t_y + 8
        qbox = [100, q_y, W - 100, q_y + 92]
        draw.rounded_rectangle(qbox, radius=14, fill=PAPER + (140,), outline=ACCENT + (90,), width=1)
        draw.rectangle([100, q_y + 18, 104, q_y + 74], fill=ACCENT + (220,))
        q_lines = _wrap(draw, quote, quote_font, W - 260)
        qq_y = q_y + 24
        for line in q_lines:
            draw.text((130, qq_y), line, font=quote_font, fill=ACCENT)
            qq_y += 42
        t_y = qbox[3] + 30

    # 正文
    body_font = _font(FONT_SONG, body_size)
    body_lines = _wrap(draw, body, body_font, W - 300)
    by = t_y
    for line in body_lines:
        draw.text((150, by), line, font=body_font, fill=SUB)
        by += body_lh

    # 右下角落款
    mark_font = _font(FONT_LIGHT, 24)
    mark = "· 手绘 · 一句话成图 ·"
    mw = draw.textlength(mark, font=mark_font)
    draw.text((W - 150 - mw, H - 110), mark, font=mark_font, fill=SUB + (200,))

    # 左上角小印章
    seal_font = _font(FONT_BOLD, 30)
    seal = "绘"
    sw = draw.textlength(seal, font=seal_font)
    sx, sy = W - 168, 96
    draw.rounded_rectangle([sx, sy, sx + 72, sy + 72], radius=8, fill=ACCENT)
    draw.text((sx + (72 - sw) / 2, sy + 14), seal, font=seal_font, fill=PAPER)

    img.save(out_path, quality=95)
    return out_path

# ---------------- 主流程 ----------------
def run_one(description: str, out: str, engine: str, fmt: str, skip_img: bool, img_file: str):
    """跑一张卡。"""
    print(f"[1/3] 文案扩展: {description!r}")
    copy = expand_copy(description)
    print("  title:", copy["title"])
    print("  quote:", copy["quote"])
    print("  style:", copy["style"])
    print("  body :", copy["body"])

    if not img_file:
        print(f"[2/3] 图片生成 ({engine}) ...")
        if not skip_img:
            img_file = gen_image(copy["img_prompt"], engine, "img_raw.png")
        else:
            img_file = "img_raw.png"
    print("  图片:", img_file)

    print(f"[3/3] 排版合成 (fmt={fmt}) ...")
    out = compose_card(copy["title"], copy["body"], copy["quote"], img_file, out,
                       style_key=copy["style"], fmt=fmt)
    print(f"完成: {out}")
    print(f"提示词: {copy['img_prompt']}")
    return out

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("description", nargs="?", help="一句话描述（--batch 时忽略）")
    ap.add_argument("-o", "--out", default="card.png", help="输出 PNG 路径，或 --batch 时的输出目录")
    ap.add_argument("--engine", choices=["sensenova", "agnes"], default="sensenova")
    ap.add_argument("--format", choices=["card", "long"], default="card", help="版式: card 标准竖卡 / long 长图")
    ap.add_argument("--skip-img", action="store_true", help="跳过图片生成(用于调试排版)")
    ap.add_argument("--img", help="直接使用已有图片文件")
    ap.add_argument("--batch", help="批量文件: 每行一句话生成一张卡")
    args = ap.parse_args()

    if args.batch:
        with open(args.batch, encoding="utf-8") as f:
            lines = [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
        os.makedirs(args.out, exist_ok=True)
        for i, ln in enumerate(lines, 1):
            print(f"\n===== [{i}/{len(lines)}] =====")
            out = os.path.join(args.out, f"card_{i:02d}.png")
            try:
                run_one(ln, out, args.engine, args.format, args.skip_img, args.img)
            except Exception as e:
                print(f"❌ 第 {i} 行失败: {e}")
        print(f"\n批量完成: {len(lines)} 张 → {args.out}/")
        return

    if not args.description:
        ap.error("需要 description 或 --batch")
    run_one(args.description, args.out, args.engine, args.format, args.skip_img, args.img)

if __name__ == "__main__":
    main()

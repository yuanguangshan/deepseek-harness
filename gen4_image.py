#!/usr/bin/env python3
"""按用户提示词生图（多引擎降级）：sensenova(商汤, 主力) → jimeng(即梦, 备用)。
用法: python3 gen4_image.py "<prompt>" -o out.png [--size 1024x576] [--engine sensenova]
凭据经环境变量读取：SENSENOVA_API_KEY / AGNES_API_KEY / WECLAW_API_KEY，不硬编码入库。
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.request

SENSENOVA_URL = "https://token.sensenova.cn/v1/images/generations"
SENSENOVA_KEY = os.environ.get("SENSENOVA_API_KEY", "")
SENSENOVA_MODEL = os.environ.get("SENSENOVA_MODEL", "sensenova-u1-fast")

# Jimeng (即梦) 本地 free-api 包装 (jimeng-free-api-all)，走第一个账号（默认每日 60 积分）。
# sessionid 必须经环境变量 JIMENG_SESSION 提供（例如从 ~/.dsh/.credentials 或 shell env 注入）。
JIMENG_URL = "http://127.0.0.1:8000/v1/images/generations"
JIMENG_KEY = os.environ.get("JIMENG_SESSION", "")
JIMENG_MODEL = os.environ.get("JIMENG_MODEL", "jimeng-5.0")


# 主引擎 sensenova(商汤, 免费, watermark 无痕) 兜底；jimeng 备用。
ENGINE_FALLBACK = {
    "sensenova": ["jimeng"],
    "jimeng":    ["sensenova"],
}


def _fetch_json(url, payload, headers, timeout=180):
    req = urllib.request.Request(url, data=json.dumps(payload).encode(), headers=headers)
    return json.loads(urllib.request.urlopen(req, timeout=timeout).read())


def gen_sensenova(prompt, size=None, timeout=180):
    payload = {"model": SENSENOVA_MODEL, "prompt": prompt, "watermark": False}
    if size:
        payload["size"] = size
    resp = _fetch_json(SENSENOVA_URL, payload, {
        "Authorization": f"Bearer {SENSENOVA_KEY}",
        "Content-Type": "application/json",
    }, timeout)
    return resp["data"][0]["url"]


def gen_jimeng(prompt, size=None, timeout=180):
    payload = {"model": JIMENG_MODEL, "prompt": prompt, "ratio": "1:1", "resolution": "2k"}
    resp = _fetch_json(JIMENG_URL, payload, {
        "Authorization": f"Bearer {JIMENG_KEY}",
        "Content-Type": "application/json",
    }, timeout)
    return resp["data"][0]["url"]


ENGINES = {"sensenova": gen_sensenova, "jimeng": gen_jimeng}


def gen_image(prompt, out_path, engine="sensenova", size=None):
    chain = [engine] + ENGINE_FALLBACK.get(engine, [])
    last_err = "unknown"
    for cand in chain:
        try:
            fn = ENGINES[cand]
            # sensenova 不支持 size 时先试一次无 size
            if cand == "sensenova" and size:
                try:
                    url = fn(prompt, size=size)
                except Exception:
                    url = fn(prompt)
            else:
                url = fn(prompt, size=size) if cand == "agnes" and size else fn(prompt)
            urllib.request.urlretrieve(url, out_path)
            print(f"[OK] engine={cand} -> {out_path} (size={size})")
            return out_path
        except Exception as e:
            last_err = str(e)
            print(f"[FAIL] engine={cand}: {e}", flush=True)
            time.sleep(1)
    raise RuntimeError(f"图片生成全部失败: {last_err}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("prompt")
    ap.add_argument("-o", "--out", required=True)
    ap.add_argument("--size", default=None, help="如 1024x576 / 720x1280")
    ap.add_argument("--engine", choices=list(ENGINES), default="sensenova")
    args = ap.parse_args()
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    gen_image(args.prompt, args.out, engine=args.engine, size=args.size)


if __name__ == "__main__":
    main()

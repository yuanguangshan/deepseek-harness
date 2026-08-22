#!/usr/bin/env python3
"""
mcp-search-server — 本地 MCP 搜索服务器

整合知乎搜索、DeepSeek 搜索、知乎全文抓取等能力，
通过 MCP 协议（JSON-RPC 2.0 over stdio）暴露给大模型使用。

零外部依赖：仅使用 Python 标准库。

用法:
  python3 server.py                    # stdio 模式（供 MCP 客户端连接）
  python3 server.py --test             # 测试模式（验证工具可用性）
  python3 server.py --tools            # 列出所有可用工具

MCP 客户端配置（以 Claude Desktop 为例）:
  {
    "mcpServers": {
      "search": {
        "command": "python3",
        "args": ["/path/to/server.py"]
      }
    }
  }
"""

import argparse
import json
import os
import subprocess
import sys
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

# ─── 配置 ───────────────────────────────────────────────────────────────────

ZHIHU_SKILL_DIR = Path.home() / ".dsh/skills/zhihu"
DEEPSEEK_SEARCH_SCRIPT = Path.home() / ".zcode/skills/deepseek-search/scripts/search.py"
FETCH_ZHIHU_SCRIPT = Path.home() / "ygs/pi/.pi/skills/book-writer/scripts/fetch_zhihu_full.py"

# zhihu-cli 二进制路径（macOS 安装在 Application Support 下）
ZHIHU_CLI_DEFAULT = Path.home() / "Library/Application Support/zhihu-cli/current/zhihu-cli"
ZHIHU_CLI_CANDIDATES = [
    ZHIHU_CLI_DEFAULT,
    Path.home() / "go/bin/zhihu-cli",
    Path.home() / ".local/bin/zhihu-cli",
    Path("/opt/homebrew/bin/zhihu-cli"),
]

ZHIHU_HTTP_API = "https://www.zhihu.com/api/v4/search_v3"


# ─── 环境变量加载 ─────────────────────────────────────────────────────────────

def _load_zhihu_secret() -> str:
    """加载 ZHIHU_ACCESS_SECRET：env > .env > auth.json。"""
    if os.environ.get("ZHIHU_ACCESS_SECRET"):
        return os.environ["ZHIHU_ACCESS_SECRET"]
    # 从 .env 文件读取
    for env_path in [Path.home() / "ygs/deepseek-harness/.env", Path.home() / ".zshrc"]:
        if env_path.exists():
            for line in env_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line.startswith("ZHIHU_ACCESS_SECRET="):
                    val = line.split("=", 1)[1].strip().strip('"')
                    if val:
                        os.environ["ZHIHU_ACCESS_SECRET"] = val
                        return val
    # 从 auth.json 读取
    auth = Path.home() / ".pi/agent/auth.json"
    if auth.exists():
        try:
            data = json.loads(auth.read_text(encoding="utf-8"))
            zh = data.get("zhihu") or {}
            secret = zh.get("access_secret", "")
            if secret:
                os.environ["ZHIHU_ACCESS_SECRET"] = secret
                return secret
        except Exception:
            pass
    return ""


# ─── 启动时加载凭证 ───────────────────────────────────────────────────────────

ZHIHU_SECRET = _load_zhihu_secret()

# ─── 工具定义 ─────────────────────────────────────────────────────────────────

TOOLS = [
    {
        "name": "zhihu_search",
        "description": "搜索知乎社区内容（回答、文章、讨论）。返回标题、作者、摘要和链接。适合查找社区观点、经验分享和真实讨论。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键词"},
                "count": {"type": "integer", "description": "返回结果数量，默认 10", "default": 10},
            },
            "required": ["query"],
        },
    },
    {
        "name": "zhihu_global_search",
        "description": "搜索全网内容（不限于知乎）。返回外部来源的结果，适合查找新闻、官网信息或权威来源。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键词"},
                "count": {"type": "integer", "description": "返回结果数量，默认 10", "default": 10},
            },
            "required": ["query"],
        },
    },
    {
        "name": "deepseek_search",
        "description": "DeepSeek 服务端联网搜索。模型服务端执行真实搜索并返回带来源的综合答案。适合需要综合信息的查询。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索问题"},
                "max_tokens": {"type": "integer", "description": "答案最大 token 数，默认 2500", "default": 2500},
            },
            "required": ["query"],
        },
    },
    {
        "name": "zhihu_hot",
        "description": "获取知乎当前热榜。了解社区正在讨论的热门话题。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "limit": {"type": "integer", "description": "返回条目数量，默认 20", "default": 20},
            },
        },
    },
    {
        "name": "zhihu_answer",
        "description": "知乎直答：先检索再生成答案，快速获得针对问题的综合回答。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "问题"},
            },
            "required": ["query"],
        },
    },
    {
        "name": "fetch_zhihu_article",
        "description": "抓取知乎文章/回答的全文内容。需要提供知乎文章或回答的 URL。返回 Markdown 格式的全文。",
        "inputSchema": {
            "type": "object",
            "properties": {
                "url": {"type": "string", "description": "知乎文章或回答的 URL"},
            },
            "required": ["url"],
        },
    },
]


# ─── 工具执行 ─────────────────────────────────────────────────────────────────

def _find_zhihu_cli() -> str | None:
    """查找 zhihu-cli 二进制路径。"""
    # 优先从 run.sh 获取
    run_sh = ZHIHU_SKILL_DIR / "scripts/run.sh"
    if run_sh.exists():
        try:
            result = subprocess.run(
                ["bash", str(run_sh), "status"],
                capture_output=True, text=True, timeout=15,
            )
            data = json.loads(result.stdout)
            bp = data.get("binary_path")
            if bp and Path(bp).exists():
                return bp
        except Exception:
            pass
    # 回退到常见路径
    for p in ZHIHU_CLI_CANDIDATES:
        if p.exists():
            return str(p)
    return None


def _run_cmd(cmd: list[str], timeout: int = 60) -> dict[str, Any]:
    """执行命令并返回 {ok, stdout, stderr}。自动传递 ZHIHU_ACCESS_SECRET 给子进程。"""
    env = os.environ.copy()
    if ZHIHU_SECRET:
        env["ZHIHU_ACCESS_SECRET"] = ZHIHU_SECRET
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, env=env)
        return {"ok": r.returncode == 0, "stdout": r.stdout, "stderr": r.stderr}
    except subprocess.TimeoutExpired:
        return {"ok": False, "stdout": "", "stderr": f"命令超时 ({timeout}s)"}
    except FileNotFoundError:
        return {"ok": False, "stdout": "", "stderr": f"命令不存在: {cmd[0]}"}
    except Exception as e:
        return {"ok": False, "stdout": "", "stderr": str(e)}


def tool_zhihu_search(query: str, count: int = 10) -> str:
    cli = _find_zhihu_cli()
    if not cli:
        return "❌ zhihu-cli 未安装。请先运行 zhihu skill 的 setup 脚本。"
    r = _run_cmd([cli, "search", "zhihu", "--query", query, "--count", str(count)])
    if r["ok"]:
        return r["stdout"]
    return f"❌ 搜索失败:\n{r['stderr']}"


def tool_zhihu_global_search(query: str, count: int = 10) -> str:
    cli = _find_zhihu_cli()
    if not cli:
        return "❌ zhihu-cli 未安装。"
    r = _run_cmd([cli, "search", "global", "--query", query, "--count", str(count)])
    if r["ok"]:
        return r["stdout"]
    return f"❌ 全网搜索失败:\n{r['stderr']}"


def tool_deepseek_search(query: str, max_tokens: int = 2500) -> str:
    if not DEEPSEEK_SEARCH_SCRIPT.exists():
        return "❌ deepseek-search 脚本未找到。"
    # 确保带"搜索:"前缀
    q = query if "搜索" in query else f"搜索: {query}"
    r = _run_cmd(
        ["python3", str(DEEPSEEK_SEARCH_SCRIPT), q, "--max-tokens", str(max_tokens)],
        timeout=90,
    )
    if r["ok"]:
        return r["stdout"]
    return f"❌ DeepSeek 搜索失败:\n{r['stderr']}"


def tool_zhihu_hot(limit: int = 20) -> str:
    cli = _find_zhihu_cli()
    if not cli:
        return "❌ zhihu-cli 未安装。"
    r = _run_cmd([cli, "hot", "--limit", str(limit)])
    if r["ok"]:
        return r["stdout"]
    return f"❌ 获取热榜失败:\n{r['stderr']}"


def tool_zhihu_answer(query: str) -> str:
    cli = _find_zhihu_cli()
    if not cli:
        return "❌ zhihu-cli 未安装。"
    r = _run_cmd([cli, "answer", "--query", query], timeout=60)
    if r["ok"]:
        return r["stdout"]
    return f"❌ 知乎直答失败:\n{r['stderr']}"


def tool_fetch_zhihu_article(url: str) -> str:
    if not FETCH_ZHIHU_SCRIPT.exists():
        return "❌ fetch_zhihu_full.py 脚本未找到。"
    r = _run_cmd(["python3", str(FETCH_ZHIHU_SCRIPT), url], timeout=180)
    if r["ok"]:
        return r["stdout"]
    return f"❌ 文章抓取失败:\n{r['stderr']}"


TOOL_HANDLERS = {
    "zhihu_search": lambda args: tool_zhihu_search(args["query"], args.get("count", 10)),
    "zhihu_global_search": lambda args: tool_zhihu_global_search(args["query"], args.get("count", 10)),
    "deepseek_search": lambda args: tool_deepseek_search(args["query"], args.get("max_tokens", 2500)),
    "zhihu_hot": lambda args: tool_zhihu_hot(args.get("limit", 20)),
    "zhihu_answer": lambda args: tool_zhihu_answer(args["query"]),
    "fetch_zhihu_article": lambda args: tool_fetch_zhihu_article(args["url"]),
}


# ─── MCP 协议层（JSON-RPC 2.0 over stdio）────────────────────────────────────

PROTOCOL_VERSION = "2024-11-05"
SERVER_INFO = {"name": "mcp-search-server", "version": "1.0.0"}


def _write_response(response: dict):
    """写入一条 JSON-RPC 响应到 stdout。"""
    line = json.dumps(response, ensure_ascii=False)
    sys.stdout.write(f"{line}\n")
    sys.stdout.flush()


def _write_error(req_id: int | str | None, code: int, message: str, data: Any = None):
    """写入错误响应。"""
    err = {"code": code, "message": message}
    if data is not None:
        err["data"] = data
    _write_response({"jsonrpc": "2.0", "id": req_id, "error": err})


def _write_result(req_id: int | str | None, result: dict):
    """写入成功响应。"""
    _write_response({"jsonrpc": "2.0", "id": req_id, "result": result})


def handle_message(msg: dict):
    """处理一条 JSON-RPC 消息。"""
    req_id = msg.get("id")
    method = msg.get("method", "")
    params = msg.get("params", {})

    if method == "initialize":
        _write_result(req_id, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
        })

    elif method == "notifications/initialized":
        pass  # 客户端通知，无需响应

    elif method == "tools/list":
        _write_result(req_id, {"tools": TOOLS})

    elif method == "tools/call":
        tool_name = params.get("name", "")
        tool_args = params.get("arguments", {})
        handler = TOOL_HANDLERS.get(tool_name)
        if not handler:
            _write_error(req_id, -32601, f"未知工具: {tool_name}")
            return
        try:
            content = handler(tool_args)
            _write_result(req_id, {
                "content": [{"type": "text", "text": content}],
            })
        except Exception as e:
            _write_result(req_id, {
                "content": [{"type": "text", "text": f"❌ 工具执行错误: {e}"}],
                "isError": True,
            })

    elif method == "ping":
        _write_result(req_id, {})

    elif method.startswith("notifications/"):
        pass  # 通知类消息，无需响应

    else:
        _write_error(req_id, -32601, f"未知方法: {method}")


def run_stdio():
    """stdio 模式：从 stdin 读取 JSON-RPC 消息，处理后写入 stdout。"""
    # MCP 协议要求用换行分隔的 JSON（JSONL）
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            _write_error(None, -32700, "解析错误: 无效 JSON")
            continue
        try:
            handle_message(msg)
        except Exception:
            traceback.print_exc(file=sys.stderr)
            _write_error(req_id := msg.get("id"), -32603, "内部错误")


# ─── 测试模式 ─────────────────────────────────────────────────────────────────

def run_test():
    """测试模式：验证各工具的可用性。"""
    print("🔍 MCP 搜索服务器 — 工具可用性测试\n")

    # 检查 zhihu-cli
    cli = _find_zhihu_cli()
    print(f"zhihu-cli: {'✅ ' + cli if cli else '❌ 未安装'}")

    # 检查 deepseek-search
    print(f"deepseek-search: {'✅ ' + str(DEEPSEEK_SEARCH_SCRIPT) if DEEPSEEK_SEARCH_SCRIPT.exists() else '❌ 未找到'}")

    # 检查 fetch_zhihu_full.py
    print(f"fetch_zhihu_full: {'✅ ' + str(FETCH_ZHIHU_SCRIPT) if FETCH_ZHIHU_SCRIPT.exists() else '❌ 未找到'}")

    # 检查环境变量
    env_secret = os.environ.get("ZHIHU_ACCESS_SECRET", "")
    if not env_secret:
        # 尝试从 .env 读取
        env_file = Path.home() / "ygs/deepseek-harness/.env"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if line.strip().startswith("ZHIHU_ACCESS_SECRET="):
                    env_secret = line.split("=", 1)[1].strip().strip('"')
                    break
    print(f"ZHIHU_ACCESS_SECRET: {'✅ 已设置' if env_secret else '⚠️ 未设置（搜索可能受限）'}")

    print(f"\n📋 可用工具 ({len(TOOLS)} 个):")
    for t in TOOLS:
        print(f"  • {t['name']}: {t['description'][:60]}...")


def run_list_tools():
    """列出所有工具的 JSON 定义。"""
    print(json.dumps(TOOLS, ensure_ascii=False, indent=2))


# ─── 入口 ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="MCP 搜索服务器")
    parser.add_argument("--test", action="store_true", help="测试模式：验证工具可用性")
    parser.add_argument("--tools", action="store_true", help="列出所有工具定义")
    args = parser.parse_args()

    if args.test:
        run_test()
    elif args.tools:
        run_list_tools()
    else:
        run_stdio()


if __name__ == "__main__":
    main()

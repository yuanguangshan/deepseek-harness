# MCP Search Server

本地 MCP 搜索服务器，整合知乎搜索、DeepSeek 搜索、知乎全文抓取等能力，通过 MCP 协议暴露给大模型使用。

## 能力

| 工具 | 说明 | 依赖 |
|---|---|---|
| `zhihu_search` | 搜索知乎社区内容（回答、文章、讨论） | zhihu-cli |
| `zhihu_global_search` | 搜索全网内容（不限于知乎） | zhihu-cli |
| `deepseek_search` | DeepSeek 服务端联网搜索，返回综合答案 | deepseek-search |
| `zhihu_hot` | 获取知乎当前热榜 | zhihu-cli |
| `zhihu_answer` | 知乎直答（先检索再生成答案） | zhihu-cli |
| `fetch_zhihu_article` | 抓取知乎文章/回答的全文 | fetch_zhihu_full.py |

## 零依赖

仅使用 Python 标准库，无需 `pip install` 任何包。

## 快速开始

### 1. 验证工具可用性

```bash
python3 server.py --test
```

### 2. 列出工具定义

```bash
python3 server.py --tools
```

### 3. 启动 MCP 服务器

```bash
python3 server.py
```

服务器通过 stdin/stdout 使用 JSON-RPC 2.0 通信，供 MCP 客户端连接。

## 客户端配置

### Claude Desktop

编辑 `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "search": {
      "command": "python3",
      "args": ["/Users/ygs/ygs/deepseek-harness/mcp-search-server/server.py"]
    }
  }
}
```

### Cursor / VS Code

在 `.cursor/mcp.json` 或 `.vscode/mcp.json` 中添加:

```json
{
  "servers": {
    "search": {
      "command": "python3",
      "args": ["/Users/ygs/ygs/deepseek-harness/mcp-search-server/server.py"]
    }
  }
}
```

### 通用 MCP 客户端

任何支持 MCP 协议的客户端都可以通过 stdio 连接:

```bash
# 直接运行
python3 /Users/ygs/ygs/deepseek-harness/mcp-search-server/server.py

# 或通过 stdin 交互
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test"}}}' | python3 server.py
```

## 依赖的外部工具

| 工具 | 安装/位置 | 用途 |
|---|---|---|
| zhihu-cli | `~/.dsh/skills/zhihu/scripts/setup.sh` | 知乎搜索/热榜/直答 |
| deepseek-search | `~/.zcode/skills/deepseek-search/scripts/search.py` | DeepSeek 联网搜索 |
| fetch_zhihu_full.py | `~/ygs/pi/.pi/skills/book-writer/scripts/fetch_zhihu_full.py` | 知乎全文抓取 |

## 环境变量

- `ZHIHU_ACCESS_SECRET`: 知乎 Access Secret（可选，搜索功能需要）

## 协议

基于 MCP（Model Context Protocol），JSON-RPC 2.0 over stdio。

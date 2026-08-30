# MCP Search Server

English | [中文](README.zh.md)

A local MCP search server that integrates Zhihu search, DeepSeek web search, Zhihu full-text fetching, and more, exposed to LLMs through the MCP protocol.

## Capabilities

| Tool | Description | Depends on |
|---|---|---|
| `zhihu_search` | Search Zhihu community content (answers, articles, discussions) | zhihu-cli |
| `zhihu_global_search` | Search the whole web (not limited to Zhihu) | zhihu-cli |
| `deepseek_search` | DeepSeek server-side web search, returns a synthesized answer | deepseek-search |
| `zhihu_hot` | Get the current Zhihu hot list | zhihu-cli |
| `zhihu_answer` | Zhihu direct answer (search first, then generate) | zhihu-cli |
| `fetch_zhihu_article` | Fetch the full text of a Zhihu article/answer | fetch_zhihu_full.py |

## Zero dependencies

Uses only the Python standard library; no `pip install` needed.

## Quick start

### 1. Verify tool availability

```bash
python3 server.py --test
```

### 2. List tool definitions

```bash
python3 server.py --tools
```

### 3. Start the MCP server

```bash
python3 server.py
```

The server communicates over stdin/stdout with JSON-RPC 2.0, for MCP clients to connect.

## Client configuration

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

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

Add to `.cursor/mcp.json` or `.vscode/mcp.json`:

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

### Generic MCP clients

Any client supporting the MCP protocol can connect over stdio:

```bash
# run directly
python3 /Users/ygs/ygs/deepseek-harness/mcp-search-server/server.py

# or interact through stdin
echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test"}}}' | python3 server.py
```

## External tools it depends on

| Tool | Install/location | Used for |
|---|---|---|
| zhihu-cli | `~/.dsh/skills/zhihu/scripts/setup.sh` | Zhihu search/hot list/direct answer |
| deepseek-search | `~/.zcode/skills/deepseek-search/scripts/search.py` | DeepSeek web search |
| fetch_zhihu_full.py | `~/ygs/pi/.pi/skills/book-writer/scripts/fetch_zhihu_full.py` | Zhihu full-text fetching |

## Environment variables

- `ZHIHU_ACCESS_SECRET`: Zhihu Access Secret (optional; required by the search features)

## Protocol

Based on MCP (Model Context Protocol), JSON-RPC 2.0 over stdio.

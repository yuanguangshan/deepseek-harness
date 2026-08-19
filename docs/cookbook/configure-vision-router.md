# Configure Vision Router: SenseNova Free Vision Chain

English | [中文](configure-vision-router.zh.md)

This document explains how to configure the dsh-vision-router plugin so the wrapper route (automatic image recognition) uses SenseNova (free) instead of the default MiMo (paid).

## Problem

The dsh-vision-router wrapper route processes user-pasted images. By default, it uses the DSH adapter system to select vision models, bypassing the `providers` configuration chain.

## Solution

Set `routing: true` in `cordis.patch.yml` to make the wrapper route use the `providers` chain.

### Configuration

Edit `~/.dsh/profiles/web/cordis.patch.yml` and add or modify the vision-router configuration:

```yaml
- id: vision-router
  config:
    routing: true                    # Key: enable whole-turn chain routing
    providers:
      - provider: vision-http
        model: sensenova/sensenova-6.8-flash-lite
        fallbacks:
          - xiaomi-mimo/mimo-v2.5
          - ovh/Qwen2.5-VL-72B-Instruct
          - ark/ark-code-latest
    httpProviders:
      - name: sensenova
        baseURL: https://token.sensenova.cn/v1
        model: sensenova-6.8-flash-lite
        apiKeyEnv: SENSENOVA_API_KEY
        maxTokens: 16384
      - name: xiaomi-mimo
        baseURL: https://api.xiaomi.com/v1
        model: mimo-v2.5
        apiKeyEnv: MIMO_API_KEY
      - name: ovh
        baseURL: https://api.ovhcloud.com/v1
        model: Qwen2.5-VL-72B-Instruct
        apiKeyEnv: OVH_API_KEY
      - name: ark
        baseURL: https://api.ark.cn/v1
        model: ark-code-latest
        apiKeyEnv: ARK_API_KEY
```

### Configuration Details

| Config | Value | Effect |
|--------|-------|--------|
| `routing` | `true` | Wrapper route uses `providers` chain |
| `providers[0]` | `vision-http/sensenova/sensenova-6.8-flash-lite` | Primary vision model (free) |
| `providers[0].fallbacks` | MiMo → OVH → Ark | Fallback chain |

### R2 Upload Mechanism

SenseNova requires HTTP URLs and cannot process base64 images. The wrapper route automatically:

1. Detects SenseNova as the target provider
2. Uploads base64 image to R2 storage bucket
3. Gets public URL (`https://pic.want.biz/handdrawn/vision-chan-*`)
4. Sends URL to SenseNova API
5. Cleans up R2 temporary files after API call

### Environment Variables

Ensure these environment variables are set:

```bash
export SENSENOVA_API_KEY="your-sensenova-api-key"
export MIMO_API_KEY="your-mimo-api-key"
export OVH_API_KEY="your-ovh-api-key"
export ARK_API_KEY="your-ark-api-key"
```

Or configure in `~/.dsh/.credentials.yaml`.

## Verify Configuration

### 1. Restart DSH Web

```bash
/web-restart
```

### 2. Test Image Recognition

Paste an image in the chat interface and ask "describe the image in detail".

### 3. Check Session Logs

View the session JSONL file to confirm vision model calls:

```bash
zstdcat ~/.dsh/sessions/<session-id>/session.jsonl.zstd | grep "vision-chain"
```

Expected output:

```json
"source": {
  "kind": "model",
  "provider": "vision-chain",
  "model": "vision-http/sensenova/sensenova-6.8-flash-lite"
}
```

### 4. Check R2 Temporary Files

```bash
rclone ls r2:yuangs/handdrawn/ --max-age 1h
```

After the API call completes, `vision-chan-*` temporary files should be automatically cleaned up.

## Cost Comparison

| Model | Cost | Notes |
|-------|------|-------|
| SenseNova | Free | Primary vision model |
| MiMo V2.5 | ~$0.001/image | Fallback vision model |
| OVH Qwen2.5-VL | Free | Fallback vision model |
| Ark | ~$0.001/image | Fallback vision model |

## Troubleshooting

### SenseNova Unavailable

If SenseNova API calls fail, automatic fallback to MiMo occurs:

1. Check `SENNOVA_API_KEY` is correctly set
2. Verify network connectivity
3. Review DSH logs: `~/.dsh/logs/vision-router/vision-router.log`

### Images Not Recognized

Ensure:

1. `routing: true` is set
2. Current session uses "Auto Vision" model group
3. Image format is supported (PNG, JPEG, WebP, GIF)

### R2 Upload Failed

Check:

1. rclone configuration is correct (`r2:yuangs/handdrawn/`)
2. R2 credentials are valid
3. Network connection is working

## Related Documentation

- [dsh-vision-router GitHub](https://github.com/ysr666/dsh-vision-router)
- [Agent Note: Vision Router SenseNova Routing Fix](../../.agents/notes/implemented/process/2026-08-20-vision-router-sensenova-routing.md)

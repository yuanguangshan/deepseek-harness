# Agent Note: Vision Router SenseNova Routing Fix

Status: implemented

English | [中文](2026-08-20-vision-router-sensenova-routing.zh.md)

## Problem

dsh-vision-router's wrapper route (automatic image recognition when pasting images) was using MiMo V2.5 (paid) instead of SenseNova (free), despite SenseNova being configured as the first provider in the `providers` chain.

## Root Cause

The `routing` config defaults to `false` (tool-first flow). When `routing: false`:

- Wrapper route uses DSH adapter system (`channelBridgePlan`)
- `providers` chain is **not used** for wrapper route selection
- `providers` chain only affects `vision_describe` tool's `usablePairs`

When `routing: true`:

- Wrapper route uses `providers` chain directly
- First provider in chain is attempted first
- Fallback chain works as expected

## Decision

Added `routing: true` to the vision-router config in `cordis.patch.yml`:

```yaml
- id: vision-router
  config:
    routing: true                    # ← Enable whole-turn chain routing
    providers:
      - provider: vision-http
        model: sensenova/sensenova-6.8-flash-lite
        fallbacks:
          - xiaomi-mimo/mimo-v2.5
          - ovh/Qwen2.5-VL-72B-Instruct
          - ark/ark-code-latest
```

## R2 Upload Mechanism

SenseNova requires HTTP URLs (cannot process base64). The wrapper route's `directChannelVisionAnswer` function:

1. Detects SenseNova as the target provider
2. Uploads base64 image to R2 (`rclone copyto`)
3. Gets public URL (`https://pic.want.biz/handdrawn/vision-chan-*`)
4. Sends URL to SenseNova API
5. Cleans up R2 temporary files after API call

## Verification

Session JSONL evidence for the Huangshan image (turn 84):

```json
"source": {
  "kind": "model",
  "provider": "vision-chain",
  "model": "vision-http/sensenova/sensenova-6.8-flash-lite"
}
```

Full session model call statistics:

```
270x  xiaomi-vision/mimo-v2.5          ← Old behavior (routing: false)
117x  xiaomi/mimo-v2.5                 ← Text model (brain)
 51x  opencode-go-vision/deepseek-v4-flash  ← Old behavior
 10x  vision-chain/vision-http/sensenova/sensenova-6.8-flash-lite  ← New! SenseNova ✅
  2x  weclaw-vision/ds                 ← WeClaw vision
```

## Cost Impact

- Before: MiMo V2.5 for all image processing (~$0.001-0.002 per image)
- After: SenseNova for all new image processing (free)
- Text model (MiMo) still used for reasoning (unavoidable)

## Configuration Details

| Config | Value | Effect |
|--------|-------|--------|
| `routing` | `true` | Wrapper route uses `providers` chain |
| `providers[0]` | `vision-http/sensenova/sensenova-6.8-flash-lite` | First choice (free) |
| `providers[0].fallbacks[0]` | `xiaomi-mimo/mimo-v2.5` | Fallback (paid) |
| `providers[0].fallbacks[1]` | `ovh/Qwen2.5-VL-72B-Instruct` | Fallback (free) |
| `providers[0].fallbacks[2]` | `ark/ark-code-latest` | Fallback (paid) |

## Alternatives considered

- Reorder `providers` so SenseNova leads while keeping `routing: false`. Rejected: with the default tool-first flow the wrapper route never consults the `providers` chain, so the reorder alone would change nothing for pasted images.
- Patch the DSH adapter plan (`channelBridgePlan`) to read `providers` even when `routing: false`. Rejected: it changes shared adapter semantics for every wrapper consumer to fix one deployment's provider preference, when the shipped `routing: true` switch already selects chain routing per config.
- Stay on MiMo V2.5 for everything. Rejected: per-image cost for a capability SenseNova serves for free, with no quality requirement here that MiMo uniquely meets.

## Consequences

- Pasted-image recognition routes SenseNova-first with the paid MiMo chain kept as a declared fallback, so a SenseNova outage degrades instead of failing.
- `routing: true` makes the `providers` chain authoritative for the wrapper route as well as the `vision_describe` tool — future provider changes must treat the chain, not the adapter default, as the routing surface.
- SenseNova's URL-only image input binds this route to the R2 upload hop and its post-call cleanup; losing R2 access removes the free tier, not the capability.

## Key Learnings

1. `providers` chain behavior depends on `routing` config
2. `routing: false` (default) = tool-first flow, wrapper route uses DSH adapters
3. `routing: true` = whole-turn routing, wrapper route uses `providers` chain
4. SenseNova needs R2 upload for base64 images (API only accepts URLs)
5. R2 temporary files are cleaned up after API calls

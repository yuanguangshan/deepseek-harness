#!/usr/bin/env bash
# ==============================================================================
# apply-model-tps.sh — 一键应用「占位符 + TPS 徽标 + 菜单宽度/层级/居中」六项改动
# 位置：ygsdoc/dsh-model-tps-patch/apply-model-tps.sh
# 补丁：model-tps-sidebar-z-20260821.patch（10 个文件，508 行）
# 基线：ebc896fc41^（apiproxy 投影落地前）；每次定制进 master 后需重新生成
# ==============================================================================
#
# 【背景】
# 2026-08-21 起对仓库源码（非 node_modules）做了以下改动。升级 dsh 后源码被覆盖，
# 用本脚本重新应用，然后重建产物。
#
# 【六项改动】
# 1) 输入框占位符显示当前模型名
#    - apiproxy 新增 modelSelection 投影（fold request/context）
#    - selectModel 确认后立即落 request/context（占位符即时更新）
#    - ui-conversation: '给 {model} 发消息' / 'Message {model}'，无记录回退旧文案
# 2) TPS 徽标显示在输入框内、模型选择按钮左边
#    - 读 sessionStats 投影 decodeTokens/decodeMs，'425 tok/s' 格式
# 3) 模型选择菜单宽度上限 min(280px, 100vw-32px)
#    - 长模型名省略号截断，不再撑出横向滚动/盖住侧边栏
# 4) 模型选择菜单 z-index 20 → 100
#    - 展开时浮在侧边栏上方（低于 Modal 1000 / Toast 1100）
# 5) 复合模型名拆分显示（vision-http/sensenova/... → 短名主显 + 前缀小字）
#    - 触发按钮只显短名；tooltip 与 aria 保留完整全名
# 6) 手机端菜单视口正中央弹出（position: fixed 居中弹窗 280px）
#    - 不再锚在 composer 尾部向左展开遮住左侧内容
#
# 【用法】升级 dsh 后：
#   bash ygsdoc/dsh-model-tps-patch/apply-model-tps.sh
#
# ==============================================================================
set -euo pipefail

REPO="/Users/ygs/ygs/deepseek-harness"
PATCH="$REPO/ygsdoc/dsh-model-tps-patch/model-tps-sidebar-z-20260821.patch"

cd "$REPO"

echo "==> [1/3] 应用补丁"
if git apply --check "$PATCH" 2>/dev/null; then
  git apply "$PATCH"
  echo "    补丁已应用"
else
  if git apply --reverse --check "$PATCH" 2>/dev/null; then
    echo "    补丁已在位（内容一致），跳过"
  else
    echo "    ❌ 补丁无法应用（上游源码变化产生冲突），请手工处理" >&2
    exit 1
  fi
fi

echo "==> [2/3] typecheck"
pnpm run typecheck

echo "==> [3/3] 重建产物（host + 两个 client bundle）"
npm run build:lib:host
pnpm --filter @deepseek-ai/dsh-client-ui-conversation bundle
pnpm --filter @deepseek-ai/dsh-client-ui-model-selection bundle

echo ""
echo "✅ 完成。重启 dsh web 服务器生效。"

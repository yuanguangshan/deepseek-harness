#!/usr/bin/env node
/**
 * vision-recognize.mjs — 通用图像识别分流器（三模型降级链）
 *
 * 降级策略：
 *   1. SenseNova 6.8 Flash Lite（免费，HTTP URL only）
 *      - 本地文件 → 上传 R2 → 获取 URL → 发给 SenseNova
 *      - 已有 URL → 直接发给 SenseNova
 *   2. Muse Spark 1.2 Contributor（Responses API + base64）
 *   3. MiMo V2.5（Chat Completions + base64）
 *   4. 原 vision-router 插件 fallback
 *
 * 用法：
 *   node vision-recognize.mjs <图片来源> [问题]
 *
 * 示例：
 *   node vision-recognize.mjs /path/to/image.png "描述这张图"
 *   node vision-recognize.mjs https://example.com/photo.jpg "这是什么场景"
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ── 配置 ──────────────────────────────────────────────────────────
const SENSENOVA_URL = 'https://token.sensenova.cn/v1/chat/completions';
const SENSENOVA_MODEL = 'sensenova-6.8-flash-lite';
const MUSE_SPARK_URL = 'https://opencode.ai/zen/go/v1/responses';
const MUSE_SPARK_MODEL = 'muse-spark-1.2-contributor';
const MIMO_URL = 'https://opencode.ai/zen/go/v1/chat/completions';
const MIMO_MODEL = 'mimo-v2.5';
const R2_REMOTE = 'r2:yuangs/handdrawn';
const R2_PUBLIC_BASE = 'https://pic.want.biz/handdrawn';
const DOWNLOAD_TIMEOUT_MS = 30_000;

// ── 加载 .env ──────────────────────────────────────────────────────
function loadEnv() {
  const envPath = join(process.env.HOME || '', 'ygs/deepseek-harness/.env');
  if (!existsSync(envPath)) return;
  const lines = readFileSync(envPath, 'utf-8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].trim();
    }
  }
}
loadEnv();

// ── 工具函数 ──────────────────────────────────────────────────────

function isUrl(source) {
  return /^https?:\/\//i.test(source);
}

function isLocalPath(source) {
  return existsSync(source);
}

function guessMediaType(filePath) {
  const ext = filePath.toLowerCase().split('.').pop();
  const map = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp' };
  return map[ext] || 'image/png';
}

function guessExt(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    for (const e of ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp']) {
      if (p.endsWith(e)) return e;
    }
  } catch {}
  return '.png';
}

function getApiKey(envName) {
  if (process.env[envName]) return process.env[envName];
  const authPath = join(process.env.HOME || '', '.pi/agent/auth.json');
  if (existsSync(authPath)) {
    try {
      const auth = JSON.parse(readFileSync(authPath, 'utf-8'));
      return auth['opencode-go']?.key || auth['xiaomi']?.key;
    } catch {}
  }
  return undefined;
}

function downloadToTemp(url) {
  const tmpDir = join(tmpdir(), 'vision-recognize');
  mkdirSync(tmpDir, { recursive: true });
  const f = join(tmpDir, `${randomBytes(8).toString('hex')}${guessExt(url)}`);
  execSync(`curl -fsSL --max-time ${DOWNLOAD_TIMEOUT_MS / 1000} -o "${f}" "${url}"`, { stdio: 'pipe' });
  return f;
}

function uploadToR2(localPath) {
  const fileName = `vision-${Date.now()}${guessExt(localPath)}`;
  console.log(`  📤 上传到 R2: ${fileName}`);
  execSync(`rclone copyto "${localPath}" ${R2_REMOTE}/${fileName}`, { stdio: 'pipe' });
  const url = `${R2_PUBLIC_BASE}/${fileName}`;
  console.log(`  🔗 公开 URL: ${url}`);
  return { url, fileName };
}

function deleteFromR2(fileName) {
  try { execSync(`rclone delete ${R2_REMOTE}/${fileName}`, { stdio: 'pipe' }); } catch {}
}

// ── 三个视觉后端 ──────────────────────────────────────────────────

function callSenseNova(imageUrl, question) {
  const apiKey = process.env.SENSENOVA_API_KEY;
  if (!apiKey) throw new Error('SENSENOVA_API_KEY 未设置');
  const body = {
    model: SENSENOVA_MODEL,
    messages: [{ role: 'user', content: [
      { type: 'text', text: question },
      { type: 'image_url', image_url: { url: imageUrl } }
    ]}],
    max_tokens: 4096
  };
  const r = execSync(`curl -s --max-time 60 "${SENSENOVA_URL}" -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`, { encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 });
  const d = JSON.parse(r);
  if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
  return d.choices?.[0]?.message?.content || '(无响应)';
}

function callMuseSpark(base64, mediaType, question) {
  const apiKey = getApiKey('OPENCODE_GO_API_KEY');
  if (!apiKey) throw new Error('OPENCODE_GO_API_KEY 未设置');
  const body = {
    model: MUSE_SPARK_MODEL,
    reasoning: { effort: 'low' },
    input: [{ role: 'user', content: [
      { type: 'input_text', text: question },
      { type: 'input_image', image_url: `data:${mediaType};base64,${base64}` }
    ]}],
    max_output_tokens: 2000
  };
  const r = execSync(`curl -s --max-time 120 "${MUSE_SPARK_URL}" -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`, { encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 });
  const d = JSON.parse(r);
  if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
  for (const o of d.output || []) {
    if (o.type === 'message') {
      for (const c of o.content || []) {
        if (c.type === 'output_text') return c.text;
      }
    }
  }
  return '(无响应)';
}

function callMiMo(base64, mediaType, question) {
  const apiKey = getApiKey('OPENCODE_GO_API_KEY');
  if (!apiKey) throw new Error('OPENCODE_GO_API_KEY 未设置');
  const body = {
    model: MIMO_MODEL,
    messages: [{ role: 'user', content: [
      { type: 'text', text: question },
      { type: 'image_url', image_url: { url: `data:${mediaType};base64,${base64}` } }
    ]}],
    max_tokens: 4096
  };
  const r = execSync(`curl -s --max-time 60 "${MIMO_URL}" -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`, { encoding: 'utf-8', maxBuffer: 2 * 1024 * 1024 });
  const d = JSON.parse(r);
  if (d.error) throw new Error(d.error.message || JSON.stringify(d.error));
  return d.choices?.[0]?.message?.content || '(无响应)';
}

// ── 主流程 ──────────────────────────────────────────────────────────

function main() {
  const [,, source, ...qp] = process.argv;
  const question = qp.join(' ') || '请客观描述这张图片的内容';

  if (!source) {
    console.error('用法: node vision-recognize.mjs <图片来源> [问题]');
    console.error('  本地: /path/to/image.png');
    console.error('  URL:  https://example.com/photo.jpg');
    process.exit(1);
  }

  let localFile = null, r2FileName = null, imageUrl = null;
  const errors = [];

  try {
    if (isUrl(source)) {
      console.log(`🌐 URL 模式: ${source}`);
      imageUrl = source;
      localFile = downloadToTemp(source);
    } else if (isLocalPath(source)) {
      console.log(`📁 本地文件模式: ${source}`);
      localFile = source;
      const up = uploadToR2(source);
      imageUrl = up.url;
      r2FileName = up.fileName;
    } else {
      console.error(`❌ 无法识别图片来源: ${source}`);
      process.exit(1);
    }

    const imageBytes = readFileSync(localFile);
    const b64 = imageBytes.toString('base64');
    const mt = guessMediaType(localFile);

    // 1️⃣ SenseNova
    console.log('\n① 尝试 SenseNova 6.8 Flash Lite...');
    try {
      console.log(`\n✅ [SenseNova] 识别成功:\n\n${callSenseNova(imageUrl, question)}`);
      return;
    } catch (e) { errors.push(`SenseNova: ${e.message}`); console.log(`  ❌ ${e.message}`); }

    // 2️⃣ Muse Spark 1.2
    console.log('\n② 尝试 Muse Spark 1.2 Contributor...');
    try {
      console.log(`\n✅ [Muse Spark 1.2] 识别成功:\n\n${callMuseSpark(b64, mt, question)}`);
      return;
    } catch (e) { errors.push(`Muse Spark: ${e.message}`); console.log(`  ❌ ${e.message}`); }

    // 3️⃣ MiMo V2.5
    console.log('\n③ 尝试 MiMo V2.5...');
    try {
      console.log(`\n✅ [MiMo V2.5] 识别成功:\n\n${callMiMo(b64, mt, question)}`);
      return;
    } catch (e) { errors.push(`MiMo: ${e.message}`); console.log(`  ❌ ${e.message}`); }

    console.error('\n❌ 所有视觉后端均失败:');
    errors.forEach((e, i) => console.error(`  ${i + 1}. ${e}`));
    process.exit(1);
  } finally {
    if (r2FileName) deleteFromR2(r2FileName);
    if (localFile && localFile !== source && existsSync(localFile)) unlinkSync(localFile);
  }
}

main();

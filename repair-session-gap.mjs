#!/usr/bin/env node
/**
 * repair-session-gap.mjs — dsh session 日志修复/校验工具（加固版）
 *
 * 定位：修掉 5668c5e033 那批工具（apply-dsh-lock.sh / session-coordinator.cjs /
 * fix-dups-preserve-frames.cjs）里"简单 magic 扫描 + 只认顶层 seq"的缺陷引入的
 * seq gap / 重复事件问题：
 *   - 帧边界用 dsh 官方的精确 zstd frame 扫描（解析 frame header/block/checksum）
 *   - 事件解码用官方 @deepseek-ai/dsh-session 的 decodeStorageRecord
 *     （正确处理 assistant/chunk、reasoning-chunks 等"一行多事件"的打包记录）
 *
 * 用法：
 *   node repair-session-gap.mjs scan [sessionsRoot]        # 全量体检
 *   node repair-session-gap.mjs fix <target.jsonl.zstd>     # 就地重建（去重/去gap）
 *   node repair-session-gap.mjs fix <target> --prefix <src> # 用 src 补齐丢失区间
 *
 * 原则：任何写回前先备份；写回后必须通过"seq 0..N-1 严格连续"自校验，否则不落盘。
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import zlib from "node:zlib";
import {
  decodeStorageRecord,
} from "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js";

const ZSTD_MAGIC = 4247762216; // 0xFD2FB528
const TARGET_RE = /^session\.jsonl\.zstd$/;

/** dsh 官方 scanZstdFrames 精确复刻（带 header/block/checksum 解析，不靠找 magic） */
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error(`invalid frame magic at byte ${offset}`);
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error(`reserved frame-header bit at byte ${offset - 1}`);
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error(`reserved block type at byte ${offset - 3}`);
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return { frames };
}

/** 读文件全部事件（官方解码），返回 { header, events: [{seq, type, time, raw}] }，raw 为可安全重写的 JSON 对象 */
function readLog(file) {
  const buf = fs.readFileSync(file);
  const { frames } = scanZstdFrames(buf);
  const parts = [];
  for (const f of frames) {
    parts.push(zlib.zstdDecompressSync(buf.subarray(f.start, f.end)));
  }
  const text = Buffer.concat(parts).toString("utf-8");
  const lines = text.split("\n");
  if (!lines[0]) throw new Error(`${file}: empty`);
  const header = JSON.parse(lines[0]);
  if (!header || header.type !== "session") throw new Error(`${file}: not a session header`);
  const events = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const parsed = JSON.parse(line);
    const ds = decodeStorageRecord(parsed);
    for (const e of ds) {
      if (typeof e.seq !== "number") throw new Error(`${file}: line ${i + 1} event without seq`);
      events.push(e);
    }
  }
  return { header, events, buf };
}

/** 体检：返回首处问题描述或 null */
function diagnose(events) {
  const seen = new Set();
  for (let i = 0; i < events.length; i++) {
    const s = events[i].seq;
    if (s !== i) return { kind: "gap", at: i, seq: s, msg: `expected ${i}, got ${s} at event #${i}` };
    if (seen.has(s)) return { kind: "dup", seq: s, msg: `duplicate seq ${s} at event #${i}` };
    seen.add(s);
  }
  return null;
}

function compressFrame(input) {
  return new Promise((resolve, reject) => {
    zlib.zstdCompress(input, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}

async function writeLog(file, header, events) {
  const headerLine = JSON.stringify(header) + "\n";
  const frames = [await compressFrame(Buffer.from(headerLine, "utf-8"))];
  for (let i = 0; i < events.length; i += 4000) {
    const batch = events.slice(i, i + 4000).map((e) => JSON.stringify(e)).join("\n") + "\n";
    frames.push(await compressFrame(Buffer.from(batch, "utf-8")));
  }
  const tmp = `${file}.repairing.tmp`;
  fs.writeFileSync(tmp, Buffer.concat(frames));
  fs.renameSync(tmp, file);
  return frames.length;
}

function stamp() {
  return new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
}

function walkSessions(root) {
  const out = [];
  for (const proj of fs.readdirSync(root)) {
    const projPath = path.join(root, proj);
    let stat;
    try { stat = fs.statSync(projPath); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const sess of fs.readdirSync(projPath)) {
      const dir = path.join(projPath, sess);
      let s2;
      try { s2 = fs.statSync(dir); } catch { continue; }
      if (!s2.isDirectory()) continue;
      const file = path.join(dir, "session.jsonl.zstd");
      if (fs.existsSync(file)) out.push(file);
    }
  }
  return out;
}

async function cmdRebuild(target) {
  const { header, events } = readLog(target);
  console.log(`解码事件: ${events.length} 个, max seq = ${Math.max(...events.map((e) => e.seq))}`);

  // 按 seq 首次出现去重（保留第一次写入的版本）
  const seen = new Set();
  const unique = [];
  for (const e of events) {
    if (seen.has(e.seq)) continue;
    seen.add(e.seq);
    unique.push(e);
  }
  const dropped = events.length - unique.length;
  console.log(`去重后: ${unique.length} 个 (丢弃重复 ${dropped} 个)`);
  unique.sort((a, b) => a.seq - b.seq);

  // 强制校验严格连续 seq 0..N-1
  let badAt = -1;
  for (let i = 0; i < unique.length; i++) {
    if (unique[i].seq !== i) { badAt = i; break; }
  }
  if (badAt !== -1) {
    console.error(`   ❌ 重建后仍不连续 at ${badAt}: expected ${badAt}, got ${unique[badAt].seq}；未写入任何内容`);
    process.exit(1);
  }

  const bak = `${target}.bak-rebuild-${stamp()}`;
  fs.copyFileSync(target, bak);
  const frames = await writeLog(target, header, unique);
  console.log(`   ✅ 已重建: seq 0..${unique.length - 1} (${unique.length} events, 丢弃重复 ${dropped}), ${frames} frames`);
  console.log(`   📦 原文件备份: ${bak}`);
}

async function cmdScan(root) {
  const files = walkSessions(root);
  let bad = 0;
  for (const file of files) {
    try {
      const { events } = readLog(file);
      const issue = diagnose(events);
      if (issue) {
        bad++;
        console.log(`❌ ${file}`);
        console.log(`   ${issue.msg} | events=${events.length} | seq=${issue.kind === "gap" ? issue.seq : issue.seq}`);
      }
    } catch (e) {
      bad++;
      console.log(`❌ ${file}\n   read error: ${e.message}`);
    }
  }
  console.log(`\nscanned ${files.length} session files, ${bad} broken`);
  process.exit(bad ? 1 : 0);
}

async function cmdFix(target, prefixSource) {
  const { header, events } = readLog(target);
  const issue = diagnose(events);
  if (!issue) {
    console.log(`✅ ${target} 已健康（${events.length} events, seq 0..${events.length - 1}），无需修复`);
    return;
  }

  // 前缀 = 连续 0..split-1
  let split = 0;
  while (split < events.length && events[split].seq === split) split++;
  const prefix = events.slice(0, split);
  const tail = events.slice(split);
  console.log(`🔧 ${target}`);
  console.log(`   问题: ${issue.msg}`);
  console.log(`   前缀: seq 0..${split - 1}（${prefix.length} events）`);

  // tail 内部要求自连续（去重后）
  const tailClean = [];
  for (const e of tail) {
    if (e.seq < split) continue; // 与前缀重复的丢弃
    if (tailClean.length && e.seq !== tailClean[tailClean.length - 1].seq + 1) {
      console.error(`   ❌ tail 内部也不连续（${tailClean.at(-1).seq} -> ${e.seq}）；需用 --prefix 补齐或人工处理`);
      process.exit(1);
    }
    tailClean.push(e);
  }

  let merged = [...prefix, ...tailClean];

  // 若提供 prefixSource：把 15408..26585 这类"中间丢失段"补回来
  if (prefixSource) {
    const { events: srcEvents } = readLog(prefixSource);
    const extra = srcEvents.filter((e) => e.seq >= split && e.seq < (tailClean[0] ? tailClean[0].seq : Infinity) && !merged.some((m) => m.seq === e.seq));
    if (extra.length) {
      for (let i = 0; i < extra.length; i++) {
        if (i && extra[i].seq !== extra[i - 1].seq + 1) {
          // 源里也可能有缺口，取其中的连续块：只取从 split 起连续的一段
          const cut = extra.slice(0, i);
          console.log(`   ⚠️  prefixSource 中间也非连续，仅取前 ${cut.length} 个`);
          merged = [...prefix, ...cut, ...tailClean];
          break;
        }
      }
      if (merged.length === prefix.length + tailClean.length) {
        merged = [...prefix, ...extra, ...tailClean];
      }
    }
  }

  // 最终校验
  for (let i = 0; i < merged.length; i++) {
    if (merged[i].seq !== i) {
      console.error(`   ❌ 重建后仍不连续 at ${i}: ${merged[i].seq}；未写入任何内容`);
      process.exit(1);
    }
  }

  const bak = `${target}.bak-repair-${stamp()}`;
  fs.copyFileSync(target, bak);
  const frames = await writeLog(target, header, merged);
  console.log(`   ✅ 已重建: ${merged.length} events, seq 0..${merged.length - 1}, ${frames} frames`);
  console.log(`   📦 原文件备份: ${bak}`);
}

// ---- main ----
const [,, cmd, arg, ...rest] = process.argv;
const root = arg || path.join(os.homedir(), ".dsh", "sessions");
const PL = "⚙️";

if (cmd === "scan") {
  await cmdScan(root);
} else if (cmd === "fix") {
  const prefixIdx = rest.indexOf("--prefix");
  const prefixSource = prefixIdx >= 0 ? rest[prefixIdx + 1] : undefined;
  if (prefixSource && !fs.existsSync(prefixSource)) {
    console.error(`❌ prefix source 不存在: ${prefixSource}`);
    process.exit(1);
  }
  await cmdFix(arg, prefixSource);
} else if (cmd === "rebuild") {
  if (!arg) {
    console.error("用法: node repair-session-gap.mjs rebuild <session.jsonl.zstd>");
    process.exit(1);
  }
  await cmdRebuild(arg);
} else {
  console.log(`用法:\n  node repair-session-gap.mjs scan [sessionsRoot]\n  node repair-session-gap.mjs fix <target.jsonl.zstd> [--prefix <source>]\n  node repair-session-gap.mjs rebuild <target.jsonl.zstd>   # 去重+排序+连续校验重建（适合 tail 内部也不连续的文件）`);
  process.exit(1);
}
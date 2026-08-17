#!/usr/bin/env node
/**
 * fix-renumber.mjs — 把损坏的 dsh session 日志"就地重建"：
 *  - 用官方 scanZstdFrames 精确切帧（不靠 magic 扫描）
 *  - 用官方 decodeStorageRecord 展开 packed 行
 *  - 按文件行序收集事件、按 seq 首次出现去重
 *  - 保留写入顺序，把 seq 重编号为 0..N-1 严格连续
 *  - 写回前后都做 seq 连续性自校验，失败不落盘
 * 用法: node fix-renumber.mjs <target.jsonl.zstd> [more...]
 */
import fs from "node:fs";
import zlib from "node:zlib";
import {
  decodeStorageRecord,
} from "/opt/homebrew/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js";

const ZSTD_MAGIC = 4247762216;

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

function readLog(file) {
  const buf = fs.readFileSync(file);
  const { frames } = scanZstdFrames(buf);
  const parts = [];
  for (const f of frames) parts.push(zlib.zstdDecompressSync(buf.subarray(f.start, f.end)));
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

function compressFrame(input) {
  return new Promise((resolve, reject) => {
    zlib.zstdCompress(input, { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } }, (err, result) => {
      if (err) reject(err); else resolve(result);
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

async function fix(target) {
  const { header, events } = readLog(target);
  console.log(`🔧 ${target}`);
  console.log(`   读入事件: ${events.length} 个, 原始 seq 范围 0..${Math.max(...events.map((e) => e.seq))}`);

  // 按 seq 首次出现去重（保留第一次写入的版本，保持行序）
  const seen = new Set();
  const unique = [];
  for (const e of events) {
    if (seen.has(e.seq)) continue;
    seen.add(e.seq);
    unique.push(e);
  }
  const dropped = events.length - unique.length;
  console.log(`   去重: ${dropped} 个重复 seq`);

  // 重编号为 0..N-1，保持文件写入顺序（不排序，避免打乱内容流）
  const renumbered = unique.map((e, i) => ({ ...e, seq: i }));
  const sortedOk = renumbered.every((e, i) => e.seq === i);
  if (!sortedOk) throw new Error("重编号后仍不连续，放弃");

  const bak = `${target}.bak-renumber-${stamp()}`;
  fs.copyFileSync(target, bak);
  const frames = await writeLog(target, header, renumbered);

  // 写回后自校验
  const check = readLog(target);
  const checkOk = check.events.every((e, i) => e.seq === i);
  if (!checkOk) throw new Error("写回后自校验失败（不应发生）");
  console.log(`   ✅ 已重建: seq 0..${renumbered.length - 1} (${renumbered.length} events, 去重 ${dropped}), ${frames} frames`);
  console.log(`   📦 备份: ${bak}`);
}

const targets = process.argv.slice(2);
if (!targets.length) {
  console.error("用法: node fix-renumber.mjs <target.jsonl.zstd> [...]");
  process.exit(1);
}
for (const t of targets) {
  await fix(t);
}
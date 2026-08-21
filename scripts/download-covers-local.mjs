// scripts/download-covers-local.mjs
// server.py 后台批量保存封面的 Node 快速路径（Python ThreadPool 的替代）。
// 用法（由 server.py 调用）：node download-covers-local.mjs <input.json> <coversDir>
//   input.json: [{ key, cover_url }, ...]
//   stdout 逐行输出 JSON 事件：{"type":"progress","key":"123","status":"downloaded|skipped|failed"}
//   退出码 0 表示任务整体完成（个别失败以 failed 事件上报，不触发 Python 重跑）。
// 环境变量：
//   COVER_SIZE             缩略图边长（默认 300，与 server.py COVER_SIZE 对齐）
//   COVER_DL_CONCURRENCY   并发数（默认 8）
//   COVER_DL_RETRIES       单张重试次数（默认 2）
//   STATIC_FALLBACK_BASE   静态回源基址（优先于 MC CDN，与 server.py 对齐）
import { mkdir, rename, unlink, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";

const [, , inputPath, coversDirArg] = process.argv;
if (!inputPath || !coversDirArg) {
  console.error("usage: node download-covers-local.mjs <input.json> <coversDir>");
  process.exit(2);
}

const COVER_SIZE = Number.parseInt(process.env.COVER_SIZE || "300", 10) || 300;
const CONCURRENCY = Math.max(1, Number.parseInt(process.env.COVER_DL_CONCURRENCY || "8", 10) || 8);
const RETRIES = Math.max(0, Number.parseInt(process.env.COVER_DL_RETRIES || "2", 10) || 2);
const STATIC_FALLBACK_BASE = (process.env.STATIC_FALLBACK_BASE || "").replace(/\/$/, "");
const TIMEOUT_MS = 15000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36 Edg/151.0.0.0";
const REFERER = "https://www.mcmod.cn/";

const coversDir = path.resolve(coversDirArg);
let nodes;
try {
  nodes = JSON.parse(await readFile(inputPath, "utf8"));
} catch (error) {
  console.error(`[download] cannot read input: ${error.message}`);
  process.exit(2);
}
if (!Array.isArray(nodes)) {
  console.error("[download] input is not an array");
  process.exit(2);
}

function normalizeUrl(value) {
  let url = String(value || "").trim();
  if (url.startsWith("//")) url = "https:" + url;
  return url.replace(/@\d+x\d+\.jpg$/, `@${COVER_SIZE}x${COVER_SIZE}.jpg`);
}

// 与 server.py 一致：只接受 mcmod 封面域名，避免成为开放代理
function isAllowed(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return parsed.host === "i.mcmod.cn" || parsed.host === "www.mcmod.cn";
  } catch {
    return false;
  }
}

async function exists(file) {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

function emit(key, status) {
  process.stdout.write(`${JSON.stringify({ type: "progress", key, status })}\n`);
}

async function downloadOne(node) {
  const key = String(node.key || "");
  if (!/^\d+$/.test(key)) return emit(key, "failed");
  const target = path.join(coversDir, `${key}.jpg`);
  if (await exists(target)) return emit(key, "skipped");

  const url = normalizeUrl(node.cover_url);
  const sources = [];
  if (isAllowed(url)) sources.push(url);
  if (STATIC_FALLBACK_BASE) sources.push(`${STATIC_FALLBACK_BASE}/covers/${key}.jpg`);

  for (const source of sources) {
    for (let attempt = 0; attempt <= RETRIES; attempt += 1) {
      const temp = path.join(coversDir, `.${key}.${process.pid}.${attempt}.tmp`);
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
        let resp;
        try {
          resp = await fetch(source, {
            headers: { "User-Agent": USER_AGENT, Referer: REFERER },
            signal: controller.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const type = (resp.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        const bytes = Buffer.from(await resp.arrayBuffer());
        if (bytes.length < 100 || (type && !type.startsWith("image/"))) {
          throw new Error("not an image");
        }
        await mkdir(coversDir, { recursive: true });
        await writeFile(temp, bytes);
        try {
          await unlink(target);
        } catch {
          /* 首次下载 */
        }
        await rename(temp, target);
        return emit(key, "downloaded");
      } catch (error) {
        try {
          await unlink(temp);
        } catch {
          /* 无残留 */
        }
        if (attempt < RETRIES) {
          await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
        }
      }
    }
  }
  return emit(key, "failed");
}

let cursor = 0;
await Promise.all(
  Array.from({ length: Math.min(CONCURRENCY, Math.max(1, nodes.length)) }, async () => {
    while (cursor < nodes.length) {
      await downloadOne(nodes[cursor++]);
    }
  }),
);

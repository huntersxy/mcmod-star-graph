// scripts/chunk-graph.mjs
// 部署期数据分块：把合并后的 graph.json 瘦身并切分为多个内容寻址的小文件，
// 解决单文件随数据集增长无界膨胀的问题（未来数据到 GB 级也能以 ~百KB 块加载）。
//
// 输出（写入 <outDir>）：
//   graph.json               瘦身后的完整单文件（兼容旧版前端的回退路径）
//   graph/index.json         分块索引：meta + 全部块的内容哈希列表（前端轻量复验证）
//   graph/chunks/<hash>.json 数据块：{ nodes, edges }，文件名 = 内容 SHA-1 前 16 位
//
// 分桶规则（稳定性是增量更新的关键）：
//   节点桶 = sha1(key) 高位按桶数缩放；边跟随其 source 节点的桶。
//   数据不变 → 块字节不变 → 哈希不变 → 老用户零下载；
//   局部数据变化 → 只有对应桶的块变化 → 仅重拉这些块。
//   桶数按数据量从 {64, 1024, 16384} 中选取（目标每块约 ≤1MB）；
//   升档会重排全部桶，等价于一次全量重拉（仅在数据增长 16 倍量级时发生）。
//
// 瘦身（同旧 slim-graph）：剥离前端未用字段（cover/component/density），
// x/y 坐标截断到 4 位小数。仓库根 graph.json 保持全量字段供本地开发。
// 用法：node scripts/chunk-graph.mjs <in> <outDir>
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [, , inArg, outDirArg] = process.argv;
if (!inArg || !outDirArg) {
  console.error("usage: node scripts/chunk-graph.mjs <in> <outDir>");
  process.exit(2);
}
const inPath = path.resolve(root, inArg);
const outDir = path.resolve(root, outDirArg);
const chunksDir = path.join(outDir, "graph", "chunks");

const STRIP = new Set(["cover", "component", "density"]);
const round4 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : v);

const graph = JSON.parse(await readFile(inPath, "utf8"));

const slimNode = (n) => {
  const out = {};
  for (const [k, v] of Object.entries(n)) {
    if (STRIP.has(k)) continue;
    out[k] = k === "x" || k === "y" ? round4(v) : v;
  }
  return out;
};
const nodes = (graph.nodes || []).map(slimNode);
const edges = graph.edges || [];

// ---- 选桶数：按瘦身后字节数，目标平均块 ~≤1MB ----
const slimSingle = JSON.stringify({ meta: graph.meta, nodes, edges });
const totalBytes = Buffer.byteLength(slimSingle);
const BUCKETS = totalBytes <= 64 * 1024 * 1024 ? 64 : totalBytes <= 1024 * 1024 * 1024 ? 1024 : 16384;

// 高位稳定分桶：sha1 前 4 字节 uint32 线性映射到 [0, N)
const bucketOf = (key) => {
  const h = createHash("sha1").update(String(key)).digest().readUInt32BE(0);
  return Math.min(BUCKETS - 1, Math.floor((h / 4294967296) * BUCKETS));
};

const buckets = Array.from({ length: BUCKETS }, () => ({ nodes: [], edges: [] }));
for (const n of nodes) buckets[bucketOf(n.key)].nodes.push(n);
for (const e of edges) buckets[bucketOf(e.source)].edges.push(e);

await mkdir(chunksDir, { recursive: true });

// ---- 写块（文件名 = 内容哈希，纯十六进制安全） ----
const hashes = [];
const chunkSizes = [];
for (const bucket of buckets) {
  if (!bucket.nodes.length && !bucket.edges.length) continue;
  const body = JSON.stringify({ nodes: bucket.nodes, edges: bucket.edges });
  const bytes = Buffer.from(body, "utf8");
  const hash = createHash("sha1").update(bytes).digest("hex").slice(0, 16);
  hashes.push(hash);
  chunkSizes.push(bytes.length);
  await writeFile(path.join(chunksDir, `${hash}.json`), bytes);
}

// ---- 清理未被引用的旧块（outDir 复用时避免陈旧文件累积） ----
const wanted = new Set(hashes.map((h) => `${h}.json`));
for (const name of await readdir(chunksDir)) {
  if (name.endsWith(".json") && !wanted.has(name)) {
    try { await unlink(path.join(chunksDir, name)); } catch { /* 忽略 */ }
  }
}

// ---- 索引：meta + 块哈希列表 ----
const index = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  buckets: BUCKETS,
  chunkCount: hashes.length,
  nodeCount: nodes.length,
  edgeCount: edges.length,
  chunks: hashes,
  meta: graph.meta || {},
};
await writeFile(path.join(outDir, "graph", "index.json"), JSON.stringify(index), "utf8");

// ---- 兼容旧前端的单文件回退 ----
await writeFile(path.join(outDir, "graph.json"), slimSingle, "utf8");

const avg = Math.round(chunkSizes.reduce((a, b) => a + b, 0) / Math.max(1, chunkSizes.length));
console.log(
  `[chunk] ${(totalBytes / 1048576).toFixed(2)}MB -> ${hashes.length} chunks (avg ${(avg / 1024).toFixed(0)}KB, max ${(Math.max(...chunkSizes) / 1024).toFixed(0)}KB), buckets=${BUCKETS}, ` +
    `+ graph.json (legacy) + graph/index.json -> ${path.relative(root, outDir)}`,
);

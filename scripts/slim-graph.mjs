// scripts/slim-graph.mjs
// 部署期数据瘦身：剥离前端未使用的节点字段（cover/component/density，
// 冗余或仅在合并统计时使用）并把 x/y 坐标截断到 4 位小数（世界坐标幅值
// 数千，0.0001 远低于像素精度）。仅用于 CI 组装 dist/，仓库根 graph.json
// 保留全量字段供本地开发与数据考证。
// 用法：node scripts/slim-graph.mjs <in> <out>
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [, , inArg, outArg] = process.argv;
if (!inArg || !outArg) {
  console.error("usage: node scripts/slim-graph.mjs <in> <out>");
  process.exit(2);
}
const inPath = path.resolve(root, inArg);
const outPath = path.resolve(root, outArg);

const graph = JSON.parse(await readFile(inPath, "utf8"));
const STRIP = new Set(["cover", "component", "density"]);
const round4 = (v) => (typeof v === "number" && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : v);

const nodes = (graph.nodes || []).map((n) => {
  const out = {};
  for (const [k, v] of Object.entries(n)) {
    if (STRIP.has(k)) continue;
    out[k] = k === "x" || k === "y" ? round4(v) : v;
  }
  return out;
});
const slim = { meta: graph.meta, nodes, edges: graph.edges || [] };

const before = (await readFile(inPath, "utf8")).length;
const after = JSON.stringify(slim).length;
await writeFile(outPath, JSON.stringify(slim), "utf8");
console.log(
  `[slim] ${path.relative(root, inPath)} -> ${path.relative(root, outPath)}: ` +
    `${(before / 1048576).toFixed(2)}MB -> ${(after / 1048576).toFixed(2)}MB ` +
    `(-${Math.round((1 - after / before) * 100)}%), ${nodes.length} nodes`,
);

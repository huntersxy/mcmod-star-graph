/*
 * star_graph/main.js - MC 百科星图前端
 *
 * 基于 sigma.js v3 + graphology，数据来自 graph.json / graph/chunks（GitHub Releases 分发）。
 * 封面由 CI 从 MC 百科预生成到 covers/，随站点静态发布；纯前端运行，
 * 可独立运行；检测到本地 server.py 时支持本地图数据与本地封面下载。
 *
 * 构建：npm run build（esbuild → main.bundle.js），需先 npm install。
 * 运行：任意静态服务器（python -m http.server 1119 / GitHub Pages）。
 */
import Graph from "graphology";
import Sigma from "sigma";
import { createNodeImageProgram } from "@sigma/node-image";

// 支持封面透明度淡入淡出的图像节点程序。
// sigma 使用预乘 alpha 混合（blendFunc(ONE, ONE_MINUS_SRC_ALPHA)），
// 因此颜色 RGB 必须先乘以 alpha，否则降低 alpha 会变成加色混合（变亮）而不是变透明。
// 经工厂创建并把纹理批处理去抖加长到 1500ms：每批新封面只触发一次
// 全量刷新写入图集坐标（默认 500ms 在大图上会造成周期性掉帧）。
class FadingNodeImageProgram extends createNodeImageProgram({ debounceTimeout: 1500 }) {
  getDefinition() {
    const def = super.getDefinition();
    def.FRAGMENT_SHADER_SOURCE = def.FRAGMENT_SHADER_SOURCE
      // 封面默认 alpha 取 max(texel.a, v_color.a)，会强制不透明，改成跟随 v_color.a 才能淡出
      .replace("max(texel.a, v_color.a)", "v_color.a")
      // 在裁剪前统一预乘，覆盖「无纹理 / 纹理缺失 / 正常贴图」所有分支
      .replace(
        "  #endif\n\n  // Crop in a circle when u_keepWithinCircle is truthy:",
        "  color.rgb *= v_color.a;\n  #endif\n\n  // Crop in a circle when u_keepWithinCircle is truthy:"
      );
    return def;
  }
}

// 自定义节点标签绘制：支持 \n 换行（第一行名称，第二行 class id）。
// sigma 默认只在节点右上角画单行文字，这里按行拆分并围绕节点中心垂直居中。
function drawNodeLabel(context, data, settings) {
  if (!data.label) return;
  const lines = String(data.label).split("\n");
  const size = settings.labelSize;
  const weight = settings.labelWeight;
  const color = settings.labelColor.attribute
    ? data[settings.labelColor.attribute] || settings.labelColor.color || "#000"
    : settings.labelColor.color;
  const lineHeight = size * 1.25;
  const x = data.x + data.size + 3;
  const totalHeight = lineHeight * lines.length;
  const firstBaseline = data.y - totalHeight / 2 + lineHeight / 2;
  context.font = weight + " " + size + "px " + settings.labelFont;
  context.textAlign = "left";
  context.textBaseline = "middle";

  // 半透明背景（让文字在深色图上可读）
  let maxWidth = 0;
  for (const line of lines) {
    maxWidth = Math.max(maxWidth, context.measureText(line).width);
  }
  const padX = size * 0.4;
  const padY = size * 0.25;
  const bx = x - padX;
  const by = data.y - totalHeight / 2 - padY;
  const bw = maxWidth + padX * 2;
  const bh = totalHeight + padY * 2;
  context.fillStyle = "rgba(0, 0, 0, 0.3)";
  context.fillRect(bx, by, bw, bh);

  context.fillStyle = color;
  for (let i = 0; i < lines.length; i++) {
    context.fillText(lines[i], x, firstBaseline + i * lineHeight);
  }
}

// 图数据路径固定为 graph.json；可用服务器参数 --data 映射其他文件（见 server.py）
const GRAPH_URL = "graph.json";
const GRAPH_INDEX_URL = "graph/index.json";
const GRAPH_CHUNK_CONCURRENCY = 8;
const LOCAL_SERVER_ORIGINS = ["http://127.0.0.1:1119", "http://localhost:1119"];

const PALETTE = [
  "#e6194b", "#3cb44b", "#ffe119", "#4363d8", "#f58231",
  "#911eb4", "#42d4f4", "#f032e6", "#bfef45", "#fabed4",
  "#469990", "#dcbeff", "#9a6324", "#fffac8", "#800000",
  "#aaffc3", "#808000", "#ffd8b1", "#000075", "#a9a9a9",
];

const EXTERNAL_COLOR = "#9e9e9e";
const ISOLATED_COLOR = "#d6d6d6";
const EDGE_ALPHA = 0.3;
const DEPENDENCY_EDGE_RGB = [255, 182, 193];  // 依赖：粉
const INTERACTION_EDGE_RGB = [173, 216, 230]; // 联动：浅蓝
// sigma 是预乘 alpha 混合，颜色字符串的 RGB 必须先乘 alpha，否则会变亮
function premulRgba(rgb, alpha) {
  return (
    "rgba(" +
    Math.round(rgb[0] * alpha) +
    "," +
    Math.round(rgb[1] * alpha) +
    "," +
    Math.round(rgb[2] * alpha) +
    "," +
    alpha.toFixed(4) +
    ")"
  );
}
const DEPENDENCY_EDGE_COLOR = premulRgba(DEPENDENCY_EDGE_RGB, EDGE_ALPHA);
const INTERACTION_EDGE_COLOR = premulRgba(INTERACTION_EDGE_RGB, EDGE_ALPHA);

// 2D Canvas 用直通（非预乘）alpha；WebGL 才需要预乘
function rgbaString(rgb, alpha) {
  return "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + alpha + ")";
}

// 边 LoD：ratio 越大（缩到最小）阈值越高，只留骨干边
const LOD_MAX_THRESHOLD = 50;
const LOD_FULL_ZOOM_RATIO = 0.05;
const LOD_THROTTLE_MS = 50;
const NODE_LOD_MIN_VISIBLE = 300;
const NODE_LOD_ENABLED = true;
const NODE_DIAMETER_SCREEN_RATIO = 0.1; // 跳转后节点直径占屏幕宽度的比例
const LABEL_FONT_SIZE = 14; // 导出标签字号（固定，不随节点/图幅变化）
const HIGHLIGHT_NODE_COLOR = "#ffd700"; // 六度分隔路径高亮色（节点）
const HIGHLIGHT_EDGE_RGB = [255, 215, 0]; // 六度分隔路径高亮色（边）
const HIGHLIGHT_EDGE_COLOR = premulRgba(HIGHLIGHT_EDGE_RGB, 1.0);

// 封面：CI 预生成到 covers/ 并以清单分发（纯前端静态加载，浏览器 HTTP 缓存）。
// 展示用 96px 缩略图（covers/small/）用于图上渲染，原图保留供导出。
const COVER_MANIFEST_URL = "covers/manifest.json";
const COVER_SMALL_MANIFEST_URL = "covers/small-manifest.json";
const COVER_LOAD_CONCURRENCY = 24; // 缓存解码并发；真正联网仍由网络队列串行控制
const COVER_LOAD_RETRIES = 2;
const COVER_NETWORK_INTERVAL_MS = 150; // 仅网络请求之间的间隔；缓存命中不等待

// ==================== 静态封面强缓存（Cache API） ====================
//
// 在线静态模式（GitHub Pages）下的封面持久缓存：命中时完全本地取回，
// 不向服务器发起任何请求；未命中才 fetch 并写入缓存。
// 缓存键 = 封面 URL + 版本号（v，封面来源 URL 的哈希，由 CI 写入清单）：
//   封面未变 → 键不变 → 永不重复请求；
//   封面更新 / 移除 → 键变化或清单缺失 → 启动清扫删除旧条目，按需重拉。
// 浏览器不支持 Cache API（如 file:// 协议）时自动回退为直连加载。
const STATIC_COVER_CACHE_NAME = "star-graph-static-covers-v1";
let staticCoverCachePromise = null;
const staticCoverMemo = new Map(); // 缓存键 -> Promise<objectURL>，导出时按 key 复用

function staticCoverCacheSupported() {
  return typeof caches !== "undefined" && location.protocol !== "file:";
}

function openStaticCoverCache() {
  if (!staticCoverCacheSupported()) return Promise.resolve(null);
  if (!staticCoverCachePromise) {
    staticCoverCachePromise = caches.open(STATIC_COVER_CACHE_NAME).catch(() => null);
  }
  return staticCoverCachePromise;
}

function staticCoverCacheKey(url, version) {
  return version ? url + "?v=" + encodeURIComponent(version) : url;
}

// 强缓存取图：命中 → objectURL（零网络）；未命中 → fetch 后写入缓存。
// 返回 null 表示环境不支持 Cache API，调用方回退直连。
function loadStaticCoverObjectUrl(url, version) {
  const cacheKey = staticCoverCacheKey(url, version);
  if (staticCoverMemo.has(cacheKey)) return staticCoverMemo.get(cacheKey);
  const task = (async () => {
    const cache = await openStaticCoverCache();
    if (!cache) return null;
    const cached = await cache.match(cacheKey).catch(() => null);
    if (cached) return URL.createObjectURL(await cached.blob());
    const res = await fetch(url);
    if (!res.ok) throw new Error("cover HTTP " + res.status);
    const copy = res.clone();
    const blob = await res.blob();
    try { await cache.put(cacheKey, copy); } catch { /* 配额不足等：不缓存但本次仍可用 */ }
    return URL.createObjectURL(blob);
  })();
  staticCoverMemo.set(cacheKey, task.catch((error) => {
    staticCoverMemo.delete(cacheKey);
    throw error;
  }));
  return task;
}

// 清扫与当前清单版本不一致的缓存条目（封面已更新 / 已从数据集移除）。
// 旧格式清单（无 v 字段）不清扫，避免误删。
async function sweepStaticCoverCache(coverMap) {
  const entries = [...coverMap.values()];
  if (!entries.some((entry) => entry.v)) return;
  const cache = await openStaticCoverCache();
  if (!cache) return;
  const current = new Map(); // pathname -> 期望版本
  for (const entry of entries) {
    for (const p of [entry.thumb, entry.orig]) {
      if (!p) continue;
      try { current.set(new URL(p, document.baseURI).pathname, entry.v || ""); } catch { /* 忽略非法路径 */ }
    }
  }
  const keys = await cache.keys().catch(() => []);
  for (const request of keys) {
    let parsed;
    try { parsed = new URL(request.url); } catch { continue; }
    const v = parsed.searchParams.get("v") || "";
    const want = current.get(parsed.pathname);
    if (want === undefined || want !== v) cache.delete(request).catch(() => {});
  }
}

function communityColor(community, type) {
  if (type === "external") return EXTERNAL_COLOR;
  if (community < 0) return ISOLATED_COLOR;
  return PALETTE[community % PALETTE.length];
}

function nodeSize(inDegree, type) {
  // 半径 = 2 + sqrt(被依赖次数)，面积正比于评分
  const d = Math.max(0, inDegree || 0);
  const s = 2 + Math.sqrt(d);
  return type === "external" ? Math.min(s, 10) : Math.min(s, 48);
}

function formatNum(n) {
  if (n >= 10000) return (n / 10000).toFixed(1) + "万";
  return String(n);
}

function formatDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + "s";
  const m = Math.floor(s / 60);
  const r = s % 60;
  return m + "m" + r + "s";
}

function renderMetaPanel(meta) {
  const el = document.getElementById("panel-meta");
  if (!el || !meta) return;
  const rows = [
    ["标题", meta.title],
    ["节点", meta.node_count],
    ["边", meta.edge_count],
    ["核心节点", meta.core_node_count],
    ["依赖边", meta.dependency_edges],
    ["联动边", meta.interaction_edges],
    ["社区", meta.community_count],
    ["连通分量", meta.component_count],
    ["生成时间", meta.generated_at],
  ].filter((row) => row[1] != null && row[1] !== "");
  const html = '<div class="meta-title">图元数据</div>' +
    rows.map((row) => '<div class="meta-row"><span>' + row[0] + '</span><b>' + String(row[1]) + '</b></div>').join("");
  el.innerHTML = html;
}

// 站点标题跟随数据集标题（数据 meta 的 title），避免 HTML 静态文案与
// 实际加载的数据不一致；meta 缺失时保留 index.html 的静态默认值。
function applyDataTitle(meta) {
  const title = meta && meta.title;
  if (!title) return;
  document.title = title;
  const el = document.querySelector(".panel-title");
  if (el) el.textContent = title;
}

function edgeColorFor(rgb, alpha) {
  return premulRgba(rgb, EDGE_ALPHA * alpha);
}

function hexToRgba(hex, alpha, premul) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const rr = premul ? Math.round(r * alpha) : r;
  const gg = premul ? Math.round(g * alpha) : g;
  const bb = premul ? Math.round(b * alpha) : b;
  return "rgba(" + rr + "," + gg + "," + bb + "," + alpha.toFixed(4) + ")";
}

async function loadGraph(source = null) {
  const url = source ? `${source.base}/graph.json` : GRAPH_URL;
  // no-cache：允许 ETag 304 复验证（GitHub Pages 支持），重复访问免整包重下
  const res = await fetch(url, { cache: "no-cache" });
  if (!res.ok) throw new Error("加载 graph.json 失败: " + res.status);
  return res.json();
}

// ==================== 图数据分块加载（内容寻址强缓存） ====================
//
// CI 把合并图切分为多个小文件（graph/chunks/<hash>.json，文件名 = 内容哈希）
// 并输出轻量索引 graph/index.json。加载策略与封面强缓存一致：
//   索引 → no-cache 复验证（1 个轻量请求，感知数据更新）；
//   数据块 → Cache API 按哈希强缓存，命中零网络请求；
//   数据局部变化 → 只有哈希变化的块需要重拉。
// 索引不存在（旧版部署）时回退单文件 graph.json。
const GRAPH_DATA_CACHE_NAME = "star-graph-data-v1";
let graphDataCachePromise = null;
const graphChunkMemo = new Map(); // 块哈希 -> Promise<解析后的块数据>

function openGraphDataCache() {
  if (!staticCoverCacheSupported()) return Promise.resolve(null);
  if (!graphDataCachePromise) {
    graphDataCachePromise = caches.open(GRAPH_DATA_CACHE_NAME).catch(() => null);
  }
  return graphDataCachePromise;
}

function graphChunkUrl(hash) {
  return new URL(`graph/chunks/${hash}.json`, document.baseURI).href;
}

function loadGraphChunk(hash) {
  if (graphChunkMemo.has(hash)) return graphChunkMemo.get(hash);
  const url = graphChunkUrl(hash);
  const task = (async () => {
    const cache = await openGraphDataCache();
    if (cache) {
      const hit = await cache.match(url).catch(() => null);
      if (hit) return hit.json();
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error("chunk " + hash + " HTTP " + res.status);
    const copy = res.clone();
    const data = await res.json();
    if (cache) {
      try { await cache.put(url, copy); } catch { /* 配额不足等：不缓存但本次仍可用 */ }
    }
    return data;
  })();
  graphChunkMemo.set(hash, task.catch((error) => {
    graphChunkMemo.delete(hash);
    throw error;
  }));
  return task;
}

// 清扫索引中已不存在的块（数据集缩减 / 分桶升档后的陈旧条目）
async function sweepGraphChunkCache(index) {
  const cache = await openGraphDataCache();
  if (!cache) return;
  const wanted = new Set((index.chunks || []).map(graphChunkUrl));
  const keys = await cache.keys().catch(() => []);
  for (const request of keys) {
    if (!wanted.has(request.url)) cache.delete(request).catch(() => {});
  }
}

// 返回合并后的 { meta, nodes, edges }；索引不可用时返回 null（调用方回退单文件）
async function loadChunkedGraph(onProgress) {
  const res = await fetch(GRAPH_INDEX_URL, { cache: "no-cache" });
  if (!res.ok) return null;
  const index = await res.json();
  if (!index || !Array.isArray(index.chunks) || !index.chunks.length) return null;
  sweepGraphChunkCache(index); // 异步清扫，不阻塞加载

  const nodes = [];
  const edges = [];
  const seenNode = new Set();
  const seenEdge = new Set();
  const hashes = index.chunks;
  let cursor = 0;
  let done = 0;
  async function worker() {
    while (cursor < hashes.length) {
      const chunk = await loadGraphChunk(hashes[cursor++]);
      for (const n of chunk.nodes || []) {
        const k = String(n.key);
        if (!seenNode.has(k)) { seenNode.add(k); nodes.push(n); }
      }
      for (const e of chunk.edges || []) {
        const id = e.source + "\u0000" + e.target + "\u0000" + e.type;
        if (!seenEdge.has(id)) { seenEdge.add(id); edges.push(e); }
      }
      done += 1;
      if (onProgress) onProgress(done, hashes.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(GRAPH_CHUNK_CONCURRENCY, hashes.length) }, worker));
  return { meta: index.meta || {}, nodes, edges };
}

function normalizeCoverUrl(value) {
  let url = String(value || "").trim();
  if (url.startsWith("//")) url = "https:" + url;
  return url;
}

async function loadExistingLocalCovers(source) {
  try {
    const res = await fetch(`${source.base}/cover_download/existing`, { mode: "cors", cache: "no-store" });
    if (!res.ok) throw new Error(`existing covers: ${res.status}`);
    const data = await res.json();
    const keys = Array.isArray(data.keys) ? data.keys.map(String) : [];
    const map = new Map(keys.map((key) => [key, {
      thumb: `${source.base}/covers/${key}.jpg`,
      orig: `${source.base}/covers/${key}.jpg`,
    }]));
    return { count: keys.length, keys, map };
  } catch {
    const map = await loadCoverManifest(source.base);
    return { count: map.size, keys: [...map.keys()], map };
  }
}

function buildLocalCoverMap(data, source, existingKeys = new Set()) {
  const map = new Map();
  for (const node of data.nodes || []) {
    if (node.type !== "core" || !node.cover_url) continue;
    const key = String(node.key);
    const url = normalizeCoverUrl(node.cover_url);
    const proxy = `${source.base}/cover_proxy?key=${encodeURIComponent(key)}&url=${encodeURIComponent(url)}`;
    // 本地模式统一走 proxy；已有文件仍走 proxy，但不占用联网限速队列。
    map.set(key, { thumb: proxy, orig: proxy, local: existingKeys.has(key) });
  }
  return map;
}

const UPSTREAM_COVER_DB = "mcmod-graph-covers";
const UPSTREAM_COVER_STORE = "covers";
const UPSTREAM_COVER_CONCURRENCY = 20;
const UPSTREAM_COVER_INTERVAL_MS = 200;
const UPSTREAM_COVER_RETRIES = 2;

function openUpstreamCoverDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(UPSTREAM_COVER_DB, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(UPSTREAM_COVER_STORE)) {
        request.result.createObjectStore(UPSTREAM_COVER_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function upstreamCoverGet(db, key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(UPSTREAM_COVER_STORE, "readonly").objectStore(UPSTREAM_COVER_STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function upstreamCoverPut(db, key, blob) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(UPSTREAM_COVER_STORE, "readwrite").objectStore(UPSTREAM_COVER_STORE).put(blob, key);
    request.onsuccess = resolve;
    request.onerror = () => reject(request.error);
  });
}

function upstreamCoverClear(db) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(UPSTREAM_COVER_STORE, "readwrite");
    tx.objectStore(UPSTREAM_COVER_STORE).clear();
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function loadUpstreamCachedCovers(db, items) {
  const map = new Map();
  for (const item of items) {
    const blob = await upstreamCoverGet(db, item.key).catch(() => null);
    if (blob) map.set(String(item.key), URL.createObjectURL(blob));
  }
  return map;
}

async function downloadUpstreamCovers(db, items, onProgress) {
  let cursor = 0;
  let done = 0;
  let failed = 0;
  const failedItems = [];
  async function worker() {
    while (cursor < items.length) {
      const item = items[cursor++];
      let ok = false;
      for (let attempt = 0; attempt <= UPSTREAM_COVER_RETRIES && !ok; attempt++) {
        try {
          const response = await fetch(`${item.proxyBase}/cover_proxy?url=${encodeURIComponent(item.url)}`, { cache: "no-store" });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          await upstreamCoverPut(db, item.key, await response.blob());
          ok = true;
        } catch {
          if (attempt < UPSTREAM_COVER_RETRIES) await new Promise((resolve) => setTimeout(resolve, 300 * (attempt + 1)));
        }
      }
      if (!ok) { failed += 1; failedItems.push(item); }
      done += 1;
      if (onProgress) onProgress(done, items.length, failed);
      await new Promise((resolve) => setTimeout(resolve, UPSTREAM_COVER_INTERVAL_MS));
    }
  }
  await Promise.all(Array.from({ length: Math.min(UPSTREAM_COVER_CONCURRENCY, Math.max(1, items.length)) }, worker));
  return { failed, failedItems };
}

function showUpstreamCoverModal(db, items, cachedMap) {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.className = "cover-modal";
    modal.innerHTML = `
      <div class="cover-box" role="dialog" aria-modal="true">
        <div class="cover-head"><span class="cover-title"></span><button class="cover-close" type="button">×</button></div>
        <div class="cover-desc"></div>
        <div class="cover-progress hidden"><div class="cover-track"><div class="cover-fill"></div></div><div class="cover-label"></div></div>
        <div class="cover-actions"><button class="cover-btn primary" type="button"></button><button class="cover-btn ghost hidden" type="button"></button></div>
      </div>`;
    document.body.appendChild(modal);
    const title = modal.querySelector(".cover-title");
    const desc = modal.querySelector(".cover-desc");
    const progress = modal.querySelector(".cover-progress");
    const fill = modal.querySelector(".cover-fill");
    const label = modal.querySelector(".cover-label");
    const primary = modal.querySelector(".cover-btn.primary");
    const retry = modal.querySelector(".cover-btn.ghost");
    const close = modal.querySelector(".cover-close");
    const pending = items.filter((item) => !cachedMap.has(String(item.key)));
    let failedItems = [];
    let state = "confirm";
    const finish = () => { modal.remove(); resolve(cachedMap); };
    const render = () => {
      progress.classList.toggle("hidden", state !== "downloading");
      retry.classList.toggle("hidden", state !== "failed");
      close.classList.toggle("hidden", state !== "confirm");
      if (state === "confirm") { title.textContent = "下载封面"; desc.textContent = `上游模式需要缓存 ${pending.length} 张封面到浏览器 IndexedDB。`; primary.textContent = "确定下载"; }
      if (state === "downloading") { title.textContent = "正在下载封面"; desc.textContent = "下载完成后进入星图。"; primary.classList.add("hidden"); }
      if (state === "failed") { title.textContent = "部分封面下载失败"; desc.textContent = `${failedItems.length} 张失败，可重试或进入图。`; primary.textContent = "进入图"; primary.classList.remove("hidden"); retry.textContent = "重试失败项"; }
    };
    const start = async (list) => {
      state = "downloading"; primary.classList.add("hidden"); render();
      const result = await downloadUpstreamCovers(db, list, (done, total, failed) => {
        fill.style.width = `${Math.round(done / Math.max(1, total) * 100)}%`;
        label.textContent = `已下载 ${done} / ${total} · 失败 ${failed}`;
      });
      failedItems = result.failedItems;
      if (failedItems.length) { state = "failed"; primary.classList.remove("hidden"); render(); }
      else finish();
    };
    primary.addEventListener("click", () => state === "confirm" ? start(pending) : finish());
    retry.addEventListener("click", () => start(failedItems));
    close.addEventListener("click", () => { state = "failed"; failedItems = pending; render(); });
    render();
  });
}

async function loadUpstreamCoverMap(data, source) {
  const items = (data.nodes || []).filter((node) => node.type === "core" && node.cover_url).map((node) => ({
    key: String(node.key), url: normalizeCoverUrl(node.cover_url), proxyBase: source.base,
  }));
  const db = await openUpstreamCoverDB();
  try {
    const clean = await fetch(`${source.base}/clean`, { cache: "no-store" }).then((res) => res.ok ? res.json() : { clean: false }).catch(() => ({ clean: false }));
    if (clean.clean) await upstreamCoverClear(db);
  } catch { /* ignore clean probe */ }
  const cached = await loadUpstreamCachedCovers(db, items);
  if (cached.size < items.length) await showUpstreamCoverModal(db, items, cached);
  return cached;
}

async function detectLocalServer() {
  const origins = [];
  if ((location.hostname === "127.0.0.1" || location.hostname === "localhost") && location.origin !== "null") {
    origins.push(location.origin);
  }
  for (const base of LOCAL_SERVER_ORIGINS) {
    if (!origins.includes(base)) origins.push(base);
  }
  for (const base of origins) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 900);
    try {
      const res = await fetch(`${base}/health`, {
        cache: "no-store",
        mode: "cors",
        signal: controller.signal,
      });
      if (res.ok) {
        const body = await res.json().catch(() => ({}));
        if (body.service === "star-graph-server" || body.ok === true) {
          clearTimeout(timer);
          return { base, mode: body.mode === "upstream" ? "upstream" : "enhanced" };
        }
      }
    } catch {
      // 本地 server.py 未运行或当前页面无法访问 localhost，继续尝试下一个地址。
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

// ==================== 封面：CI 预生成 + 静态加载 ====================
//
// 纯前端运行：封面由 CI 下载到 covers/（原图）并生成 covers/small/ 缩略图，
// 以清单索引，随站点静态发布（浏览器 HTTP 缓存）。
// 图上统一使用缩略图（WebGL 纹理内存约 1/16），导出大图用原图。
// 清单缺失时回退为纯色节点。
async function loadCoverManifest(base = "") {
  const map = new Map();
  const root = String(base || "").replace(/\/$/, "");
  const smallUrl = root ? `${root}/covers/small-manifest.json` : COVER_SMALL_MANIFEST_URL;
  const normalUrl = root ? `${root}/covers/manifest.json` : COVER_MANIFEST_URL;
  const pathFor = (value) => {
    const path = String(value || "").replace(/^\/+/, "");
    return root ? `${root}/${path}` : path;
  };
  let data = null;
  try {
    const res = await fetch(smallUrl, { cache: "no-cache" });
    if (res.ok) data = await res.json();
  } catch (e) { /* 回退到普通清单 */ }
  if (!data) {
    try {
      const res = await fetch(normalUrl, { cache: "no-cache" });
      if (res.ok) data = await res.json();
    } catch (e) {
      // 清单不存在时由调用方决定是否继续下载或使用纯色节点。
    }
  }
  if (!data) return map;
  const keys = Array.isArray(data) ? data : data.keys;
  const items = data && typeof data.items === "object" ? data.items : {};
  for (const key of Array.isArray(keys) ? keys : []) {
    const k = String(key);
    const it = items[k] || {};
    map.set(k, {
      thumb: pathFor(it.path || `covers/small/${k}.png`),
      orig: pathFor(it.orig || `covers/${k}.jpg`),
      v: it.v || null, // CI 写入的封面版本（来源 URL 哈希），驱动强缓存失效
    });
  }
  return map;
}

// 节点的展示缩略图与原图路径（无封面返回 null）
function coverPaths(node, coverMap) {
  return coverMap.get(String(node.key)) || null;
}

// 图片加载：线上静态图使用浏览器自身缓存；本地模式的 proxy 请求由
// main.js 串行调度，server.py 负责返回本地文件或下载并保存。
let coverNetworkTail = Promise.resolve();
let nextCoverNetworkTime = 0;

function runCoverNetworkTask(task) {
  const run = coverNetworkTail.then(async () => {
    const wait = Math.max(0, nextCoverNetworkTime - performance.now());
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    nextCoverNetworkTime = performance.now() + COVER_NETWORK_INTERVAL_MS;
    return task();
  });
  coverNetworkTail = run.catch(() => {});
  return run;
}

function waitForImageSource(source) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.decoding = "async";
    image.onload = resolve;
    image.onerror = () => reject(new Error("image decode failed"));
    image.src = source;
  });
}

async function loadCoverImageSource(source, localCover = false, version = null) {
  const url = new URL(source, document.baseURI).href;
  if (version) {
    // 静态封面：Cache API 强缓存优先，命中零网络请求
    const objectUrl = await loadStaticCoverObjectUrl(url, version);
    if (objectUrl) {
      // blob 本地解码校验，统一错误/重试路径（不产生网络请求）
      await waitForImageSource(objectUrl);
      return objectUrl;
    }
  }
  const isLocalProxy = new URL(url).pathname === "/cover_proxy";
  if (isLocalProxy && !localCover) {
    // 只有缺失本地文件、确实可能访问上游时才进入联网限速队列。
    await runCoverNetworkTask(() => waitForImageSource(url));
    return url;
  }
  await waitForImageSource(url);
  return url;
}

async function loadCoverObjectUrlWithRetry(source, localCover = false, version = null) {
  for (let attempt = 0; attempt <= COVER_LOAD_RETRIES; attempt++) {
    try {
      return await loadCoverImageSource(source, localCover, version);
    } catch (error) {
      if (attempt >= COVER_LOAD_RETRIES) throw error;
      await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
    }
  }
  return null;
}

async function cleanupLegacyServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    if ("caches" in window) {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => key.startsWith("star-graph-covers-")).map((key) => caches.delete(key)));
    }
  } catch {
    // 清理失败不影响正常图片加载。
  }
}

function buildGraph(data, coverMap, eagerImages = false) {
  const graph = new Graph({ multi: true });
  const labelIndex = new Map(); // lowercase name -> [keys]
  const degMap = new Map();

  for (const n of data.nodes) {
    degMap.set(n.key, n.in_degree);
    const isCore = n.type === "core";
    const cover = isCore ? coverPaths(n, coverMap) : null;
    graph.addNode(n.key, {
      x: typeof n.x === "number" ? n.x : Math.random() * 100,
      y: typeof n.y === "number" ? n.y : Math.random() * 100,
      size: nodeSize(n.in_degree, n.type),
      color: communityColor(n.community, n.type),
      label: n.label + "\nclass " + n.key,
      name: n.label,
      name_en: n.name_en,
      description: n.description,
      kind: n.type,
      // 初始只保留封面 URL；节点进入视口并由调度器加载成功后才切换 image。
      // 已加载节点不会被切回 circle，因此离开/重新进入视口不会重复请求。
      // 封面节点从一开始就是 image 类型：无图时 shader 自动回退为纯色圆
      // （v_texture.w <= 0 分支），封面就绪后只更新 image 属性。这样避免
      // circle→image 的渲染程序切换，封面批次才能走廉价的局部刷新。
      type: cover ? "image" : "circle",
      image: eagerImages && cover ? cover.thumb : null,
      thumb: cover ? cover.thumb : null,
      imageSrc: cover ? cover.orig : null, // 原图（导出大图用）
      coverV: cover ? (cover.v || null) : null, // 封面版本（CI 清单），静态强缓存键
      localCover: !!(cover && cover.local),
      views: n.views,
      favorites: n.favorites,
      category: n.category,
      status: n.status,
      in_degree: n.in_degree,
      out_degree: n.out_degree,
      pagerank: n.pagerank,
      community: n.community,
      rank: n.rank,
    });
    if (n.label) {
      const k = n.label.toLowerCase();
      if (!labelIndex.has(k)) labelIndex.set(k, []);
      labelIndex.get(k).push(n.key);
    }
  }

  for (const e of data.edges) {
    const importance = Math.min(degMap.get(e.source) || 0, degMap.get(e.target) || 0);
    const kind = e.type === "interaction" ? "interaction" : "dependency";
    const rgb = kind === "interaction" ? INTERACTION_EDGE_RGB : DEPENDENCY_EDGE_RGB;
    graph.addEdge(e.source, e.target, {
      size: 0.5,
      color: kind === "interaction" ? INTERACTION_EDGE_COLOR : DEPENDENCY_EDGE_COLOR,
      type: "line",
      kind,
      rgb,
      importance,
      group_name: e.group_name || "",
    });
  }

  return { graph, data, labelIndex };
}

function buildSearch(data) {
  const index = new Map();
  const add = (term, n) => {
    if (!term) return;
    const k = term.toLowerCase();
    if (!index.has(k)) index.set(k, new Set());
    index.get(k).add(n);
  };
  for (const n of data.nodes) {
    add(n.label, n);
    add(n.name_en, n);
    add(n.key, n);
  }
  return index;
}

function buildPagination(pageCount, current, onPage) {
  const wrap = document.createElement("div");
  wrap.className = "pagination";

  const prev = document.createElement("button");
  prev.textContent = "上一页";
  prev.disabled = current <= 0;
  prev.addEventListener("click", (e) => {
    e.stopPropagation();
    if (current > 0) onPage(current - 1);
  });

  const info = document.createElement("span");
  info.textContent = (current + 1) + " / " + pageCount;

  const next = document.createElement("button");
  next.textContent = "下一页";
  next.disabled = current >= pageCount - 1;
  next.addEventListener("click", (e) => {
    e.stopPropagation();
    if (current < pageCount - 1) onPage(current + 1);
  });

  wrap.appendChild(prev);
  wrap.appendChild(info);
  wrap.appendChild(next);
  return wrap;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes, start, end) {
  let c = 0xFFFFFFFF;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const len = data.length;
  const out = new Uint8Array(len + 12);
  const view = new DataView(out.buffer);
  view.setUint32(0, len);
  out[4] = type.charCodeAt(0);
  out[5] = type.charCodeAt(1);
  out[6] = type.charCodeAt(2);
  out[7] = type.charCodeAt(3);
  out.set(data, 8);
  view.setUint32(8 + len, crc32(out, 4, 8 + len));
  return out;
}

async function encodePNG(width, height, getScanlines) {
  const parts = [new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])];

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;   // 位深
  ihdr[9] = 6;   // RGBA
  ihdr[10] = 0;  // 压缩
  ihdr[11] = 0;  // 过滤
  ihdr[12] = 0;  // 隔行
  parts.push(pngChunk("IHDR", ihdr));

  const cs = new CompressionStream("deflate");
  const writer = cs.writable.getWriter();
  const reader = cs.readable.getReader();

  const producer = (async () => {
    for await (const row of getScanlines()) {
      await writer.write(row);
    }
    await writer.close();
  })();

  const consumer = (async () => {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value && value.length) parts.push(pngChunk("IDAT", value));
    }
  })();

  await Promise.all([producer, consumer]);
  parts.push(pngChunk("IEND", new Uint8Array(0)));
  return new Blob(parts, { type: "image/png" });
}

let coverDownloadToast = null;

function updateCoverDownloadProgress(job) {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.setAttribute("aria-live", "polite");
    document.body.appendChild(container);
  }
  if (!coverDownloadToast) {
    coverDownloadToast = document.createElement("div");
    coverDownloadToast.className = "toast toast-progress toast-success toast-visible";
    coverDownloadToast.innerHTML = '<div class="toast-progress-text"></div><div class="toast-progress-track"><div class="toast-progress-fill"></div></div>';
    container.appendChild(coverDownloadToast);
  }
  const total = Math.max(1, Number(job.total) || 1);
  const done = Math.min(total, Number(job.done) || 0);
  const pct = Math.round((done / total) * 100);
  const downloaded = Number(job.downloaded) || 0;
  const skipped = Number(job.skipped) || 0;
  const failed = Number(job.failed) || 0;
  coverDownloadToast.querySelector(".toast-progress-text").textContent =
    `正在保存本地封面 ${done} / ${total}（${pct}%） · 成功 ${downloaded} · 已存在 ${skipped} · 失败 ${failed}`;
  coverDownloadToast.querySelector(".toast-progress-fill").style.width = `${pct}%`;
}

function finishCoverDownloadProgress(message, kind = "success") {
  if (!coverDownloadToast) return;
  coverDownloadToast.className = `toast toast-progress toast-${kind} toast-visible`;
  coverDownloadToast.querySelector(".toast-progress-text").textContent = message;
  coverDownloadToast.querySelector(".toast-progress-fill").style.width = "100%";
  const toast = coverDownloadToast;
  coverDownloadToast = null;
  setTimeout(() => {
    toast.classList.remove("toast-visible");
    setTimeout(() => toast.remove(), 300);
  }, 1800);
}

function askLocalCoverDownload(existingCount, totalCount) {
  return new Promise((resolve) => {
    const modal = document.createElement("div");
    modal.className = "cover-modal";
    modal.innerHTML = `
      <div class="cover-box" role="dialog" aria-modal="true" aria-labelledby="cover-download-title">
        <div class="cover-head">
          <div class="cover-title" id="cover-download-title">保存本地封面</div>
          <button class="cover-close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="cover-desc">
          已连接本地 server.py。焦点节点会继续通过反代懒加载，成功加载的封面会自动保存到本地。<br>
          是否同时后台保存全部封面？已有 ${existingCount} 张，最多处理 ${totalCount} 张。下载不会阻塞节点图。
        </div>
        <div class="cover-actions">
          <button class="cover-btn ghost" data-action="cancel" type="button">暂不保存</button>
          <button class="cover-btn primary" data-action="download" type="button">后台保存</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    const close = (value) => { modal.remove(); resolve(value); };
    modal.querySelector("[data-action=cancel]").addEventListener("click", () => close(false));
    modal.querySelector("[data-action=download]").addEventListener("click", () => close(true));
    modal.querySelector(".cover-close").addEventListener("click", () => close(false));
  });
}

async function downloadLocalCovers(data, source, orderedNodes = null) {
  const nodes = (orderedNodes || data.nodes || [])
    .filter((node) => node.type === "core" && node.cover_url)
    .map((node) => ({ key: String(node.key), cover_url: node.cover_url }));
  if (!nodes.length) return;
  const response = await fetch(`${source.base}/cover_download/start`, {
    method: "POST", mode: "cors", cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ nodes }),
  });
  if (!response.ok) throw new Error(`启动本地保存失败：${response.status}`);
  const started = await response.json();
  updateCoverDownloadProgress(started);
  let job = started;
  let cursor = Number(started.ready_cursor) || 0;
  while (job.status === "running") {
    await new Promise((resolve) => setTimeout(resolve, 350));
    const status = await fetch(`${source.base}/cover_download/status?id=${encodeURIComponent(started.id)}&since=${cursor}`, { mode: "cors", cache: "no-store" });
    if (!status.ok) throw new Error(`读取本地保存进度失败：${status.status}`);
    job = await status.json();
    cursor = Number(job.ready_cursor) || cursor;
    updateCoverDownloadProgress(job);
  }
  if (job.status !== "done") throw new Error("本地保存失败");
  finishCoverDownloadProgress(`本地封面保存完成：${job.downloaded} 新增，${job.skipped} 已存在，${job.failed} 失败`);
}

function showToast(message, kind = "warning") {
  let container = document.getElementById("toast-container");
  if (!container) {
    container = document.createElement("div");
    container.id = "toast-container";
    container.setAttribute("aria-live", "polite");
    document.body.appendChild(container);
  }
  const toast = document.createElement("div");
  toast.className = `toast toast-${kind}`;
  toast.textContent = message;
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast-visible"));
  setTimeout(() => {
    toast.classList.remove("toast-visible");
    setTimeout(() => toast.remove(), 300);
  }, 5000);
}

function main() {
  const container = document.getElementById("container");
  const statusEl = document.getElementById("status");
  const tooltipEl = document.getElementById("tooltip");
  const contextMenu = document.getElementById("context-menu");
  const searchInput = document.getElementById("search-input");
  const searchResults = document.getElementById("search-results");
  const searchList = document.getElementById("search-list");
  const searchPagination = document.getElementById("search-pagination");
  const statusText = document.getElementById("status-text");
  const progressFill = document.getElementById("progress-fill");
  const progressLabel = document.getElementById("progress-label");
  const lodSlider = document.getElementById("lod-slider");
  const lodValue = document.getElementById("lod-value");
  const edgeLodSlider = document.getElementById("edge-lod-slider");
  const edgeLodValue = document.getElementById("edge-lod-value");
  const panel = document.getElementById("panel");
  const panelToggle = document.getElementById("panel-toggle");
  const edgeDependency = document.getElementById("edge-dependency");
  const edgeInteraction = document.getElementById("edge-interaction");
  const showLabels = document.getElementById("show-labels");
  const exportWidth = document.getElementById("export-width");
  const exportHeight = document.getElementById("export-height");
  const exportButton = document.getElementById("export-button");
  const exportWarning = document.getElementById("export-warning");

  let renderer = null;
  let graph = null;
  let searchIndex = null;
  let lodThresholdValue = 0;
  let lodTimer = null;
  let culledEdges = new Set();
  let outOfViewNodes = new Set();
  // 隐藏项的 reducer 结果缓存：全量刷新时绝大多数节点/边处于隐藏态，
  // 逐项展开新对象会造成每次刷新 ~9 万次对象分配的 GC 风暴。隐藏项不
  // 渲染，且节点渲染类型恒定（封面节点始终 image、无图回退纯色），
  // 复用同一对象安全。
  const hiddenNodeData = new Map();
  const hiddenEdgeData = new Map();
  let nodeVisibleCount = 0;
  let edgeAlpha = new Map();
  let nodeAlpha = new Map();
  let fadeTimer = null;
  let searchMatches = [];
  let searchPage = 0;
  let allNodes = [];
  let nodeLodStrength = 1;
  let edgeLodStrength = 1;
  let showDependency = true;
  let showInteraction = true;
  let highlightNodes = new Set();
  let highlightEdges = new Set();

  function setProgress(pct, text, label) {
    statusText.textContent = text;
    progressFill.style.width = Math.max(0, Math.min(100, pct)) + "%";
    progressLabel.textContent = label || "";
  }

  // ?fps=1 调试 HUD：滚动 FPS 与最差帧耗时（验证渲染流畅度用）
  if (/[?&]fps=1\b/.test(location.search)) {
    const hud = document.createElement("div");
    hud.id = "fps-hud";
    hud.style.cssText =
      "position:fixed;left:8px;bottom:8px;z-index:9999;background:rgba(0,0,0,.75);" +
      "color:#7CFC00;font:12px/1.4 monospace;padding:4px 8px;border-radius:4px;pointer-events:none;";
    hud.textContent = "FPS --";
    document.body.appendChild(hud);
    let frames = 0;
    let worst = 0;
    let last = performance.now();
    let prev = last;
    const tick = (now) => {
      frames += 1;
      worst = Math.max(worst, now - prev);
      prev = now;
      if (now - last >= 500) {
        hud.textContent = "FPS " + Math.round((frames * 1000) / (now - last)) + " · worst " + Math.round(worst) + "ms";
        frames = 0;
        worst = 0;
        last = now;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  function finishLoading() {
    statusEl.classList.add("fade-out");
    const onEnd = () => {
      statusEl.style.display = "none";
      statusEl.removeEventListener("transitionend", onEnd);
    };
    statusEl.addEventListener("transitionend", onEnd);
    // 兜底：个别环境可能不触发 transitionend
    setTimeout(() => {
      if (statusEl.style.display !== "none") statusEl.style.display = "none";
    }, 700);
  }

  async function boot(localServerOverride = null) {
    const localServer = localServerOverride || await detectLocalServer();
    let data;
    let coverMap;
    let eagerImages = false;
    let localDownloadContext = null;
    if (localServer) {
      showToast("已连接本地 server.py，使用本地图数据。", "success");
      setProgress(5, "加载本地图数据……", localServer.base + "/graph.json");
      try {
        data = await loadGraph(localServer);
      } catch (error) {
        showToast("本地 server.py 数据加载失败，已回退在线数据。", "warning");
        data = await loadGraph();
        setProgress(10, "加载静态封面清单……", "covers/manifest.json");
        coverMap = await loadCoverManifest();
        sweepStaticCoverCache(coverMap);
      }
      if (!coverMap) {
        if (localServer.mode === "upstream") {
          // 上游模式：IndexedDB + 反代一次性准备 Blob URL，再进入图。
          const blobMap = await loadUpstreamCoverMap(data, localServer);
          coverMap = new Map([...blobMap].map(([key, blobUrl]) => [key, { thumb: blobUrl, orig: blobUrl }]));
          eagerImages = true;
        } else {
          const existingLocal = await loadExistingLocalCovers(localServer);
          coverMap = buildLocalCoverMap(data, localServer, new Set(existingLocal.keys));
          localDownloadContext = { data, source: localServer, existingCount: existingLocal.count };
        }
      }
    } else {
      showToast("未连接本地 server.py，使用在线静态数据。", "warning");
      setProgress(5, "加载在线数据……", GRAPH_URL);
      // 分块优先：索引复验证 + 内容寻址块强缓存；旧版部署回退单文件
      try {
        data = await loadChunkedGraph((done, total) => {
          setProgress(5 + Math.round((done / total) * 60), "加载数据块 " + done + " / " + total + "……", "graph/chunks/");
        });
      } catch (error) {
        data = null; // 个别块下载失败时回退单文件路径
      }
      if (!data) data = await loadGraph();
      setProgress(70, "加载静态封面清单……", "covers/manifest.json");
      await new Promise((r) => setTimeout(r, 30));
      // 封面：CI 预生成后随站点静态发布；清单缺失时回退为纯色节点。
      coverMap = await loadCoverManifest();
      sweepStaticCoverCache(coverMap);
    }
    renderMetaPanel(data.meta);
    applyDataTitle(data.meta);
    setProgress(20, coverMap.size
      ? "构建图结构……"
      : "未找到封面，使用纯色节点……", coverMap.size + " 张封面已就绪");
    await new Promise((r) => setTimeout(r, 30));

    const built = buildGraph(data, coverMap, eagerImages);
    graph = built.graph;
    searchIndex = buildSearch(data);
    allNodes = [...data.nodes].sort((a, b) => (b.views || 0) - (a.views || 0));
    searchMatches = [...allNodes];
    searchPage = 0;
    renderSearchResults();

    setProgress(100, "渲染中……", "");
    await new Promise((r) => setTimeout(r, 30));

    renderer = new Sigma(graph, container, {
      renderLabels: true,
      renderEdgeLabels: false,
      // 拖动/缩放期间跳过边渲染（6.7 万条边的 WebGL 绘制是移动卡顿主源），
      // 相机静止后自动恢复
      hideEdgesOnMove: true,
      // 边命中检测走 WebGL readPixels（GPU 同步点）；开启后每次鼠标移动都会
      // 执行一遍。改为关闭，左右键点击时手动调用 getEdgeAtPoint。
      enableEdgeEvents: false,
      // 节点尺寸与坐标同单位（世界单位），去重叠才能与渲染一致
      itemSizesReference: "positions",
      zoomToSizeRatioFunction: (ratio) => ratio,
      defaultNodeType: "circle",
      defaultEdgeType: "line",
      // 标签：屏幕固定像素 + 网格防重叠 + 缩放门槛
      labelSize: 14,
      labelFont: '"Microsoft YaHei", "PingFang SC", sans-serif',
      labelColor: { color: "#d0d7de" },
      labelRenderedSizeThreshold: 14,
      labelGridCellSize: 180,
      labelDensity: 0.4,
      defaultDrawNodeLabel: drawNodeLabel,
      nodeProgramClasses: {
        image: FadingNodeImageProgram,
      },
    });
    window.__sigma = renderer; // 调试/测试出口

    bindEvents();

    container.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const bbox = container.getBoundingClientRect();
      const x = e.clientX - bbox.left;
      const y = e.clientY - bbox.top;
      const node = renderer.getNodeAtPosition({ x, y });
      if (node) {
        showNodeMenu(node, e.clientX, e.clientY);
        return;
      }
      const edge = renderer.getEdgeAtPoint(x, y);
      if (edge) {
        showEdgeMenu(edge, e.clientX, e.clientY);
        return;
      }
      hideContextMenu();
    });

    // 隐藏项的 reducer 结果缓存（见 main() 顶部声明）
    renderer.setSetting("edgeReducer", (edge, attrs) => {
      if (highlightEdges.has(edge)) {
        return { ...attrs, hidden: false, color: HIGHLIGHT_EDGE_COLOR, size: Math.max(attrs.size || 0.5, 1.6) };
      }
      const alpha = edgeAlpha.get(edge);
      if (alpha === 0) {
        let cached = hiddenEdgeData.get(edge);
        if (!cached) {
          cached = { ...attrs, hidden: true };
          hiddenEdgeData.set(edge, cached);
        }
        return cached;
      }
      if (alpha !== undefined && alpha < 1) {
        return { ...attrs, color: edgeColorFor(attrs.rgb || DEPENDENCY_EDGE_RGB, alpha) };
      }
      return attrs;
    });

    renderer.setSetting("nodeReducer", (node, attr) => {
      if (highlightNodes.has(node)) {
        return { ...attr, hidden: false, color: HIGHLIGHT_NODE_COLOR };
      }
      const alpha = nodeAlpha.get(node);
      if (alpha === 0) {
        let cached = hiddenNodeData.get(node);
        if (!cached) {
          cached = { ...attr, hidden: true };
          hiddenNodeData.set(node, cached);
        }
        return cached;
      }
      if (alpha !== undefined && alpha < 1) {
        // image 节点的预乘在 FadingNodeImageProgram 的 shader 里完成，
        // circle 节点没有自定义 shader，因此在这里预乘。
        const premul = attr.type !== "image";
        return { ...attr, color: hexToRgba(attr.color, alpha, premul) };
      }
      return attr;
    });

    const cam = renderer.getCamera();

    // ===== 视口优先、一次加载后永久保留 =====
    // 不限制总加载数量：节点首次进入视口就排队，加载成功后保留 image 属性。
    // 离开视口只是不再新增请求，重新进入时直接复用 ready 状态/object URL。
    const coverStates = new Map();
    const coverQueue = [];
    let activeCoverLoads = 0;
    let coverScheduleTimer = null;
    const pendingCoverUpdates = new Map();
    let coverUpdateFrame = null;

    // 图片解码完成后只入队，按帧批量更新 Sigma，避免 7k 张图各触发一次
    // graph 更新和 WebGL refresh，缓存命中时尤其能降低“排队很慢”的感觉。
    function flushCoverImageUpdates() {
      coverUpdateFrame = null;
      if (!pendingCoverUpdates.size) return;
      const updates = new Map(pendingCoverUpdates);
      pendingCoverUpdates.clear();
      graph.updateEachNodeAttributes(
        (key, attrs) => {
          const objectUrl = updates.get(key);
          return objectUrl ? { ...attrs, image: objectUrl, type: "image" } : attrs;
        },
        { attributes: ["image", "type"] },
      );
      // 节点类型恒为 image（无图回退纯色），可安全走局部刷新；类型若会
      // circle→image 切换则必须全量刷新（渲染程序槽位会重新分配）。
      // 纹理真正就绪后 node-image 程序会自行触发一次带去抖的全量刷新。
      renderer.refresh({
        partialGraph: { nodes: [...updates.keys()] },
        skipIndexation: true,
        schedule: true,
      });
    }

    function queueCoverImageUpdate(key, imageSource) {
      pendingCoverUpdates.set(key, imageSource);
      if (coverUpdateFrame === null) {
        coverUpdateFrame = requestAnimationFrame(flushCoverImageUpdates);
      }
    }

    function coverState(key) {
      let state = coverStates.get(key);
      if (!state) {
        state = { status: "idle", priority: Infinity, objectUrl: null };
        coverStates.set(key, state);
      }
      return state;
    }

    function pumpCoverLoads() {
      coverQueue.sort((a, b) => coverState(a.key).priority - coverState(b.key).priority);
      while (activeCoverLoads < COVER_LOAD_CONCURRENCY && coverQueue.length) {
        const item = coverQueue.shift();
        const state = coverState(item.key);
        if (state.status !== "queued") continue;
        state.status = "loading";
        activeCoverLoads += 1;
        loadCoverObjectUrlWithRetry(item.src, item.local, item.version)
          .then((imageSource) => {
            if (!imageSource) throw new Error("empty image");
            state.status = "ready";
            state.objectUrl = imageSource;
            queueCoverImageUpdate(item.key, imageSource);
          })
          .catch(() => {
            // 失败只记状态，不向控制台输出重复堆栈；下次重新打开页面可重试。
            state.status = "failed";
          })
          .finally(() => {
            activeCoverLoads -= 1;
            pumpCoverLoads();
          });
      }
    }

    function scheduleCoverLoads() {
      const w = container.clientWidth;
      const h = container.clientHeight;
      const margin = 320;
      if (w <= 0 || h <= 0) return;
      const camState = renderer.getCamera().getState();
      // 一次算好「图单位 → 屏幕像素」换算（与逐节点 scaleSize 语义一致），
      // 之后全部用图空间矩形预筛，只有候选节点才做视口投影
      const pxPerUnit = renderer.scaleSize(1, camState.ratio);
      if (!Number.isFinite(pxPerUnit) || pxPerUnit <= 0) return;
      const marginGraph = margin / pxPerUnit;
      const rect = getViewRect(camState);
      const minX = rect.minX - marginGraph;
      const maxX = rect.maxX + marginGraph;
      const minY = rect.minY - marginGraph;
      const maxY = rect.maxY + marginGraph;
      const visible = new Set();
      graph.forEachNode((key, attrs) => {
        if (!attrs.thumb) return;
        // 图空间包围盒预筛（纯数值比较，无矩阵调用）
        if (attrs.x < minX || attrs.x > maxX || attrs.y < minY || attrs.y > maxY) return;
        // 节点太小或当前被 LoD 隐藏时不联网；放大/重新出现后会再次排队。
        if (attrs.size * pxPerUnit < 6) return;
        if (nodeAlpha.get(key) === 0) return;
        const state = coverState(key);
        if (state.status === "ready" || state.status === "failed" || state.status === "loading") return;
        const point = renderer.graphToViewport({ x: attrs.x, y: attrs.y });
        visible.add(key);
        const centerDistance = Math.hypot(point.x - w / 2, point.y - h / 2);
        const insideViewport = point.x >= 0 && point.x <= w && point.y >= 0 && point.y <= h;
        // 以屏幕中心为优先级；屏幕内节点永远优先于屏幕外预取节点。
        state.priority = (insideViewport ? 0 : 1e9) + centerDistance;
        if (state.status === "idle") {
          state.status = "queued";
          coverQueue.push({ key, src: attrs.thumb, local: !!attrs.localCover, version: attrs.coverV || null });
        }
      });

      // 取消已经排队但用户已移出视口的请求，队列项会在 pump 时跳过。
      for (const [key, state] of coverStates) {
        if (state.status === "queued" && !visible.has(key)) state.status = "idle";
      }
      pumpCoverLoads();
    }

    function scheduleCoverLoadsSoon() {
      if (coverScheduleTimer) return;
      // 相机移动（拖动/缩放/动画）期间不启动新的封面加载——加载瞬态视口
      // 的封面是纯浪费，且加载-纹理-刷新链路会与移动渲染争抢主线程。
      // 相机静止 300ms 后再调度当前视口。
      coverScheduleTimer = setTimeout(() => {
        coverScheduleTimer = null;
        scheduleCoverLoads();
      }, 300);
    }

    let lodLastRun = 0;
    cam.on("updated", () => {
      const now = performance.now();
      const applyLod = () => {
        lodLastRun = performance.now();
        const state = cam.getState();
        lodThresholdValue = computeLodThreshold(state.ratio, LOD_MAX_THRESHOLD * edgeLodStrength);
        nodeVisibleCount = computeVisibleNodeCount(state.ratio, nodeLodStrength);
        updateCulling(state);
        startFade();
        scheduleCoverLoadsSoon();
      };
      if (lodTimer) clearTimeout(lodTimer);
      const elapsed = now - lodLastRun;
      if (elapsed >= LOD_THROTTLE_MS) {
        applyLod();
      } else {
        lodTimer = setTimeout(applyLod, LOD_THROTTLE_MS - elapsed);
      }
    });
    lodThresholdValue = computeLodThreshold(cam.getState().ratio, LOD_MAX_THRESHOLD * edgeLodStrength);
    nodeVisibleCount = computeVisibleNodeCount(cam.getState().ratio, nodeLodStrength);
    updateCulling(cam.getState());
    scheduleCoverLoads();

    renderer.refresh();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await new Promise((r) => setTimeout(r, 700));

    startFade();
    finishLoading();

    if (localDownloadContext) {
      const context = localDownloadContext;
      setTimeout(async () => {
        const total = (context.data.nodes || []).filter((node) => node.type === "core" && node.cover_url).length;
        if (!await askLocalCoverDownload(context.existingCount, total)) return;
        try {
          const centerX = container.clientWidth / 2;
          const centerY = container.clientHeight / 2;
          const orderedNodes = [...context.data.nodes].sort((a, b) => {
            const pa = renderer.graphToViewport({ x: a.x, y: a.y });
            const pb = renderer.graphToViewport({ x: b.x, y: b.y });
            const ia = pa.x >= 0 && pa.x <= container.clientWidth && pa.y >= 0 && pa.y <= container.clientHeight;
            const ib = pb.x >= 0 && pb.x <= container.clientWidth && pb.y >= 0 && pb.y <= container.clientHeight;
            const da = Math.hypot(pa.x - centerX, pa.y - centerY);
            const db = Math.hypot(pb.x - centerX, pb.y - centerY);
            return (ia ? 0 : 1e9) + da - ((ib ? 0 : 1e9) + db);
          });
          await downloadLocalCovers(context.data, context.source, orderedNodes);
        } catch (error) {
          finishCoverDownloadProgress("本地保存失败，焦点反代加载仍可继续。", "warning");
          showToast("本地封面后台保存失败，焦点反代加载仍可继续。", "warning");
        }
      }, 0);
    }
  }

  function bindEvents() {
    renderer.on("enterNode", ({ node }) => {
      hoveredNode = node;
      if (altLock) return;
      const attrs = graph.getNodeAttributes(node);
      showTooltip(node, attrs);
    });

    renderer.on("leaveNode", () => {
      hoveredNode = null;
      if (altLock) return;
      hideTooltip();
    });

    renderer.on("clickNode", ({ node }) => {
      window.open("https://www.mcmod.cn/class/" + node + ".html", "_blank");
    });

    // 左键点击边 → 聚焦较近端点。enableEdgeEvents 已关闭（避免每 mousemove
    // 一次 readPixels），这里在点击时手动做一次命中检测；带拖动保护。
    let pointerDownPos = null;
    container.addEventListener("mousedown", (e) => {
      pointerDownPos = { x: e.clientX, y: e.clientY };
    });
    container.addEventListener("click", (e) => {
      if (pointerDownPos && Math.hypot(e.clientX - pointerDownPos.x, e.clientY - pointerDownPos.y) > 5) return;
      const bbox = container.getBoundingClientRect();
      const x = e.clientX - bbox.left;
      const y = e.clientY - bbox.top;
      if (renderer.getNodeAtPosition({ x, y })) return; // 节点点击由 clickNode 处理
      const edge = renderer.getEdgeAtPoint(x, y);
      if (!edge) return;
      const source = graph.source(edge);
      const target = graph.target(edge);
      const cam = renderer.getCamera().getState();
      const sd = renderer.getNodeDisplayData(source);
      const td = renderer.getNodeDisplayData(target);
      if (!sd || !td) return;
      const ds = (sd.x - cam.x) * (sd.x - cam.x) + (sd.y - cam.y) * (sd.y - cam.y);
      const dt = (td.x - cam.x) * (td.x - cam.x) + (td.y - cam.y) * (td.y - cam.y);
      focusNode(ds >= dt ? source : target);
    });

    searchInput.addEventListener("input", () => {
      const q = searchInput.value.trim().toLowerCase();
      if (!q) {
        searchMatches = [...allNodes];
        searchPage = 0;
        renderSearchResults();
        return;
      }
      const matched = new Set();
      for (const [k, nodes] of searchIndex) {
        if (k.includes(q)) {
          for (const n of nodes) matched.add(n);
        }
      }
      searchMatches = [...matched].sort((a, b) => (b.views || 0) - (a.views || 0));
      searchPage = 0;
      renderSearchResults();
    });

    searchInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = searchList.querySelector("li");
        if (first) first.click();
      }
    });

    lodSlider.addEventListener("input", () => {
      nodeLodStrength = Number(lodSlider.value) / 100;
      lodValue.textContent = Math.round(nodeLodStrength * 100) + "%";
      nodeVisibleCount = computeVisibleNodeCount(renderer.getCamera().getState().ratio, nodeLodStrength);
      startFade();
    });

    edgeLodSlider.addEventListener("input", () => {
      edgeLodStrength = Number(edgeLodSlider.value) / 100;
      edgeLodValue.textContent = Math.round(edgeLodStrength * 100) + "%";
      lodThresholdValue = computeLodThreshold(renderer.getCamera().getState().ratio, LOD_MAX_THRESHOLD * edgeLodStrength);
      startFade();
    });

    panelToggle.addEventListener("click", () => {
      const collapsed = panel.classList.toggle("collapsed");
      panelToggle.textContent = collapsed ? "»" : "«";
      panelToggle.title = collapsed ? "展开侧边栏" : "收起侧边栏";
    });

    edgeDependency.addEventListener("change", () => {
      showDependency = edgeDependency.checked;
      startFade();
    });
    edgeInteraction.addEventListener("change", () => {
      showInteraction = edgeInteraction.checked;
      startFade();
    });
    showLabels.addEventListener("change", () => {
      renderer.setSetting("renderLabels", showLabels.checked);
    });

    exportButton.addEventListener("click", exportPNG);

    function updateExportWarning() {
      const w = parseInt(exportWidth.value, 10) || 0;
      const h = parseInt(exportHeight.value, 10) || 0;
      exportWarning.classList.toggle("hidden", w < 16384 && h < 16384);
    }
    exportWidth.addEventListener("input", updateExportWarning);
    exportHeight.addEventListener("input", updateExportWarning);
    updateExportWarning();
  }

  function renderSearchResults() {
    searchList.innerHTML = "";
    searchPagination.innerHTML = "";
    const pageSize = 20;
    const total = searchMatches.length;
    const pages = Math.max(1, Math.ceil(total / pageSize));
    if (searchPage >= pages) searchPage = pages - 1;
    const start = searchPage * pageSize;
    const page = searchMatches.slice(start, start + pageSize);

    for (const n of page) {
      const li = document.createElement("li");
      li.textContent = n.label + (n.name_en ? " (" + n.name_en + ")" : "");
      li.title = "class " + n.key;
      li.addEventListener("click", () => {
        focusNode(n.key);
      });
      searchList.appendChild(li);
    }

    if (pages > 1) {
      searchPagination.appendChild(buildPagination(pages, searchPage, (p) => {
        searchPage = p;
        renderSearchResults();
      }));
    }

    searchResults.classList.toggle("open", total > 0);
  }

  function getViewRect(cameraState) {
    const cam = cameraState || renderer.getCamera().getState();
    const dims = renderer.getDimensions();
    const override = { cameraState: cam, viewportDimensions: dims };
    const tl = renderer.viewportToGraph({ x: 0, y: 0 }, override);
    const br = renderer.viewportToGraph({ x: dims.width, y: dims.height }, override);
    return {
      minX: Math.min(tl.x, br.x),
      maxX: Math.max(tl.x, br.x),
      minY: Math.min(tl.y, br.y),
      maxY: Math.max(tl.y, br.y),
    };
  }

  function updateCulling(cameraState) {
    // 两段式：先一次节点扫描算出视口外节点集合，边扫描只做集合查找，
    // 避免每条边重复做坐标比较（6.7 万边 × 每相机更新）
    const rect = getViewRect(cameraState);
    const out = new Set();
    graph.forEachNode((node, attrs) => {
      if (attrs.x < rect.minX || attrs.x > rect.maxX || attrs.y < rect.minY || attrs.y > rect.maxY) out.add(node);
    });
    outOfViewNodes = out;
    const next = new Set();
    graph.forEachEdge((edge, _attrs, source, target) => {
      if (out.has(source) && out.has(target)) next.add(edge);
    });
    culledEdges = next;
  }

  function focusNode(key) {
    if (!renderer || !graph) return;
    const nd = renderer.getNodeDisplayData(key);
    if (!nd) return;
    const cam = renderer.getCamera();
    const size = graph.getNodeAttribute(key, "size") || 2; // 半径（世界单位）
    const width = renderer.getDimensions().width;
    // 节点屏幕直径 = 2 * size * graphToViewportRatio，且 graphToViewportRatio = C / ratio。
    // 令直径等于屏宽 * NODE_DIAMETER_SCREEN_RATIO，反解出目标 ratio。
    const C = renderer.getGraphToViewportRatio() * cam.getState().ratio;
    const targetRatio = (2 * size * C) / (NODE_DIAMETER_SCREEN_RATIO * width);
    cam.animate({ x: nd.x, y: nd.y, ratio: targetRatio }, { duration: 600 });
  }

  function computeLodThreshold(ratio, maxThreshold) {
    // 边 LoD：ratio 越大（缩到最小）阈值越高，只留骨干边。
    // maxThreshold 已按 edgeLodStrength 缩放：0 = 禁用边 LoD（阈值恒 0），1 = 最强。
    if (ratio <= LOD_FULL_ZOOM_RATIO) return 0;
    const maxR = 1;
    const r = Math.min(ratio, maxR);
    const t = (Math.log(r) - Math.log(LOD_FULL_ZOOM_RATIO)) /
              (Math.log(maxR) - Math.log(LOD_FULL_ZOOM_RATIO));
    return Math.round(maxThreshold * t);
  }

  function computeVisibleNodeCount(ratio, strength) {
    // 按重要度排名平滑显隐：缩到最小时只留 NODE_LOD_MIN_VISIBLE 个骨干，放大后逐渐增多。
    // strength 为 LoD 强度：0 = 完全禁用（全量渲染），1 = 最强。
    const total = graph.order;
    if (strength <= 0) return total;
    if (ratio <= LOD_FULL_ZOOM_RATIO) return total;
    const maxR = 1;
    const r = Math.min(ratio, maxR);
    const t = (Math.log(r) - Math.log(LOD_FULL_ZOOM_RATIO)) /
              (Math.log(maxR) - Math.log(LOD_FULL_ZOOM_RATIO));
    return Math.round(total * Math.pow(NODE_LOD_MIN_VISIBLE / total, t * strength));
  }

  function edgeTarget(edge, attrs) {
    if (attrs.kind === "dependency" && !showDependency) return 0;
    if (attrs.kind === "interaction" && !showInteraction) return 0;
    if ((attrs.importance || 0) < lodThresholdValue) return 0;
    if (culledEdges.has(edge)) return 0;
    return 1;
  }

  function nodeTarget(node, attrs) {
    if (!NODE_LOD_ENABLED) return 1;
    return (attrs.rank ?? Infinity) < nodeVisibleCount ? 1 : 0;
  }

  // 渐隐队列：只跟踪「当前 alpha ≠ 目标」的项。大图（2.7 万节点 + 6.7 万边）
  // 全量扫描只在 LoD/剔除参数变化时做一次，动画期间每帧只处理队列中的少量项，
  // 并用 sigma 的局部刷新避免整图重索引。
  let fadeQueue = [];

  function recomputeFadeTargets() {
    const queue = [];
    graph.forEachEdge((edge, attrs) => {
      const target = edgeTarget(edge, attrs);
      const cur = edgeAlpha.has(edge) ? edgeAlpha.get(edge) : 1;
      if (cur !== target) queue.push([edge, false]);
    });
    graph.forEachNode((node, attrs) => {
      const target = nodeTarget(node, attrs);
      const cur = nodeAlpha.has(node) ? nodeAlpha.get(node) : 1;
      if (cur !== target) queue.push([node, true]);
    });
    fadeQueue = queue;
  }

  function fadeStep() {
    fadeTimer = null;
    const step = 0.5;
    const changedNodes = [];
    const changedEdges = [];
    const remaining = [];
    for (const [key, isNode] of fadeQueue) {
      const map = isNode ? nodeAlpha : edgeAlpha;
      const target = isNode
        ? nodeTarget(key, graph.getNodeAttributes(key))
        : edgeTarget(key, graph.getEdgeAttributes(key));
      const cur = map.has(key) ? map.get(key) : 1;
      if (cur === target) continue;
      let next = cur + (target - cur) * step;
      if (Math.abs(next - target) < 0.02) next = target;
      if (next === 1) map.delete(key);
      else map.set(key, next);
      (isNode ? changedNodes : changedEdges).push(key);
      if (next !== target) remaining.push([key, isNode]);
    }
    fadeQueue = remaining;
    if (changedNodes.length || changedEdges.length) {
      // alpha 变化不改变节点/边的渲染类型，可安全走 skipIndexation 局部刷新；
      // 封面 circle→image 的类型切换仍走全量刷新（见 flushCoverImageUpdates）
      renderer.refresh({
        partialGraph: { nodes: changedNodes, edges: changedEdges },
        skipIndexation: true,
        schedule: true,
      });
    }
    if (fadeQueue.length) fadeTimer = setTimeout(fadeStep, 50);
  }

  function startFade() {
    recomputeFadeTargets();
    if (!fadeTimer && fadeQueue.length) fadeTimer = setTimeout(fadeStep, 0);
  }

  function showTooltip(node, attrs) {
    const lines = [];
    lines.push("<div class='tt-title'>" + escapeHtml(attrs.name) + "</div>");
    if (attrs.name_en) lines.push("<div class='tt-sub'>" + escapeHtml(attrs.name_en) + "</div>");
    if (attrs.description) lines.push("<div class='tt-desc'>" + escapeHtml(attrs.description) + "</div>");
    lines.push("<div class='tt-meta'>" + (attrs.kind === "core" ? "核心模组" : "外部引用") + " · " + escapeHtml(attrs.category || "无分类") + "</div>");
    if (attrs.status) lines.push("<div class='tt-meta'>状态：" + escapeHtml(attrs.status) + "</div>");
    lines.push("<div class='tt-stats'>浏览量 " + formatNum(attrs.views) + " · 收藏 " + formatNum(attrs.favorites) + "</div>");
    lines.push("<div class='tt-stats'>被依赖 " + attrs.in_degree + " · 依赖 " + attrs.out_degree + " · PageRank " + (attrs.pagerank ?? 0).toFixed(5) + "</div>");
    lines.push("<div class='tt-hint'>点击跳转 mcmod 页面</div>");
    tooltipEl.innerHTML = lines.join("");
    tooltipEl.classList.remove("hidden");
    positionTooltip();
  }

  function hideTooltip() {
    tooltipEl.classList.add("hidden");
  }

  function positionTooltip() {
    if (altLock) return;
    const pad = 12;
    const w = tooltipEl.offsetWidth;
    const h = tooltipEl.offsetHeight;
    let x = lastMouse.x + pad;
    let y = lastMouse.y + pad;
    if (x + w > window.innerWidth) x = lastMouse.x - w - pad;
    if (y + h > window.innerHeight) y = lastMouse.y - h - pad;
    tooltipEl.style.left = x + "px";
    tooltipEl.style.top = y + "px";
  }

  let lastMouse = { x: 0, y: 0 };
  let hoveredNode = null;
  let altLock = false;
  let lastAltPress = 0;
  const ALT_DOUBLE_MS = 300;

  window.addEventListener("mousemove", (e) => {
    lastMouse = { x: e.clientX, y: e.clientY };
    if (!tooltipEl.classList.contains("hidden")) positionTooltip();
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "Alt") {
      e.preventDefault();
      altLock = true;
      const now = performance.now();
      if (now - lastAltPress < ALT_DOUBLE_MS) {
        lastAltPress = 0;
        // 双击 Alt 完整显示/隐藏侧边栏（与“折叠”按钮的 collapsed 类互不干扰：
        // 隐藏优先于折叠，恢复时回到隐藏前的折叠状态）
        panel.style.display = panel.style.display === "none" ? "" : "none";
      } else {
        lastAltPress = now;
      }
    }
  });
  window.addEventListener("keyup", (e) => {
    if (e.key === "Alt") {
      altLock = false;
      if (!hoveredNode) hideTooltip();
    }
  });

  document.addEventListener("click", (e) => {
    if (!contextMenu.contains(e.target)) hideContextMenu();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") hideContextMenu();
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function hideContextMenu() {
    contextMenu.classList.add("hidden");
  }

  function collectRelations(key) {
    const dependsOn = new Set();
    const dependedBy = new Set();
    const interacts = new Set();

    graph.outEdges(key).forEach((e) => {
      const kind = graph.getEdgeAttribute(e, "kind");
      const t = graph.target(e);
      if (kind === "interaction") interacts.add(t);
      else dependsOn.add(t);
    });
    graph.inEdges(key).forEach((e) => {
      const kind = graph.getEdgeAttribute(e, "kind");
      const s = graph.source(e);
      if (kind === "interaction") interacts.add(s);
      else dependedBy.add(s);
    });

    const byInDegree = (a, b) =>
      (graph.getNodeAttribute(b, "in_degree") || 0) - (graph.getNodeAttribute(a, "in_degree") || 0);

    return {
      dependsOn: [...dependsOn].sort(byInDegree),
      dependedBy: [...dependedBy].sort(byInDegree),
      interacts: [...interacts].sort(byInDegree),
    };
  }

  function filterRelations(keys, query) {
    const q = query.trim().toLowerCase();
    if (!q) return keys;
    return keys.filter((key) => {
      const attrs = graph.getNodeAttributes(key);
      const name = (attrs.name || "").toLowerCase();
      const en = (attrs.name_en || "").toLowerCase();
      return name.includes(q) || en.includes(q) || key.includes(q);
    });
  }

  function positionMenu(x, y) {
    const w = contextMenu.offsetWidth;
    const h = contextMenu.offsetHeight;
    contextMenu.style.left = Math.max(4, Math.min(x, window.innerWidth - w - 8)) + "px";
    contextMenu.style.top = Math.max(4, Math.min(y, window.innerHeight - h - 8)) + "px";
  }

  function nodeDetailText(key) {
    const attrs = graph.getNodeAttributes(key);
    const lines = [];
    lines.push(attrs.name || key);
    if (attrs.name_en) lines.push(attrs.name_en);
    lines.push("class " + key);
    lines.push("被依赖 " + attrs.in_degree + " · 依赖 " + attrs.out_degree);
    lines.push("浏览量 " + formatNum(attrs.views));
    lines.push("收藏 " + formatNum(attrs.favorites));
    if (attrs.category) lines.push("分类 " + attrs.category);
    if (attrs.status) lines.push("状态 " + attrs.status);
    return lines.join("\n");
  }

  const REL_LABELS = { dependsOn: "依赖", dependedBy: "被依赖", interacts: "联动" };

  function contextItem(key, badgeType) {
    const attrs = graph.getNodeAttributes(key);
    const div = document.createElement("div");
    div.className = "ctx-item";
    if (badgeType) {
      const badge = document.createElement("span");
      badge.className = "ctx-badge " + badgeType;
      badge.textContent = REL_LABELS[badgeType] || badgeType;
      div.appendChild(badge);
    }
    const span = document.createElement("span");
    span.textContent = (attrs.name || key) + (attrs.name_en ? " (" + attrs.name_en + ")" : "");
    div.appendChild(span);
    div.title = nodeDetailText(key);
    div.addEventListener("click", () => {
      hideContextMenu();
      focusNode(key);
    });
    return div;
  }

  function findShortestPath(source, target) {
    if (source === target) return { path: [source], hops: [] };
    const prevNode = new Map();
    const prevEdge = new Map();
    const queue = [source];
    let head = 0;
    prevNode.set(source, null);
    while (head < queue.length) {
      const cur = queue[head++];
      for (const nb of graph.neighbors(cur)) {
        if (!prevNode.has(nb)) {
          prevNode.set(nb, cur);
          // 多边时取 cur -> nb 的第一条边，不影响最短路径结果
          prevEdge.set(nb, graph.edges(cur, nb)[0]);
          if (nb === target) {
            const path = [];
            const hops = [];
            let p = target;
            while (prevNode.get(p) !== null) {
              path.push(p);
              hops.push(prevEdge.get(p));
              p = prevNode.get(p);
            }
            path.push(source);
            path.reverse();
            hops.reverse();
            return { path, hops };
          }
          queue.push(nb);
        }
      }
    }
    return { error: "不存在路径" };
  }

  function applyHighlight(path, hops) {
    highlightNodes.clear();
    highlightEdges.clear();
    if (path && path.length) {
      for (const k of path) highlightNodes.add(k);
    }
    if (hops && hops.length) {
      for (const e of hops) if (e != null) highlightEdges.add(e);
    }
    if (renderer) renderer.refresh();
  }

  function showSixDegreesMenu(source, x, y) {
    const state = { query: "", page: 0, target: null, result: null };
    contextMenu.innerHTML = "";

    const titleEl = document.createElement("div");
    titleEl.className = "ctx-title ctx-title-row";
    const backBtn = document.createElement("button");
    backBtn.className = "ctx-six";
    backBtn.textContent = "← 返回";
    backBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showNodeMenu(source, x, y);
    });
    titleEl.appendChild(backBtn);
    const titleText = document.createElement("span");
    titleText.className = "ctx-title-text";
    titleText.textContent = "六度分隔";
    titleEl.appendChild(titleText);
    contextMenu.appendChild(titleEl);

    const searchWrap = document.createElement("div");
    searchWrap.className = "ctx-search";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "搜索目标模组…";
    searchWrap.appendChild(input);
    contextMenu.appendChild(searchWrap);

    const listEl = document.createElement("div");
    contextMenu.appendChild(listEl);

    const detectBtn = document.createElement("button");
    detectBtn.className = "ctx-detect";
    detectBtn.textContent = "检测";
    detectBtn.disabled = true;
    contextMenu.appendChild(detectBtn);

    const resultEl = document.createElement("div");
    resultEl.className = "ctx-six-result";
    contextMenu.appendChild(resultEl);

    function renderList() {
      listEl.innerHTML = "";
      const q = state.query.trim().toLowerCase();
      let matches = [];
      if (q) {
        const seen = new Set();
        for (const [term, nodes] of searchIndex) {
          if (term.includes(q)) {
            for (const n of nodes) {
              if (!seen.has(n.key)) {
                seen.add(n.key);
                matches.push(n);
              }
            }
          }
        }
      } else {
        matches = [...allNodes];
      }
      matches.sort((a, b) => (b.views || 0) - (a.views || 0));

      const pageSize = 20;
      const pages = Math.max(1, Math.ceil(matches.length / pageSize));
      if (state.page >= pages) state.page = pages - 1;
      const start = state.page * pageSize;
      const page = matches.slice(start, start + pageSize);

      for (const n of page) {
        const li = document.createElement("div");
        li.className = "ctx-item" + (state.target === n.key ? " selected" : "");
        li.textContent = n.label + (n.name_en ? " (" + n.name_en + ")" : "");
        li.title = "class " + n.key;
        li.addEventListener("click", (e) => {
          e.stopPropagation();
          state.target = n.key;
          detectBtn.disabled = false;
          renderList();
          positionMenu(x, y);
        });
        listEl.appendChild(li);
      }
      if (pages > 1) {
        listEl.appendChild(buildPagination(pages, state.page, (p) => {
          state.page = p;
          renderList();
          positionMenu(x, y);
        }));
      }
    }

    function renderResult() {
      resultEl.innerHTML = "";
      if (!state.result) return;
      if (state.result.error) {
        const empty = document.createElement("div");
        empty.className = "ctx-empty";
        empty.textContent = state.result.error;
        resultEl.appendChild(empty);
        return;
      }
      const path = state.result.path;
      for (let i = 0; i < path.length; i++) {
        const nodeEl = document.createElement("div");
        nodeEl.className = "ctx-six-path";
        const attrs = graph.getNodeAttributes(path[i]);
        nodeEl.textContent = (i + 1) + ". " + (attrs.name || path[i]);
        nodeEl.title = nodeDetailText(path[i]);
        nodeEl.addEventListener("click", () => {
          hideContextMenu();
          focusNode(path[i]);
        });
        resultEl.appendChild(nodeEl);
        if (i < path.length - 1) {
          const arrow = document.createElement("div");
          arrow.className = "ctx-six-arrow";
          arrow.appendChild(document.createTextNode("↓ "));
          const hop = state.result.hops[i];
          const kind = graph.getEdgeAttribute(hop, "kind");
          const groupName = graph.getEdgeAttribute(hop, "group_name") || "";
          let label;
          let cls;
          if (kind === "interaction") {
            label = "联动";
            cls = "interaction";
          } else {
            const s = graph.source(hop);
            label = (s === path[i]) ? "依赖" : "被依赖";
            cls = "dependency";
          }
          const span = document.createElement("span");
          span.className = "ctx-six-rel " + cls;
          span.textContent = label + (groupName ? " · " + groupName : "");
          arrow.appendChild(span);
          resultEl.appendChild(arrow);
        }
      }
      const info = document.createElement("div");
      info.className = "ctx-six-info";
      info.textContent = "共 " + (path.length - 1) + " 跳 · " + path.length + " 个节点";
      resultEl.appendChild(info);
    }

    function detect() {
      const result = findShortestPath(source, state.target);
      state.result = result;
      applyHighlight(result.path || null, result.hops || null);
      renderResult();
      positionMenu(x, y);
    }

    detectBtn.addEventListener("click", detect);
    input.addEventListener("input", () => {
      state.query = input.value;
      state.page = 0;
      state.target = null;
      detectBtn.disabled = true;
      renderList();
      positionMenu(x, y);
    });

    renderList();
    contextMenu.classList.remove("hidden");
    positionMenu(x, y);
    input.focus();
  }

  function showNodeMenu(node, x, y) {
    const attrs = graph.getNodeAttributes(node);
    const rel = collectRelations(node);
    const state = { title: attrs.name || node, rel, tab: "all", page: 0, query: "" };

    contextMenu.innerHTML = "";

    const titleEl = document.createElement("div");
    titleEl.className = "ctx-title ctx-title-row";
    const titleText = document.createElement("span");
    titleText.className = "ctx-title-text";
    titleText.textContent = state.title;
    titleEl.appendChild(titleText);
    const sixBtn = document.createElement("button");
    sixBtn.className = "ctx-six";
    sixBtn.textContent = "六度分隔";
    sixBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      showSixDegreesMenu(node, x, y);
    });
    titleEl.appendChild(sixBtn);
    contextMenu.appendChild(titleEl);

    const searchWrap = document.createElement("div");
    searchWrap.className = "ctx-search";
    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "搜索关联模组…";
    searchWrap.appendChild(input);
    contextMenu.appendChild(searchWrap);

    const tabs = document.createElement("div");
    tabs.className = "ctx-tabs";
    contextMenu.appendChild(tabs);

    const body = document.createElement("div");
    contextMenu.appendChild(body);

    const TAB_DEFS = [
      { key: "all", label: "全部" },
      { key: "dependsOn", label: "依赖" },
      { key: "dependedBy", label: "被依赖" },
      { key: "interacts", label: "联动" },
    ];

    function tabCount(key) {
      if (key === "all") {
        return state.rel.dependsOn.length + state.rel.dependedBy.length + state.rel.interacts.length;
      }
      return state.rel[key].length;
    }

    function activeList() {
      const items = [];
      if (state.tab === "all") {
        for (const key of state.rel.dependsOn) items.push({ key, type: "dependsOn" });
        for (const key of state.rel.dependedBy) items.push({ key, type: "dependedBy" });
        for (const key of state.rel.interacts) items.push({ key, type: "interacts" });
        items.sort((a, b) =>
          (graph.getNodeAttribute(b.key, "in_degree") || 0) - (graph.getNodeAttribute(a.key, "in_degree") || 0)
        );
      } else {
        for (const key of state.rel[state.tab]) items.push({ key, type: null });
      }
      return items;
    }

    function renderTabs() {
      tabs.innerHTML = "";
      for (const def of TAB_DEFS) {
        const t = document.createElement("button");
        t.className = "ctx-tab" + (state.tab === def.key ? " active" : "");
        t.textContent = def.label + " " + tabCount(def.key);
        t.addEventListener("click", (e) => {
          e.stopPropagation();
          state.tab = def.key;
          state.page = 0;
          renderTabs();
          renderBody();
          positionMenu(x, y);
        });
        tabs.appendChild(t);
      }
    }

    function renderBody() {
      body.innerHTML = "";
      const q = state.query.trim().toLowerCase();

      let list = activeList();
      if (q) {
        list = list.filter((item) => {
          const a = graph.getNodeAttributes(item.key);
          const name = (a.name || "").toLowerCase();
          const en = (a.name_en || "").toLowerCase();
          return name.includes(q) || en.includes(q) || item.key.includes(q);
        });
      }

      const pageSize = 20;
      const pages = Math.max(1, Math.ceil(list.length / pageSize));
      if (state.page >= pages) state.page = pages - 1;
      const start = state.page * pageSize;
      const page = list.slice(start, start + pageSize);

      if (!list.length) {
        const empty = document.createElement("div");
        empty.className = "ctx-empty";
        empty.textContent = "无匹配";
        body.appendChild(empty);
      } else {
        for (const item of page) body.appendChild(contextItem(item.key, item.type));
        if (pages > 1) {
          body.appendChild(buildPagination(pages, state.page, (p) => {
            state.page = p;
            renderBody();
            positionMenu(x, y);
          }));
        }
      }
    }

    renderTabs();
    renderBody();
    contextMenu.classList.remove("hidden");
    positionMenu(x, y);

    input.addEventListener("input", () => {
      state.query = input.value;
      state.page = 0;
      renderBody();
      positionMenu(x, y);
    });
    input.focus();
  }

  function showEdgeMenu(edge, x, y) {
    const source = graph.source(edge);
    const target = graph.target(edge);
    contextMenu.innerHTML = "";
    const titleEl = document.createElement("div");
    titleEl.className = "ctx-title";
    titleEl.textContent = "关系";
    contextMenu.appendChild(titleEl);
    const st = document.createElement("div");
    st.className = "ctx-section-title";
    st.textContent = "两端 (2)";
    contextMenu.appendChild(st);
    contextMenu.appendChild(contextItem(source));
    contextMenu.appendChild(contextItem(target));
    contextMenu.classList.remove("hidden");
    positionMenu(x, y);
  }

  function drawEdges(ctx, tx, ty, scale) {
    graph.forEachEdge((edge, attrs, source, target, sa, ta) => {
      const rgb = attrs.rgb || DEPENDENCY_EDGE_RGB;
      ctx.strokeStyle = rgbaString(rgb, EDGE_ALPHA);
      ctx.lineWidth = Math.max(1, (attrs.size || 0.5) * scale);
      ctx.beginPath();
      ctx.moveTo(tx(sa.x), ty(sa.y));
      ctx.lineTo(tx(ta.x), ty(ta.y));
      ctx.stroke();
    });
  }

  function drawLabel(ctx, cx, cy, r, attrs) {
    const name = attrs.name || attrs.key;
    const idText = "class " + attrs.key;
    const fontSize = LABEL_FONT_SIZE;
    const lineHeight = fontSize * 1.25;

    ctx.font = fontSize + 'px "Microsoft YaHei", "PingFang SC", sans-serif';
    ctx.textAlign = "center";
    ctx.textBaseline = "top";

    const nameW = ctx.measureText(name).width;
    const idW = ctx.measureText(idText).width;
    const maxW = Math.max(nameW, idW);

    const padX = fontSize * 0.35;
    const padY = fontSize * 0.2;
    const bx = cx - maxW / 2 - padX;
    const by = cy + r + fontSize * 0.35;
    const bw = maxW + padX * 2;
    const bh = lineHeight * 2 + padY * 2;

    ctx.fillStyle = "rgba(0, 0, 0, 0.7)";
    ctx.fillRect(bx, by, bw, bh);

    ctx.fillStyle = "#e6e6e6";
    ctx.fillText(name, cx, by + padY);
    ctx.fillStyle = "#9fb0c3";
    ctx.fillText(idText, cx, by + padY + lineHeight);
  }

  async function drawNodesAt(ctx, items, onProgress) {
    const total = items.length;
    let idx = 0;
    let done = 0;
    const CONCURRENCY = 64;

    async function worker() {
      while (idx < total) {
        const i = idx++;
        const item = items[i];
        const attrs = item.attrs;
        const cx = item.cx, cy = item.cy, r = item.r;

        let img = null;
        const src = attrs.imageSrc || attrs.image; // 导出优先原图（缩略图仅用于屏幕渲染）
        if (src) {
          let resolved = src;
          if (attrs.coverV) {
            // 导出同样走强缓存：原图一次缓存后，后续导出零网络请求
            const objectUrl = await loadStaticCoverObjectUrl(
              new URL(src, document.baseURI).href, attrs.coverV,
            ).catch(() => null);
            if (objectUrl) resolved = objectUrl;
          }
          img = new Image();
          // 本地 proxy 资源是跨域（ACAO *）；不声明 anonymous 会污染 canvas，
          // 导出 toBlob 时抛 SecurityError
          img.crossOrigin = "anonymous";
          img.src = resolved;
          await new Promise((resolve) => {
            img.onload = resolve;
            img.onerror = resolve;
          });
        }

        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        if (img && img.naturalWidth > 0) {
          const iw = img.naturalWidth;
          const ih = img.naturalHeight;
          // cover：等比缩放覆盖圆形，居中裁剪，保持封面宽高比
          const s = Math.max((r * 2) / iw, (r * 2) / ih);
          const dw = iw * s;
          const dh = ih * s;
          ctx.save();
          ctx.clip();
          ctx.drawImage(img, cx - dw / 2, cy - dh / 2, dw, dh);
          ctx.restore();
        } else {
          ctx.fillStyle = attrs.color || "#888888";
          ctx.fill();
        }

        drawLabel(ctx, cx, cy, r, attrs);

        done++;
        if (onProgress) onProgress(done, total);
      }
    }

    const workers = [];
    for (let w = 0; w < CONCURRENCY; w++) workers.push(worker());
    await Promise.all(workers);
  }

  function canvasToBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error("导出 PNG 失败"));
      }, "image/png");
    });
  }

  async function renderSingle(W, H, scale, nodePixels, toX, toY) {
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#000000";
    ctx.fillRect(0, 0, W, H);

    drawEdges(ctx, toX, toY, scale);

    const items = nodePixels.map((n) => ({ attrs: n.attrs, cx: n.px, cy: n.py, r: n.pr }));
    const startTime = Date.now();
    await drawNodesAt(ctx, items, (done, total) => {
      const now = Date.now();
      const pct = Math.round((done / total) * 100);
      const elapsed = now - startTime;
      const speed = done / Math.max(1, elapsed);
      const remaining = speed > 0 ? (total - done) / speed : 0;
      exportButton.textContent = "导出中 " + pct + "% · 剩余 " + formatDuration(remaining);
    });

    return canvasToBlob(canvas);
  }

  async function renderTiled(W, H, scale, nodePixels, toX, toY) {
    const TILE_W = 8192;
    const TILE_H = 1024;
    const cols = Math.ceil(W / TILE_W);
    const rows = Math.ceil(H / TILE_H);
    const totalTiles = cols * rows;
    let renderedTiles = 0;
    const startTime = Date.now();

    async function* getScanlines() {
      for (let r = 0; r < rows; r++) {
        const tileY0 = r * TILE_H;
        const tileH = Math.min(TILE_H, H - tileY0);

        // 渲染这一“行”的所有列块，并保留像素数据
        const colData = [];
        for (let c = 0; c < cols; c++) {
          const tileX0 = c * TILE_W;
          const tileW = Math.min(TILE_W, W - tileX0);

          const canvas = document.createElement("canvas");
          canvas.width = tileW;
          canvas.height = tileH;
          const ctx = canvas.getContext("2d");
          ctx.fillStyle = "#000000";
          ctx.fillRect(0, 0, tileW, tileH);

          const tx = (x) => toX(x) - tileX0;
          const ty = (y) => toY(y) - tileY0;
          drawEdges(ctx, tx, ty, scale);

          const items = [];
          for (const n of nodePixels) {
            // 标签从节点底部向下延伸（两行文字 + 内边距 + 间距），
            // 横向用保守余量覆盖长名称与 "class 12345"，
            // 确保标签跨越的 tile 都包含该节点，拼图后标签不被截断。
            const labelBottom = LABEL_FONT_SIZE * 3.25;
            const labelHalf = Math.max(n.pr, LABEL_FONT_SIZE * 16);
            if (n.px + labelHalf >= tileX0 && n.px - labelHalf <= tileX0 + tileW &&
                n.py + n.pr + labelBottom >= tileY0 && n.py - n.pr <= tileY0 + tileH) {
              items.push({ attrs: n.attrs, cx: n.px - tileX0, cy: n.py - tileY0, r: n.pr });
            }
          }
          await drawNodesAt(ctx, items, null);

          const imgData = ctx.getImageData(0, 0, tileW, tileH);
          colData.push({ tileW, data: imgData.data });

          renderedTiles++;
          const now = Date.now();
          const pct = Math.round((renderedTiles / totalTiles) * 100);
          const elapsed = now - startTime;
          const speed = renderedTiles / Math.max(1, elapsed);
          const remaining = speed > 0 ? (totalTiles - renderedTiles) / speed : 0;
          exportButton.textContent = "导出中 " + pct + "% · 剩余 " + formatDuration(remaining);
        }

        // 横向拼接成完整宽度的扫描行（PNG 每行必须为 W 宽）
        const fullRowBytes = W * 4;
        for (let y = 0; y < tileH; y++) {
          const row = new Uint8Array(fullRowBytes + 1);
          row[0] = 0;
          let offset = 1;
          for (const cd of colData) {
            const start = y * cd.tileW * 4;
            row.set(cd.data.subarray(start, start + cd.tileW * 4), offset);
            offset += cd.tileW * 4;
          }
          yield row;
        }
      }
    }

    return encodePNG(W, H, getScanlines);
  }

  async function exportPNG() {
    if (!graph) return;

    const W = parseInt(exportWidth.value, 10) || 65536;
    const H = parseInt(exportHeight.value, 10) || 65536;

    exportButton.disabled = true;
    exportButton.textContent = "导出中…";

    try {
      let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
      const nodes = [];
      graph.forEachNode((node, attrs) => {
        nodes.push({ ...attrs, key: node });
        const r = attrs.size || 0;
        if (attrs.x - r < minX) minX = attrs.x - r;
        if (attrs.x + r > maxX) maxX = attrs.x + r;
        if (attrs.y - r < minY) minY = attrs.y - r;
        if (attrs.y + r > maxY) maxY = attrs.y + r;
      });

      const pad = Math.max(maxX - minX, maxY - minY) * 0.02;
      minX -= pad; maxX += pad; minY -= pad; maxY += pad;
      const bw = maxX - minX, bh = maxY - minY;
      const scale = Math.min(W / bw, H / bh);
      const ox = (W - bw * scale) / 2;
      const oy = (H - bh * scale) / 2;
      const toX = (x) => (x - minX) * scale + ox;
      const toY = (y) => (y - minY) * scale + oy;

      const nodePixels = nodes.map((attrs) => ({
        attrs,
        px: toX(attrs.x),
        py: toY(attrs.y),
        pr: attrs.size * scale,
      }));

      const SINGLE_MAX = 16384;
      const blob = (W < SINGLE_MAX && H < SINGLE_MAX)
        ? await renderSingle(W, H, scale, nodePixels, toX, toY)
        : await renderTiled(W, H, scale, nodePixels, toX, toY);

      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "mcmod-graph-" + W + "x" + H + ".png";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error("[错误] 导出 PNG 失败", err);
      exportButton.textContent = "导出失败";
      setTimeout(() => { exportButton.textContent = "下载渲染图"; }, 2000);
    } finally {
      exportButton.disabled = false;
      if (exportButton.textContent.startsWith("导出中")) {
        exportButton.textContent = "下载渲染图";
      }
    }
  }

  cleanupLegacyServiceWorker()
    .then(() => boot())
    .catch((err) => {
      statusText.textContent = "出错了：" + err.message;
      progressLabel.textContent = "";
      console.error("[错误]", err);
    });
}

main();

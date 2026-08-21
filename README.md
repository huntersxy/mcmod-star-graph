# mcmod-star-graph

![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)
![Python 3.8+](https://img.shields.io/badge/Python-3.8%2B-blue)
![JavaScript ES2020](https://img.shields.io/badge/JavaScript-ES2020-yellow)

数据来源：MC 百科（mcmod.cn），仅用于学习研究。

## 快速开始

1. 从 [Releases](https://github.com/InfGithub/mcmod-star-graph/releases) 下载最新数据包 `graph-YYYYMMDD.json`，放入项目根目录
2. 启动本地服务器：
   ```bash
   python server.py --data graph-YYYYMMDD.json
   ```
3. 浏览器打开 <http://127.0.0.1:1119/>

首次打开需下载模组封面：点击"确定下载"，封面将缓存到浏览器 IndexedDB，下次无需重复下载。

## 用法

### 服务器参数

```bash
python server.py [--data 文件] [--mode enhanced|upstream] [端口] [host] [clean]
```

- **默认**：`python server.py`，服务根目录的 `graph.json`
- **`--data 文件`**：把指定数据文件映射为 `/graph.json` 加载，下载的 release 资产免改名
- **端口 / host**：`python server.py 8080 0.0.0.0`
- **`--mode enhanced`**：增强模式（默认），支持本地 covers 保存、焦点反代懒加载和后台批量保存
- **`--mode upstream`**：上游兼容模式，只提供静态文件与 `/cover_proxy` 反代，不保存本地封面
- **`clean`**：清理兼容缓存标记

### 封面尺寸

修改 `server.py` 顶部的 `COVER_SIZE`，然后用 `python server.py clean` 启动一次以清缓存重下。

### 封面强缓存（在线模式）

在线静态部署（GitHub Pages）模式下，封面使用浏览器的 Cache API 做持久强缓存：

- **命中即零请求**：已看过的封面完全从本地缓存取回，不向服务器发起任何请求（不受 HTTP 缓存 max-age 过期影响）。
- **版本化失效**：CI 在封面清单中为每张封面写入版本号（来源 URL 哈希）。封面未变 → 缓存键不变 → 永不重复请求；封面更新或移除 → 启动时自动清扫旧条目并按需重拉一次。
- 导出 PNG 使用的原图同样走该缓存；浏览器不支持 Cache API 时自动回退为普通加载。
- `graph.json` 与清单本身仍以 ETag 304 复验证（各 1 个轻量请求），保证 CI 数据更新能及时生效。

## 开发与构建

前端入口是 `main.js`（sigma.js v3 + graphology），需要先构建 bundle 再被 `index.html` 加载：

```bash
npm install       # 首次
npm run build     # esbuild 打包 + 压缩 + sourcemap → main.bundle.js
```

修改 `main.js` 后重新运行 `npm run build` 提交新的 `main.bundle.js`（CI 部署时会现场重建，本地开发依赖仓库内的 bundle）。

## 项目结构

| 路径 | 说明 |
| --- | --- |
| `main.js` | 前端：星图渲染、搜索、LoD 显隐、封面懒加载、PNG 导出 |
| `server.py` | 本地服务器：静态文件 + `/cover_proxy` 反代（绕 MC 百科防盗链）+ 后台批量保存封面 |
| `scripts/merge-release-graphs.mjs` | CI：合并上游全部 release 数据包为 `graph.json` |
| `scripts/prepare-covers.mjs` | CI：按清单增量下载封面到 `covers/` |
| `scripts/prepare-thumbs.mjs` | CI：生成 96px 展示缩略图到 `covers/small/` |
| `scripts/slim-graph.mjs` | CI：部署期剥离前端未用字段、截断坐标精度，减小传输体积 |
| `scripts/download-covers-local.mjs` | server.py 后台批量保存封面的 Node 快速路径 |
| `.github/workflows/deploy-pages.yml` | CI：合并数据 → 增量封面 → 构建前端 → 发布 GitHub Pages |

## 声明

- 本项目的图数据来源于 MC 百科（mcmod.cn）公开页面，抓取日期见各 Release 说明。
- 模组信息与封面图片的版权归原作者及 MC 百科所有。
- 本项目仅用于学习研究，请勿用于商业用途。

---
page: "modules/pine-engine/commands.md"
sources:
  - "frontend/src/lib/__tests__/pineCorpusReport.test.ts"
  - "frontend/src/lib/__tests__/pineCorpusSmoke.test.ts"
  - "frontend/src/lib/__tests__/pineRealWorld.test.ts"
  - "frontend/src/lib/__tests__/pineBuiltins.test.ts"
  - "frontend/src/lib/__tests__/pineContinuation.test.ts"
verified_at: "b19b657845bde24ef6d737eea2c24287a4031c3c"
anchors: open
vouch: applied-only
---
# Pine 兼容引擎命令与对账

## 1. 跑 Pine 测试

在 `frontend/` 下跑整个 Pine 测试目录：

```
cd frontend && npx.cmd vitest run src/lib/__tests__
```

Windows 的 PowerShell 5.1 要写 `npx.cmd`（`npx` 不带扩展名可能命中不到、或被解析到无发行版的 WSL，表现为「像跑了又红了」的假信号）。`vitest` 是 devDependency，`package.json` 的 `test` 脚本即 `vitest run`；只跑某支用 `-t` 加测试名片段即可。

## 2. 三闸对账

引擎的「兼容」用三道互补的闸来量，谁都不代替谁：

1. **everget v3/v4 基线（测量，非 gate）**：`pineCorpusReport.test.ts` 默认把批量语料过一遍，诚实报通过率而非钉绿。
2. **v6 语料（测量）**：用 `PINE_CORPUS_DIR` / `PINE_CORPUS_MANIFEST` 把同一支报告测试重指向第二套本地语料（如 v6 mihakralj），量新源的失败画像而**不惊动基线**。
3. **全量 vitest（含已提交回归闸）**：`pineCorpusSmoke.test.ts` 与 `pineRealWorld.test.ts` 等是**真 gate**——第三方脚本必须 parse、run（不 abort）、produce，坏一支就把构建弄红并点名文件。

## 3. `_pass-rate.json` 的读法

`pineCorpusReport.test.ts` 把每支脚本归入唯一结局 `ok`/`compile_error`/`runtime_abort`/`no_output`，写到语料目录下的 `_pass-rate.json`（本地专属、被 gitignore）。关键字段：`outcomeCounts` 与 `passRatePct` 是总账；`failureConstructs` 按「该构造在失败脚本里出现的次数」降序，即一份排好优先级的引擎 backlog；`topReasons` 取归一化后（`reasonOf` 抹掉 bar 号/坐标）计前 15。`expect(measured).toBeGreaterThan(0)` 是硬闸——绝不在空集上报通过率。

## 4. `produced` 口径（不放宽）

`ok` 与 `no_output` 的分界见 `pineCorpusReport.test.ts` 的 `classify`：**只有**「某条 line 含至少一个 finite 值 ∨ `markers.length > 0` ∨ `hlines.length > 0`」才 produced/`ok`。装饰性 drawing（`bgcolor`/`box`/`label`/`fill`…）刻意不喂这个指标（`pineTypes.ts` 的 `PineDrawing` 明写 "kept OUT of the produced pass-rate metric"），所以一支只画装饰的脚本诚实记为 `no_output`，不为其放宽判定。`pineCorpusSmoke.test.ts`、`pineRealWorld.test.ts` 用同一条 finite-lines 判据。

## 5. 语料 env 开关（默认必须仍是老源）

读侧 `pineCorpusReport.test.ts`：`PINE_CORPUS_DIR` 默认 `src/lib/__tests__/__fixtures__/corpus`，`PINE_CORPUS_MANIFEST` 默认 `scripts/corpus/pine-community.manifest.json`（v3/v4 everget）。抓取侧 `frontend/scripts/corpus/fetchPineCorpus.mjs`：`CORPUS_MANIFEST` 默认 `pine-community.manifest.json`，`CORPUS_OUT` 默认同上语料目录；跑 v6 时把二者分别指到 `pine-community-v6.manifest.json` 与同级 fixtures，两批测量彼此隔离。**默认值不改**：任何临时重指向都只在当次环境变量里生效，基线仍是老源。

## 6. 第三方语料的入库边界

`fetchPineCorpus.mjs` 是本地生成器、不进构建/CI：它从 `raw.githubusercontent` CDN 逐字下载第三方脚本（保留 GPL 头），写进 `__fixtures__/corpus/`——**这批批量语料不入库**。真正 commit 的是两样：清单 JSON（让集合可复现）与一份**精挑的 smoke 切片**。唯一起 gate 作用的第三方内容就是 `__fixtures__/corpus-smoke/` 里逐字提交、附 `NOTICE.txt` 的 ≥18 份脚本（`pineCorpusSmoke.test.ts` 断言其存在）。因此「第三方语料不入库」的准确表述是：批量语料不入库、只入库一份带 NOTICE 归属的 smoke 切片；语料缺席时整组 `describe.skip`，绝不空跑假绿。

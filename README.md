# Claude Buddy Hunt / Claude Buddy 属性搜索工具

[中文](#中文) | [English](#english)

一个用于搜索和生成 Claude buddy 属性组合的开源工具集。
推荐工作流是先用 `buddy-seed-search.js` 在 seed 空间里筛选目标属性，再用 `buddy-reroll.js` 在真实 UID 空间里搜索可用结果。

An open-source toolkit for searching and generating Claude buddy attribute combinations.
The recommended workflow is to use `buddy-seed-search.js` to narrow down target traits in seed space first, then use `buddy-reroll.js` to search real UID candidates.

## English

A small CLI toolkit for exploring Claude buddy generation rules and searching for buddy results with specific cosmetic traits and stat constraints.
It is meant for local use and works best with Bun when you want behavior that matches Claude Code.

### What it does

- Searches buddy combinations by species, rarity, eye, hat, shiny flag, and stat filters
- Uses `buddy-seed-search.js` to scan seed space quickly for promising combinations
- Uses `buddy-reroll.js` to search or check real UID results
- Lets you inspect an existing seed or UID to see what buddy it produces
- Supports Bun-based parallel range search in `buddy-seed-search.js` for higher throughput

### Requirements

- [Bun](https://bun.sh/) recommended
- `buddy-seed-search.js` is Bun-first, and range search should be run with Bun
- Node.js is optional for `buddy-reroll.js`, but its results do **not** match Claude Code

Recommended runtime choice:

- `buddy-seed-search.js` → use **Bun**
- `buddy-reroll.js` → use **Bun** if you want Claude-compatible results

### Files

- `buddy-seed-search.js` — recommended script for searching in local `seed:<n>` space
- `buddy-reroll.js` — recommended script for searching or checking real UID results
- `buddy-reroll-history.js` — historical prototype kept only for comparison, not the default entry point

### Quick start

No build step is required.

```bash
bun buddy-seed-search.js --help
bun buddy-reroll.js --help
```

### Common commands

Search for strong combinations in seed space:

```bash
bun buddy-seed-search.js --rarity legendary --min-stat 90 --count 3
```

Search for a more specific combination:

```bash
bun buddy-seed-search.js --species snail --stat "WISDOM>=95" --stat "PATIENCE>=90" --count 5
```

Check a specific seed:

```bash
bun buddy-seed-search.js --check-seed 123456
bun buddy-seed-search.js --check-id seed:123456
```

Search real UID candidates with behavior matching Claude Code:

```bash
bun buddy-reroll.js --species snail --stat "WISDOM>=95" --stat "PATIENCE>=90" --count 1 --workers 8
```

Check what a known UID produces:

```bash
bun buddy-reroll.js --check <uid>
```

### Recommended workflow

1. Use `buddy-seed-search.js` to find an attribute combination you want.
2. Reuse the same filters with `buddy-reroll.js`.
3. Run `buddy-reroll.js` with Bun until you get a real UID result you like.

Important:

- A `seed:<n>` result is a local search target, not a real UID.
- Seed-space hits do **not** directly convert into real UID values.
- `buddy-seed-search.js` is best treated as a fast attribute-template finder.
- `buddy-reroll.js` is the script that searches real UID candidates.

### Bun vs Node

`buddy-reroll.js` supports both Bun and Node.js, but they are not equivalent:

- **Bun** uses `Bun.hash` and matches Claude Code behavior
- **Node.js** uses FNV-1a and does **not** match Claude Code behavior

If you care about accurate buddy reproduction, use Bun.

### Search filters

Shared filters supported by both main scripts:

- `--species` — require a specific buddy species such as `snail` or `dragon`
- `--rarity` — require a minimum rarity threshold such as `rare` or `legendary`
- `--eye` — require a specific eye style character
- `--hat` — require a specific hat or accessory
- `--shiny` — only match shiny buddies
- `--min-stats` — legacy shorthand that requires all stats to be at least the given value
- `--stat "NAME>=VALUE"` — add a precise comparison for a single stat, such as `WISDOM>=95`
- `--min-stat` — require the lowest stat in the result to be at least the given value
- `--max-stat` — require the highest stat in the result to stay at or below the given value
- `--min-total` — require the sum of all stats to be at least the given value
- `--max-total` — require the sum of all stats to stay at or below the given value
- `--min-avg` — require the average stat value to be at least the given value
- `--max-avg` — require the average stat value to stay at or below the given value
- `--count` — stop after finding the requested number of matches

Script-specific options:

- `buddy-seed-search.js`
  - `--check-seed` — inspect the buddy result for a specific numeric seed
  - `--check-id` — inspect the buddy result for a local pseudo-ID such as `seed:123456`
  - `--start-seed` — set the beginning of the seed range to scan
  - `--end-seed` — set the end of the seed range to scan
  - `--workers` — choose how many Bun workers to use for range search
  - `--progress-every` — control how often progress is reported during range search
  - `--exhaustive` — keep scanning the full range even after enough matches are found
- `buddy-reroll.js`
  - `--check` — inspect the buddy result for a specific real UID
  - `--max` — set the maximum number of random attempts to try
  - `--workers` — choose how many Bun workers to use in search mode; not allowed with `--check`

See each script's `--help` output for the exact syntax.

### Credits

The original script prototype came from:

- https://linux.do/t/topic/1871870

This repository extends that prototype with additional filtering, validation, and search capabilities.

### License

Licensed under the MIT License. See [LICENSE](./LICENSE).

## 中文

这是一个用于探索和搜索 Claude buddy 属性组合的小型命令行工具集。
适合本地直接运行；如果你希望行为尽量与 Claude Code 对齐，推荐使用 Bun。

### 功能

- 按 species、rarity、eye、hat、shiny 和 stat 条件搜索目标 buddy
- 用 `buddy-seed-search.js` 在 seed 空间里快速筛选理想属性组合
- 用 `buddy-reroll.js` 在真实 UID 空间里搜索或检查结果
- 检查某个 seed 或 UID 最终会生成什么 buddy
- `buddy-seed-search.js` 支持基于 Bun 的并行区间搜索，提高搜索吞吐量

### 环境要求

- 推荐安装 [Bun](https://bun.sh/)
- `buddy-seed-search.js` 以 Bun 为主，尤其区间搜索应使用 Bun 运行
- `buddy-reroll.js` 也可用 Node.js 运行，但结果**不与 Claude Code 对齐**

推荐运行方式：

- `buddy-seed-search.js` → 使用 **Bun**
- `buddy-reroll.js` → 若需要和 Claude 一致，使用 **Bun**

### 文件说明

- `buddy-seed-search.js` —— 推荐使用，在本地 `seed:<n>` 空间中搜索
- `buddy-reroll.js` —— 推荐使用，搜索或检查真实 UID 的结果
- `buddy-reroll-history.js` —— 仅保留用于对比的历史原型，不是当前默认入口

### 快速开始

不需要构建，直接运行即可：

```bash
bun buddy-seed-search.js --help
bun buddy-reroll.js --help
```

### 常用命令

先在 seed 空间里找高属性组合：

```bash
bun buddy-seed-search.js --rarity legendary --min-stat 90 --count 3
```

搜索更具体的目标组合：

```bash
bun buddy-seed-search.js --species snail --stat "WISDOM>=95" --stat "PATIENCE>=90" --count 5
```

检查某个 seed：

```bash
bun buddy-seed-search.js --check-seed 123456
bun buddy-seed-search.js --check-id seed:123456
```

用与 Claude Code 行为对齐的方式在真实 UID 空间搜索：

```bash
bun buddy-reroll.js --species snail --stat "WISDOM>=95" --stat "PATIENCE>=90" --count 1 --workers 8
```

检查某个已知 UID 会生成什么：

```bash
bun buddy-reroll.js --check <uid>
```

### 推荐使用流程

1. 先用 `buddy-seed-search.js` 找到你想要的属性组合。
2. 再把同样的筛选条件用于 `buddy-reroll.js`。
3. 用 Bun 运行 `buddy-reroll.js`，持续搜索真实 UID，直到命中满意结果。

注意：

- `seed:<n>` 只是本地搜索目标，不是真实 UID。
- seed 空间里的命中结果**不能直接转换**成真实 UID。
- `buddy-seed-search.js` 更适合当作“属性模板搜索器”。
- `buddy-reroll.js` 才是搜索真实 UID 的脚本。

### Bun 与 Node 的区别

`buddy-reroll.js` 同时支持 Bun 和 Node.js，但结果并不等价：

- **Bun** 使用 `Bun.hash`，与 Claude Code 行为对齐
- **Node.js** 使用 FNV-1a，**不与 Claude Code 对齐**

如果你在意结果准确性，请使用 Bun。

### 可用筛选条件

两个主脚本都支持组合使用这些通用筛选条件：

- `--species` —— 指定目标物种，例如 `snail`、`dragon`
- `--rarity` —— 指定最低稀有度门槛，例如 `rare`、`legendary`
- `--eye` —— 指定眼睛样式字符
- `--hat` —— 指定帽子或饰品类型
- `--shiny` —— 只匹配 shiny buddy
- `--min-stats` —— 旧式简写，要求所有 stat 都不低于给定值
- `--stat "NAME>=VALUE"` —— 为单个 stat 添加精确比较条件，例如 `WISDOM>=95`
- `--min-stat` —— 要求结果中的最低 stat 不低于给定值
- `--max-stat` —— 要求结果中的最高 stat 不高于给定值
- `--min-total` —— 要求所有 stat 总和不低于给定值
- `--max-total` —— 要求所有 stat 总和不高于给定值
- `--min-avg` —— 要求 stat 平均值不低于给定值
- `--max-avg` —— 要求 stat 平均值不高于给定值
- `--count` —— 找到指定数量的命中结果后停止

脚本专属参数：

- `buddy-seed-search.js`
  - `--check-seed` —— 检查某个数字 seed 会生成什么 buddy
  - `--check-id` —— 检查某个本地伪 ID（如 `seed:123456`）会生成什么 buddy
  - `--start-seed` —— 指定扫描区间的起始 seed
  - `--end-seed` —— 指定扫描区间的结束 seed
  - `--workers` —— 指定区间搜索时使用多少个 Bun worker
  - `--progress-every` —— 控制区间搜索时的进度输出频率
  - `--exhaustive` —— 即使已经找到足够结果，也继续扫完整个区间
- `buddy-reroll.js`
  - `--check` —— 检查某个真实 UID 会生成什么 buddy
  - `--max` —— 指定随机尝试搜索时的最大尝试次数
  - `--workers` —— 指定搜索模式下使用多少个 Bun worker；不能和 `--check` 同用

具体语法请直接查看各自的 `--help` 输出。

### 致谢

脚本原型来自：

- https://linux.do/t/topic/1871870

本仓库在原型基础上补充了更多筛选能力、参数校验与搜索能力。

### License

本项目使用 MIT License，详见 [LICENSE](./LICENSE).

## More notes / 更多说明

如果你对 buddy 的使用思路、一些细节玩法或小彩蛋感兴趣，可以扫码看看我的公众号。

If you're interested in a few extra notes on buddy usage, small details, or easter eggs, you can scan the QR code below.

![WeChat QR code](./qrcode_for_gh_6edc06d0c6e0_258.jpg)

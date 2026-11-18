# 发版手册（一条命令：HTTP 上传 dl.rose7.cn + tag 触发 GitHub Release）

> 2026-11-18 改版：**上传改走 HTTPS 接口**（`POST /api/v1/release`，multipart `apk`+`meta`，Bearer 令牌），
> **不再依赖 ssh/scp**；GitHub Release **由 tag 触发的 workflow 创建**（脚本不建 Release、不改 tag）。
> 接口细节见 [`docs/dl-release-api.md`](docs/dl-release-api.md)，workflow 见 [`.github/workflows/release.yml`](.github/workflows/release.yml)。

```
./release-apk.sh <版本> (--internal|--standard) "变更1" "变更2" [--dry-run|--skip-tests|--no-push]
```

---

## 1. 一次性准备

| 项目 | 做法 | 校验 |
| --- | --- | --- |
| 仓库 | `cd /root/deepseek-app`，工作区干净 | `git status --porcelain` 为空 |
| 依赖 | `pnpm install` | `pnpm type` 可跑 |
| **发布令牌** | 在 ECS 上取：`ssh aliyun 'cat /etc/dl-release/token' > ~/.config/dl-release/token`，然后 `chmod 600`（或直接 `export DL_RELEASE_TOKEN=...`） | `ls -l ~/.config/dl-release/token` 应为 `-rw-------`；**绝不写进仓库、绝不 echo/贴日志** |
| Android SDK / JDK | 默认 `/root/android-sdk`，JDK 21 | `aapt2` 可执行、`java -version` |
| git 远端 | `origin` 指向 `zzy-repo/deepseek-app`，本地在 `main` | `git remote -v`、`git push --dry-run origin HEAD:main` |
| gh（只用于**观察**） | 可选，凭据 `/root/.config/gh/hosts.yml` | `gh auth status`；Release 由其内置 `GITHUB_TOKEN` 创建 |
| e2e 真上游 key | `export E2E_API_KEY=sk-xxx`（只走环境变量） | 不设 → 门禁第 6 项**阻断**（见 §3） |

---

## 2. 一条命令发版

```bash
# 内测构建（pnpm build:internal）
./release-apk.sh 1.5.0 --internal "新增：会话自动标题" "修复：手动改名被覆盖"

# 对外构建（pnpm build）
./release-apk.sh 1.5.0 --standard "优化：启动速度"
```

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `<版本号>` | ✅ | `x.y.z` 或 `x.y.z-beta.1` |
| `"变更1" ...` | ✅ | 至少一条：写进 CHANGELOG、dl 的 `releases.json`、workflow 生成的 Release notes |
| `--internal` / `--standard` | 二选一 | 不给默认 `--standard` 并告警 |
| `--skip-tests` | ❌ | 跳过门禁 4/5/6，**留痕** `[未过门禁]` |
| `--dry-run` | ❌ | 只打印九步计划，零副作用 |
| `--no-push` | ❌ | 只发 dl，不 push/不打 tag（别名 `--no-github`） |
| `--wait-release [秒]` | ❌ | tag 推送后最多等 N 秒（默认 90）看 workflow 是否建好 Release（只观察，不创建） |

### 九步

| 步 | 动作 | 失败处理 |
| --- | --- | --- |
| 1 | `./preflight.sh --planned-version <ver> --planned-versioncode <vc>`（透传 `--skip-tests` / `--allow-same-version`） | **中止，不碰任何文件** |
| 2 | 版本号格式校验 | 退出 |
| 3 | 改 `android/app/build.gradle`：`versionCode` = `max(本地, 远端)+1`，`versionName` = 新版本；**同版本续发不重复递增** | 按备份还原（不动别人的改动） |
| 4 | 写 `CHANGELOG.md`：插入 `## <ver> (<日期>) — <首条变更短标题>`（幂等） | 按备份还原 |
| 5 | `git add` 两个文件 + `git commit -m "chore: 发布 <ver>"`（无改动则跳过） | 还原；不 `reset --hard` |
| 6 | 构建（`pnpm build[:internal]` → `npx cap sync android` → `gradlew assembleDebug`）+ **构建后强校验** `aapt2` 的 versionName/versionCode 必须等于目标 | 中止（已 commit，人工 `git revert`） |
| 7 | `POST /api/v1/release`（multipart）+ **核对响应 md5 / latest 与本地一致** | 中止；已上传则记录部分成功 |
| 8 | `git push origin HEAD:refs/heads/main` → 推送 tag（已存在且指向本 commit 则复用；**指错则停下报错，不 force**） | 退出码 3（部分成功） |
| 9 | 汇总 + 状态文件 `~/.local/state/deepseek-app/release/<ver>.json` | — |

### 退出码与“部分成功”

| 码 | 含义 |
| --- | --- |
| 0 | dl 已发布（md5 已核对）**且** tag 已就位；GitHub Release 仍由 workflow 异步完成（脚本不宣称全链路完成） |
| 3 | 部分成功：dl 已发布，push/tag/Release 未完成 → **同 artifact 重跑续发** |
| 1 | 失败，未发布 |

dl 与 GitHub 不是原子事务。脚本**从不**替你宣称“全发布成功”，汇总里 dl / tag / Release 三行分别标注。

### 续发（同一 artifact）

重跑同一条命令即可：脚本读状态文件 + 本地 APK 的 md5，若与上次上传的一致，则
**跳过构建与上传**（打印「同 artifact 续发」），只补 push/tag/Release 观察；
此时 `versionCode` **不会再次递增**（门禁按 `--allow-same-version` 放行同版本重传，服务端本身也允许同版本覆盖）。

### 先演练

```bash
./release-apk.sh 1.5.0 --internal "预演" --dry-run   # 九步计划 + versionCode/versionName/构建类型/令牌来源
./preflight.sh --dry-run                             # 只看门禁清单
```

---

## 3. 门禁九项（`preflight.sh`）

| # | 检查 | 失败/异常时 |
| --- | --- | --- |
| 1 | `git status --porcelain` 为空 | 阻断：`git commit` / `git stash`；**禁止 `git add -A`** |
| 2 | `pnpm type`（缺脚本降级 `npx tsc -p tsconfig.json`） | 阻断：修类型 |
| 3 | `pnpm lint`（oxlint） | 阻断：修 lint 或 `--fix` |
| 4 | `npm run test`（缺脚本降级 `node --test tests/unit`） | 阻断 |
| 5 | `npm run test:integration`（降级 `tests/integration`） | 阻断 |
| 6 | `npm run test:e2e`，需 `E2E_API_KEY` | **没 key → 阻断**（缺证据不能算通过）；有 key 失败 → 阻断。应急只能显式 `--skip-tests`（留痕） |
| 7 | `versionCode` 递增：待发布值（`--planned-versioncode` 或本地+1）必须 > `releases.json` 的 latest；网络不通降级比 CHANGELOG 最新版本。同版本续发且 `--allow-same-version` 时允许相等 | 阻断：让 `release-apk.sh` 自动算 `max(本地,远端)+1` |
| 8 | `CHANGELOG.md` 含 `## <versionName>` 段落 | 阻断：手写或用 `release-apk.sh`（第 4 步自动写） |
| 9 | 现有 APK 元信息 vs `build.gradle` | **构建前不阻断**（旧 APK 很正常）；仅提示 SKIP，构建后由 `release-apk.sh` 第 6 步**强校验** |

其他：每项打印 PASS/FAIL + 耗时 + 修复建议，末尾汇总表；`--skip-tests` 打印醒目的 `!!!` 横幅。
退出码：`0` 通过（允许 SKIP）、`1` 有 FAIL、`2` 参数错误。

---

## 4. 应急通道 `--skip-tests`

- 只跳过第 4/5/6 项；第 1/2/3/7/8/9 项照跑。
- 留痕（自动）：CHANGELOG 版本标题加 ` [未过门禁]`；dl 的 `releases.json` 的 `changes` 里带同样标记；
  workflow 生成的 Release notes 也是从 `changes` 生成，故同样可见；脚本汇总再提示一次。
- 代价：真上游 + 真前端链路无证据（SSE 解析 / 鉴权头 / 构建模式错配会直接漏到用户）。只在止血时用，并在发布说明写清原因。

---

## 5. 回滚

| 对象 | 操作 |
| --- | --- |
| dl 上的 APK / `releases.json` | 发布接口**只增不删**：需要运维在 ECS 上操作（`ssh aliyun`，`/var/www/dl/`）。回滚前先想清楚：把 `latest` 改回旧版本会让已升级用户降级 |
| GitHub Release | `gh release delete v<ver> --repo zzy-repo/deepseek-app --yes`（或先 `gh release edit v<ver> --draft` 下架） |
| tag | 先删 Release 再删 tag：`git push origin :refs/tags/v<ver>` + `git tag -d v<ver>`；**不要 force 改已有 tag** |
| 发布 commit | 用**非破坏性**方式：`git revert <发布commit>`；本仓库有他人并行改动，**禁止 `git reset --hard`** |
| 未 commit 的改动 | 脚本失败时按自己写入前的备份还原；手工兜底 `git checkout -- <该文件>`（只针对自己的改动） |

---

## 6. 常见失败与处置

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| 门禁 1 FAIL 列出文件 | 有未提交改动或其他 agent 在改代码 | `git commit` / `git stash`；只 add 自己的文件 |
| 门禁 6 FAIL “缺 E2E_API_KEY” | 没设 key | `export E2E_API_KEY=sk-...`；或显式 `--skip-tests`（留痕） |
| 门禁 7 FAIL 没递增 | `versionCode` 未超过线上 latest | 交给脚本算（`max(本地,远端)+1`），别手改 |
| 第 6 步 “构建产物与目标版本不一致” | `cap sync` 未刷新 / gradle 缓存 | 重新 `npx cap sync android` 后重跑；**构建后不一致绝不发布** |
| 第 7 步 `401 UNAUTHORIZED` | 令牌错/过期 | 重新从 ECS 取令牌到 `~/.config/dl-release/token`（`chmod 600`） |
| 第 7 步 `409 VERSION_CONFLICT` | 服务端 latest 的 versionCode ≥ 本次（防降级） | 让脚本重算 versionCode（+1）后重发 |
| 第 7 步 `413` / `429` | APK > 50 MB / 每 IP 每分钟 2 次 | 减小产物 / 等 `Retry-After`（脚本自动重试一次） |
| 第 7 步 “服务端 md5 ≠ 本地” | 上传内容与服务端收到的不一致 | 不要当成功；核对产物后按同版本重发（服务端允许同版本覆盖） |
| 第 8 步 “tag 已存在且指向别的 commit” | 版本号被复用 / 之前的 tag 指错 | 脚本**停下不 force**：换新版本号（推荐），或人工确认后自己 `git push -f` |
| 汇总 “⏳ Release 异步创建中” | workflow 还在跑/失败 | `gh run list --workflow=release.yml`；workflow 失败常见于 dl 上查不到该版本 md5 |
| 手机装了但不升级 | `versionCode` 没增 | 看第 6 步打印的 APK versionCode；必要时 `--wait-release` 复核 |

---

## 7. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DL_RELEASE_TOKEN` | （空） | 优先使用；值不打印 |
| `DL_RELEASE_TOKEN_FILE` | `~/.config/dl-release/token` | 令牌文件（建议 600） |
| `DL_API_URL` | `https://dl.rose7.cn/api/v1/release` | 发布接口 |
| `DL_RELEASES_URL` | `https://dl.rose7.cn/releases.json` | 版本基线（门禁第 7 项 + 冲突预判） |
| `DL_STATE_DIR` | `~/.local/state/deepseek-app/release` | 续发状态文件目录（仓库外） |
| `GIT_REMOTE` / `GH_BRANCH_NAME` | `origin` / `main` | push 目标 |
| `GH_REPO` | `zzy-repo/deepseek-app` | 仅用于观察 Release |
| `APK_SRC` / `AAPT2` / `GRADLE` / `CHANGELOG` / `PREFLIGHT` | 见脚本 | 路径覆盖 |
| `E2E_API_KEY` | （空） | 门禁第 6 项 |
| `SKIP_WEB_BUILD` | `0` | `=1` 复用 `dist/` |
| `RELEASE_BUILD_CMD` / `RELEASE_APK_META_CMD` | （空） | **仅测试钩子**，生产不要设置 |

---

## 8. 隔离验收（不联网、不真发版）

```bash
./release-tests/run-mock-tests.sh     # 临时仓库 + mock curl/gh，44 项断言
```

覆盖：dry-run 零副作用、门禁失败阻断、401/409/md5 不符、断网、同 artifact 续发（versionCode 不重复递增）、
tag 冲突不 force、令牌来自 env/文件、脚本从不创建 Release。当前结果：**44 通过 / 0 失败**。

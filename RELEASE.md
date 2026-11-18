# 发版手册（一条命令把 APK 发到 dl.rose7.cn + GitHub Release）

> 任何人照本文即可发版。**核心只有一条命令**，前面的人工五步（改版本号、写 CHANGELOG、commit、构建、上传）
> 已经被脚本自动化；发布前的那道**九项门禁**由 `./preflight.sh` 把关，任一失败就中止。

```
prerequisites → ./release-apk.sh <版本> --internal "变更1" "变更2"
```

---

## 1. 一次性准备（每台机器只需做一次）

| 项目 | 做法 | 校验 |
| --- | --- | --- |
| 仓库 | `cd /root/deepseek-app` | `git status` 干净 |
| 依赖 | `pnpm install`（根目录） | `pnpm type` 能跑 |
| gh 登录 | 凭据在 `/root/.config/gh/hosts.yml`（账号 `zzy-repo`，`repo`+`workflow` scope，**明文 token，绝不提交**） | `gh auth status` 显示 `Logged in to github.com account zzy-repo` |
| Android SDK | 默认 `/root/android-sdk`（`export ANDROID_HOME=...` 可覆盖） | `/root/android-sdk/build-tools/35.0.0/aapt2` 可执行 |
| JDK | Gradle 需要 JDK 21 | `java -version` |
| ECS 免密 | `ssh aliyun` 免密可登（`REMOTE=aliyun`，站点根 `/var/www/dl`） | `ssh aliyun 'ls /var/www/dl'` |
| e2e 真上游 key | **只走环境变量**，不落盘：`export E2E_API_KEY=sk-xxx` | 不设也能发，但门禁第 6 项会 SKIP（只警告） |
| GitHub 网络 | 直连不通时 `export HTTPS_PROXY=http://127.0.0.1:7890 https_proxy=...` | `gh api /rate_limit` 有响应 |

---

## 2. 一条命令发版

```bash
cd /root/deepseek-app

# 内测构建（pnpm build:internal）
./release-apk.sh 1.5.0 --internal "新增：会话自动标题" "修复：手动改名被覆盖"

# 对外构建（pnpm build）
./release-apk.sh 1.5.0 --standard "优化：启动速度"
```

### 参数

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `<版本号>` | ✅ | `x.y.z` 或 `x.y.z-beta.1`（也接受任意 `-后缀`，如 `9.9.9-dryrun`） |
| `"变更1" "变更2" ...` | ✅ | 至少一条；写进 `CHANGELOG.md` 与 GitHub Release notes |
| `--internal` | 二选一 | 内部构建 `heavy-run pnpm build:internal` |
| `--standard` | 二选一 | 对外构建 `heavy-run pnpm build`（**不给就默认这个并告警**） |
| `--skip-tests` | ❌ | 跳过门禁 4/5/6（见 §4，会用 `[未过门禁]` 留痕） |
| `--dry-run` | ❌ | 只打印九步计划，**零副作用**（不改文件/不 commit/不构建/不上传/不打 tag） |
| `--no-github` | ❌ | 只发 dl.rose7.cn（应急） |
| `--help` | ❌ | 用法 |

### 内部九步（脚本做的事）

| 步 | 动作 | 失败处理 |
| --- | --- | --- |
| 0 | 解析参数（缺版本号/changes → 打印用法退出） | 退出，不动文件 |
| 1 | `./preflight.sh --planned-version <版本>`（透传 `--skip-tests`） | **中止，不碰任何文件** |
| 2 | 版本号格式校验 `x.y.z` / `x.y.z-beta.1` | 退出 |
| 3 | 改 `android/app/build.gradle`：`versionCode` **+1**、`versionName` = 新版本 | 回滚 `git checkout --` |
| 4 | 写 `CHANGELOG.md`：在最新一条前插入 `## <版本> (<日期>) — <首条变更短标题>` + 变更列表 | 回滚 |
| 5 | `git add android/app/build.gradle CHANGELOG.md && git commit -m "chore: 发布 <版本>"` | 回滚（工作区还原） |
| 6 | 构建：`heavy-run pnpm build[:internal]` → `npx cap sync android` → `(cd android && heavy-run ./gradlew assembleDebug)` | 中止（已 commit，手动 `git reset --hard HEAD~1`） |
| 7 | 上传 dl.rose7.cn：APK 落位 + 原子替换 `releases.json` | 报错退出（构建已成功，可重跑） |
| 8 | `git push origin main` → `gh release create v<版本> --target <HEAD>` → 校验 tag 指向，指错就强制修正 | 只告警，退出码仍 0（主站已成功） |
| 9 | 汇总：构建类型 / versionCode / commit / 两条链接 | — |

### 发版前先演练（强烈建议第一次用这个）

```bash
./release-apk.sh 1.5.0 --internal "预演" --dry-run
```

输出九步计划 + 新 `versionCode`/`versionName`/构建类型，**一个字节都不改**。
想先看门禁清单：`./preflight.sh --dry-run`。

### 重发（幂等）

同版本号可以重跑：`releases.json` 覆盖同版本记录、APK 覆盖同名文件、GitHub 走 `upload --clobber + edit`。
脚本在发现远端已有同版本时会**先警告**“这是重发”。重发前记得把 `versionCode` 也重新 +1（脚本每次都会 +1）。

---

## 3. 门禁九项：查什么、失败怎么办

| # | 检查项 | 具体做法 | 失败时怎么修 |
| --- | --- | --- | --- |
| 1 | git 工作区干净 | `git status --porcelain` 必须为空 | `git commit -m '...'` 或 `git stash`；**别用 `git add -A`**（仓库里常有其它 agent 的改动） |
| 2 | TypeScript 类型检查 | `pnpm type`（= `tsc -p tsconfig.json`） | 按 tsc 报错修类型 |
| 3 | lint | `pnpm lint`（= `oxlint src rspack.config.ts`） | 修 lint 或 `npx oxlint --fix <file>`；不要改 `.oxlintrc.json` 放水 |
| 4 | unit 测试 | `npm run test`；无脚本时降级 `node --test tests/unit` | 复跑 `npm run test`，只调试失败用例 |
| 5 | integration 测试 | `npm run test:integration`；无脚本时降级 `node --test tests/integration` | 复跑 `npm run test:integration` |
| 6 | e2e 真上游测试 | `npm run test:e2e`（需要 `E2E_API_KEY`）。**没 key → SKIP + 警告，不阻断**；有 key 且失败 → **阻断** | 三步定位：`curl $E2E_UPSTREAM_URL/v1/models` → 看 SSE 是否 flush → 看前端是否解析 |
| 7 | 版本号递增 | 读 `build.gradle` 的 `versionCode`，与 `https://dl.rose7.cn/releases.json` 的 **latest 记录 versionCode** 比较，必须 **strictly >**；网络不通时降级为与 `CHANGELOG.md` 最新版本做 semver 比较 | `versionCode` 提到 `远端+1` 以上（`release-apk.sh` 第 3 步自动 +1；预演用 `--planned-version` 按 +1 口径评估） |
| 8 | CHANGELOG 段落 | `CHANGELOG.md` 必须含 `## <build.gradle 的 versionName>` 段落 | 手写该段；或直接用 `release-apk.sh`（第 4 步自动写） |
| 9 | APK 元信息 | APK 存在时 `aapt2 dump badging` 读 `versionName`/`versionCode`，必须与 `build.gradle` 一致 | 重新构建：`npx cap sync android && (cd android && ./gradlew assembleDebug)` |

额外规则：

- **每项打印 PASS/FAIL + 耗时**，最后输出汇总表（`# / 检查项 / 结果 / 耗时 / 说明`），失败项再列修复建议。
- 退出码：`0` 通过（SKIP 不算失败）、`1` 有 FAIL、`2` 参数错误。
- `SKIP` 只出现在三类情况：未设 `E2E_API_KEY`（第 6 项）、第 4/5 项没有可运行的测试目标、APK 还没构建（第 9 项）。
- 第 7 项只接受 `https://` 开头的 `RELEASES_URL`，防降级到 http。

---

## 4. 应急通道 `--skip-tests`：代价与留痕

```bash
./release-apk.sh 1.5.1 --internal --skip-tests "紧急修复：白屏"
```

- 跳过的是**第 4/5/6 项**（unit / integration / e2e 真上游）。第 1/2/3/7/8/9 项**仍然会跑**。
- 脚本和门禁都会打印**醒目警告横幅**（`!!!!!!!!` 框），不会静默跳过。
- **留痕方式**（自动，不用手写）：
  1. `CHANGELOG.md` 的版本标题后追加 ` [未过门禁]`；
  2. GitHub Release notes 末尾追加一行说明“本次发布使用 `--skip-tests`：unit / integration / e2e 未执行……”；
  3. 发布汇总里也会打印 `⚠️ 本次 --skip-tests：4/5/6 未跑`。
- **代价**：这条链路未经真上游 + 真前端验证，SSE 解析、鉴权头、构建模式错配这类问题会直接漏到用户手里。
  仅在“线上已经炸了、先止血”时使用，并在发布说明里写清原因。

---

## 5. 回滚

| 对象 | 操作 |
| --- | --- |
| APK / 站点 | `ssh aliyun 'rm -f /var/www/dl/apk/deepseek-chat-<ver>.apk'` |
| `releases.json` | 删掉该版本记录并把 `latest` 改回上一版（编辑后保持 JSON 合法）；脚本本身用临时文件 + `os.replace` 原子替换，不会写坏 |
| GitHub Release | `gh release delete v<ver> --repo zzy-repo/deepseek-app --yes`；只想下架就先 `gh release edit v<ver> --draft` |
| tag | `git push origin :refs/tags/v<ver>`（删远端）→ `git tag -d v<ver>`（删本地） |
| 发布 commit（构建后失败） | `git reset --hard HEAD~1`（脚本第 5 步建的是单个 `chore: 发布 <ver>` commit） |
| 未 commit 的改动 | 脚本自动回滚；手工兜底：`git checkout -- android/app/build.gradle CHANGELOG.md` |
| CHANGELOG | 删除该版本 `## <ver> ...` 段落（连同其下的列表项） |
| tag 指错 commit | 脚本会自动 `git push -f origin <HEAD>:refs/tags/v<ver>` 更正；失败时按提示手工执行 |

---

## 6. 常见失败与处置

| 现象 | 原因 | 处置 |
| --- | --- | --- |
| 门禁第 1 项 FAIL，列出文件 | 有未提交改动（常见：另一个 agent 正在改代码） | `git commit` 或 `git stash`；不要 `git add -A` 连带提交别人的东西 |
| 门禁第 7 项 FAIL「没有递增」 | `versionCode` 没超过线上 latest | 手工 +1，或直接让 `release-apk.sh` 跑（第 3 步自动 +1） |
| 门禁第 7 项说“网络不可用 → 降级比较” | 拉不到 `releases.json`（DNS/断网） | 恢复网络；降级结果只是依据 CHANGELOG，风险自负 |
| 门禁第 9 项 FAIL「APK 是旧的」 | APK 还是上一版 | 重新 `npx cap sync android && (cd android && ./gradlew assembleDebug)` |
| 门禁第 5 项超时/大量失败 | 测试用例正在被重构（文件在移动） | 等改动落定再发；急发只能 `--skip-tests`（要留痕） |
| 第 6 步 `gradlew assembleDebug` 失败 | JDK/SDK 路径、keystore 缺失 | 先 `./build-apk.sh` 走一遍；`android/keystore/keystore.properties` 缺失会自动生成 |
| 第 7 步 scp 超时 | ECS 网络抖动 | 重跑同版本（幂等）；`heavy-run` 通道失败会自动回退普通 `scp` |
| 第 8 步 `gh release` 失败 | token 失效 / 代理没设 / API 限流 | `gh auth status` 检查；`export HTTPS_PROXY=...`；修好后同版本重跑或补 `--no-github` 发主站 |
| tag 指向旧 commit | 没先 push 就建 tag（历史坑） | 脚本已用 `--target <HEAD>` + push 顺序 + 事后校验三重保险；仍失败按提示 `git push -f` |
| 「这是重发」警告 | 同版本已发布过 | 确认是真重发就继续（会覆盖）；否则换版本号 |
| 手机装不上新包 | `versionCode` 未增 | 见第 7 项；确认 `aapt2 dump badging` 的 versionCode 已变 |

---

## 7. 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `APK_SRC` | `android/app/build/outputs/apk/debug/app-debug.apk` | 待发布 APK |
| `AAPT2` | `/root/android-sdk/build-tools/35.0.0/aapt2` | 读 APK 的 versionCode/versionName |
| `REMOTE` | `aliyun` | ssh 别名（ECS） |
| `BASE_URL` | `https://dl.rose7.cn` | 下载站根地址（notes 直链同步变化） |
| `GH_REPO` | `zzy-repo/deepseek-app` | GitHub 仓库 |
| `RELEASES_URL` | `https://dl.rose7.cn/releases.json` | 门禁第 7 项比对源（必须 https） |
| `E2E_API_KEY` | （空） | 门禁第 6 项；为空则 SKIP |
| `SKIP_WEB_BUILD` | `0` | `=1` 复用现有 `dist/`（跳过前端构建，内部调试用） |
| `UNIT_CMD` / `INTEGRATION_CMD` / `E2E_CMD` | （空） | 覆盖门禁默认测试命令 |

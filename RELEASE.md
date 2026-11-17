# APK 发布 · 双发（dl.rose7.cn + GitHub Release）

一条命令把同一个 APK 同时发到两处，**dl.rose7.cn 为主发布，GitHub Release 为追加步骤**。

## 1. 一条命令双发

```bash
cd /root/deepseek-app
./release-apk.sh 1.2.3 "修复 A" "修复 B"
```

流程（顺序固定）：

1. 校验版本号格式（`x.y.z` 或 `x.y.z-suffix`）+ 至少一条 changes
2. `aapt2 dump badging` 从 APK 自身读 `versionCode`/`versionName`（不信手填；versionName 与发布号不一致只告警）
3. 算 md5 / 大小，scp 到 ECS 暂存目录 → 原子落位 `/var/www/dl/apk/` → 原子替换 `releases.json`
4. **GitHub Release**：`gh release create v$VERSION <apk> --title v$VERSION --notes-file <tmp> --latest`
5. 打印双发汇总

## 2. Release notes 从哪来

- 优先：`CHANGELOG.md` 里 `## <版本号>` 那一段（到下个 `## ` 标题为止，版本号需精确匹配，`1.2.2` 不会命中 `1.2.20`）
- 兜底：用命令行的 changes 参数生成「更新内容」列表
- 末尾**统一追加**两行：

  ```
  APK 直链：https://dl.rose7.cn/apk/deepseek-chat-<ver>.apk
  微信/QQ 内打不开，请复制链接到浏览器打开
  ```

- 临时 notes 文件写在 `/tmp/relapk.XXXXXX/`，脚本退出时随临时目录一起删除。
- 想改 notes 内容 → 改 `CHANGELOG.md` 对应段落，不要手改 GitHub 上的 release（下次发版会被覆盖）。

## 3. 幂等规则

| 情况 | 行为 |
| --- | --- |
| tag release 不存在 | `gh release create` 创建，APK 作为资产上传 |
| tag release 已存在 | `gh release upload --clobber` 覆盖资产 + `gh release edit --notes-file --latest` 更新说明 |
| dl.rose7.cn 同版本重发 | `releases.json` 覆盖自己那条记录（不新增），APK 覆盖同名文件 |

所以**同版本号可以放心重跑**，不会产生重复 release、不会报「already exists」。

## 4. `--no-github`（应急）

GitHub 挂了 / 没网 / 只急着给用户下载链接时：

```bash
./release-apk.sh --no-github 1.2.3 "修复 A"     # 只发 dl.rose7.cn
./release-apk.sh 1.2.3 "修复 A" --no-github     # 放在末尾也行
```

跳过 GitHub 步骤，汇总里显示 `⏭️  GitHub Release 已跳过（--no-github）`。

## 5. 失败策略

GitHub 步骤失败**不会**让整个发布失败（APK 用户此刻已经从 dl.rose7.cn 拿得到）：

- stderr 打印醒目警告 `⚠️ GitHub Release 发布失败，dl.rose7.cn 已成功` + gh 错误原文
- 汇总里 GitHub 一行显示 `❌`
- **脚本退出码仍为 0**（主发布成功）；想判断 GitHub 是否成功请看汇总输出，别只看 `$?`

补救：修好后**用同一个版本号再跑一次**（走 upload/edit 分支），或先 `--no-github` 发主站、之后再补 GitHub。

## 6. gh 凭据与代理

- `gh` 版本 2.45.0，凭据在 `/root/.config/gh/hosts.yml`（账号 `zzy-repo`，`repo` + `workflow` scope；**不要提交进 git，它是明文 token**）
- 检查：`gh auth status`
- 换账号：`gh auth login` 或改 `hosts.yml`
- 目标仓库可用 `GH_REPO` 覆盖，默认 `zzy-repo/deepseek-app`：
  ```bash
  GH_REPO=zzy-repo/deepseek-app ./release-apk.sh 1.2.3 "修复 A"
  ```
- 网络不通时（GitHub API 直连超时）设代理，`gh` 会读 `HTTPS_PROXY`：
  ```bash
  export HTTPS_PROXY=http://127.0.0.1:7890 https_proxy=http://127.0.0.1:7890
  ```
  （`gh` 同时认大写/小写；本机实测直连 GitHub API 正常，代理仅作兜底）

## 7. 其他环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `APK_SRC` | `android/app/build/outputs/apk/debug/app-debug.apk` | 待发布 APK |
| `AAPT2` | `/root/android-sdk/build-tools/35.0.0/aapt2` | 读 versionCode |
| `REMOTE` | `aliyun` | ssh 别名（ECS） |
| `BASE_URL` | `https://dl.rose7.cn` | 下载站根地址（同时用于 notes 里的直链，改这个两处一起变） |
| `GH_REPO` | `zzy-repo/deepseek-app` | GitHub 仓库 |
| `CHANGELOG` | 脚本同目录 `CHANGELOG.md` | notes 来源 |

## 8. 站点结构与回滚

- 站点：https://dl.rose7.cn/ （ECS，`ssh aliyun`）
- 结构：`/var/www/dl/{index.html,releases.json,apk/deepseek-chat-<ver>.apk}`
- 回滚 dl.rose7.cn：从 `releases.json` 删该条 + 删 `apk/` 下该文件（历史版本互不影响）
- 回滚 GitHub：`gh release delete v<ver> --yes`（或 `gh release edit v<ver> --draft` 先下架）
- 回滚 Caddy：`cp -a /opt/caddy/Caddyfile.bak-dlmigrate-20261117-173804 /opt/caddy/Caddyfile && (set -a;. /opt/caddy/caddy.env;set +a;/opt/caddy/caddy-alidns reload --config /opt/caddy/Caddyfile --adapter caddyfile --address unix//run/caddy/admin.sock)`

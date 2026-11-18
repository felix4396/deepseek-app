#!/usr/bin/env bash
# =============================================================================
# release-tests/run-mock-tests.sh —— 发布脚本的隔离验收（不联网、不真发版）
#
# 在**临时 git 仓库**里用 mock 的 curl / gh 验证：
#   1 dry-run 零副作用
#   2 门禁失败即阻断（不改文件、不 commit、不上传）
#   3 HTTP 失败（401 / 409 / md5 不符）阻断 + 状态/提示正确
#   4 同 artifact 续发：跳过构建与上传、versionCode 不重复递增
#   5 远端 tag 指错 commit：停下报错，不 force 改 tag
#   6 成功路径：接口返回 md5/version 与本地核对、tag 精确推送、不创建 Release
#
# 用法: ./release-tests/run-mock-tests.sh      （退出码 0 = 全部通过）
# 依赖: bash / git / python3 / awk；不依赖网络、Android SDK、gh、真 curl
# =============================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK=$(mktemp -d /tmp/relmock.XXXXXX)
PASS=0; FAIL=0; FAILED_NAMES=()

cleanup(){ rm -rf "${WORK}"; }
trap cleanup EXIT

ok(){ PASS=$((PASS+1)); printf '  ✅ %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); FAILED_NAMES+=("$*"); printf '  ❌ %s\n' "$*"; }
assert_eq(){ [[ "$2" == "$3" ]] && ok "$1（$3）" || bad "$1（期望 $3，实际 $2）"; }
assert_ne(){ [[ "$2" != "$3" ]] && ok "$1" || bad "$1（不应等于 $3）"; }
assert_contains(){ [[ "$2" == *"$3"* ]] && ok "$1" || bad "$1（输出里没有「$3」）"; }
count_in(){ local n; n=$(grep -c "$2" "$3" 2>/dev/null); printf '%s' "${n:-0}"; }
md5_of(){ md5sum "$1" | awk '{print $1}'; }

# ---------------------------------------------------------------- mock bin
BIN="${WORK}/bin"; mkdir -p "${BIN}"
MOCK_LOG="${WORK}/mock.log"; : >"${MOCK_LOG}"

cat >"${BIN}/curl" <<'MOCK'
#!/usr/bin/env bash
# mock curl：只支持发布脚本用到的两种调用（GET releases.json / POST api/v1/release）
echo "CURL $*" >> "$MOCK_LOG"
url=''; out=''; hdr=''; fields=()
while (( $# )); do
  case "$1" in
    -o) out=$2; shift 2;;
    -D) hdr=$2; shift 2;;
    -w) shift 2;;
    -F) fields+=("$2"); shift 2;;
    -H) shift 2;;
    --max-time) shift 2;;
    -X) shift 2;;
    -*) shift;;
    *) url=$1; shift;;
  esac
done
case "$url" in
  *releases.json*)
    if [[ "${MOCK_NET:-ok}" == "netfail" ]]; then echo "curl: (7) Failed to connect" >&2; exit 7; fi
    printf '%s' "${MOCK_RELEASES_JSON:-{\"latest\":\"\",\"releases\":[]}}"
    exit 0;;
  *api/v1/release*)
    : >"${MOCK_LOG}.post"
    for f in "${fields[@]}"; do
      case "$f" in
        apk=@*) src=${f#apk=@};;
        meta=*) meta=${f#meta=};;
      esac
    done
    [[ -n "${out}" ]] || out=/dev/null
    [[ -n "${hdr}" ]] && printf 'Retry-After: 1\r\n' >"${hdr}"
    code=${MOCK_HTTP:-200}
    if [[ "${MOCK_NET:-ok}" == "netfail" ]]; then echo "curl: (7) Failed to connect" >&2; exit 7; fi
    case "$code" in
      200)
        md5=${MOCK_MD5_OVERRIDE:-$(md5sum "${src}" | cut -d' ' -f1)}
        ver=${MOCK_VERSION_OVERRIDE:-$(printf '%s' "${meta}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["version"])')}
        printf '{"ok":true,"url":"https://dl.rose7.cn/apk/deepseek-chat-%s.apk","latest":"%s","md5":"%s"}' \
          "${ver}" "${ver}" "${md5}" >"${out}"
        printf '%s' 200;;
      429) printf '{"ok":false,"error":{"code":"RATE_LIMITED","message":"slow down"}}' >"${out}"; printf 429;;
      401) printf '{"ok":false,"error":{"code":"UNAUTHORIZED","message":"bad token"}}' >"${out}"; printf 401;;
      409) printf '{"ok":false,"error":{"code":"VERSION_CONFLICT","message":"downgrade"}}' >"${out}"; printf 409;;
      *)   printf '{"ok":false,"error":{"code":"INTERNAL","message":"boom"}}' >"${out}"; printf '%s' "${code}";;
    esac
    exit 0;;
  *) echo "mock curl: 未预期 URL $url" >&2; exit 2;;
esac
MOCK

cat >"${BIN}/gh" <<'MOCK'
#!/usr/bin/env bash
echo "GH $*" >> "$MOCK_LOG"
case "$1 $2" in
  "release view")
    if [[ "${MOCK_GH_RELEASE:-missing}" == "exists" ]]; then echo '{"tagName":"x"}'; exit 0; fi
    echo 'release not found' >&2; exit 1;;
  *) exit 0;;
esac
MOCK
chmod +x "${BIN}/curl" "${BIN}/gh"

# ---------------------------------------------------------------- 临时仓库
new_repo(){
  local d="$1"; rm -rf "$d"; mkdir -p "$d/android/app"
  cp "${ROOT}/preflight.sh" "${ROOT}/release-apk.sh" "$d/"
  cp "${ROOT}/android/app/build.gradle" "$d/android/app/build.gradle"
  cp "${ROOT}/CHANGELOG.md" "$d/CHANGELOG.md"
  # 让 gradle 从已知状态开始
  sed -i 's/^\([[:space:]]*\)versionCode .*/\1versionCode 10/; s/^\([[:space:]]*\)versionName .*/\1versionName "1.4.0-beta.3"/' "$d/android/app/build.gradle"
  printf '#!/usr/bin/env bash\nprintf "%%s\\n" "$*" >> "$PREFLIGHT_LOG"\nexit 0\n' >"$d/preflight-ok.sh"; chmod +x "$d/preflight-ok.sh"
  printf '#!/usr/bin/env bash\necho "门禁桩：故意失败" >&2\nexit 1\n' >"$d/preflight-fail.sh"; chmod +x "$d/preflight-fail.sh"
  (
    cd "$d"
    git init -q -b main .
    git config user.email t@t; git config user.name t
    git add -A >/dev/null; git commit -qm init
    git init -q --bare "${d}.origin.git"
    git remote add origin "${d}.origin.git"
    git push -q origin main
  )
  cp "$d/android/app/build.gradle" "${d}.gradle.initial"
  cp "$d/CHANGELOG.md" "${d}.changelog.initial"
}

# 运行发布脚本：所有外部依赖都被替换/指向临时仓库
run_rel(){  # <repo> <args...>
  local d=$1; shift
  (
    cd "$d" || exit 99
    PATH="${BIN}:${PATH}" \
    MOCK_LOG="${MOCK_LOG}" \
    GRADLE="$d/android/app/build.gradle" \
    CHANGELOG="$d/CHANGELOG.md" \
    APK_SRC="$d/app-debug.apk" \
    PREFLIGHT="${PREFLIGHT_OVERRIDE:-$d/preflight-ok.sh}" \
    PREFLIGHT_LOG="${WORK}/preflight.args" \
    DL_API_URL="https://dl.rose7.cn/api/v1/release" \
    DL_RELEASES_URL="https://dl.rose7.cn/releases.json" \
    DL_RELEASE_TOKEN="${MOCK_TOKEN_ENV-test-token-not-real}" \
    DL_TOKEN_FILE="${MOCK_TOKEN_FILE:-$d/.token-unused}" \
    DL_STATE_DIR="$d/state" \
    GH_REPO="test/repo" \
    GIT_REMOTE="origin" \
    RELEASE_BUILD_CMD="printf 'fake-apk-content-%s' \"\$RANDOM\" > '$d/app-debug.apk'" \
    RELEASE_APK_META_CMD="awk '/versionCode/{vc=\$2} /versionName/{gsub(/\"/,\"\",\$2);vn=\$2} END{print vc, vn}' '$d/android/app/build.gradle'" \
    MOCK_HTTP="${MOCK_HTTP:-200}" \
    MOCK_NET="${MOCK_NET:-ok}" \
    MOCK_MD5_OVERRIDE="${MOCK_MD5_OVERRIDE:-}" \
    MOCK_VERSION_OVERRIDE="${MOCK_VERSION_OVERRIDE:-}" \
    MOCK_GH_RELEASE="${MOCK_GH_RELEASE:-missing}" \
    MOCK_RELEASES_JSON="${MOCK_RELEASES_JSON:-{\"latest\":\"\",\"releases\":[]}}" \
    ./release-apk.sh "$@"
  )
}
gradle_vc(){ sed -n 's/^[[:space:]]*versionCode[[:space:]]\+\([0-9]\+\).*/\1/p' "$1/android/app/build.gradle" | head -1; }
repo_dirty(){ ( cd "$1" && git status --porcelain | tr -d ' ' ); }

printf '=== 发布脚本隔离验收（mock，不联网）===\n临时目录 %s\n' "${WORK}"

# ---------------------------------------------------------------- 1. dry-run
printf '\n[1] dry-run 零副作用\n'
R1="${WORK}/r1"; new_repo "$R1"
before_g=$(md5_of "$R1/android/app/build.gradle"); before_c=$(md5_of "$R1/CHANGELOG.md")
before_head=$(git -C "$R1" rev-parse HEAD)
OUT=$(MOCK_RELEASES_JSON='{"latest":"1.4.0-beta.3","releases":[{"version":"1.4.0-beta.3","versionCode":10}]}' \
      run_rel "$R1" 9.9.9-dryrun --internal "dry run 测试" --dry-run 2>&1)
rc=$?
assert_eq 'dry-run 退出码 0' "$rc" 0
assert_contains '打印“将执行”链' "$OUT" '将执行：改 gradle → 写 CHANGELOG → commit → 构建 → 上传 → push+tag'
assert_contains '打印九步（第 8 步 tag/workflow）' "$OUT" 'push + tag'
assert_contains '显示 versionCode 规划' "$OUT" 'versionCode   10 → 11'
assert_eq 'build.gradle 未变' "$(md5_of "$R1/android/app/build.gradle")" "$before_g"
assert_eq 'CHANGELOG 未变' "$(md5_of "$R1/CHANGELOG.md")" "$before_c"
assert_eq 'HEAD 未变' "$(git -C "$R1" rev-parse HEAD)" "$before_head"
assert_eq '工作区干净' "$(repo_dirty "$R1")" ''
assert_eq '没有上传调用' "$(count_in x 'api/v1/release' "${MOCK_LOG}")" 0
[[ -f "$R1/state/9.9.9-dryrun.json" ]] && bad 'dry-run 不应写状态文件' || ok '未写状态文件'

# ---------------------------------------------------------------- 2. 门禁失败阻断
printf '\n[2] 门禁失败即阻断（不碰文件/不 commit/不上传）\n'
R2="${WORK}/r2"; new_repo "$R2"
: >"${MOCK_LOG}"
OUT=$(PREFLIGHT_OVERRIDE="$R2/preflight-fail.sh" run_rel "$R2" 1.5.0 --internal "测试阻断" 2>&1)
rc=$?
assert_eq '退出码非 0' "$rc" 1
assert_contains '提示门禁未通过' "$OUT" '门禁未通过'
assert_eq 'gradle 未改' "$(md5_of "$R2/android/app/build.gradle")" "$(md5_of "${R2}.gradle.initial")"
assert_eq 'CHANGELOG 未改' "$(md5_of "$R2/CHANGELOG.md")" "$(md5_of "${R2}.changelog.initial")"
assert_eq '没有新 commit' "$(git -C "$R2" rev-list --count HEAD)" 1
assert_eq '没有上传' "$(count_in x 'api/v1/release' "${MOCK_LOG}")" 0

# ---------------------------------------------------------------- 3. HTTP 失败
printf '\n[3] HTTP 失败阻断\n'
R3="${WORK}/r3"; new_repo "$R3"
OUT=$(MOCK_HTTP=401 run_rel "$R3" 1.5.0 --internal "令牌错" 2>&1); rc=$?
assert_eq '401 → 退出码 1' "$rc" 1
assert_contains '401 提示令牌' "$OUT" '401 UNAUTHORIZED'
R4="${WORK}/r4"; new_repo "$R4"
OUT=$(MOCK_HTTP=409 MOCK_RELEASES_JSON='{"latest":"1.4.0-beta.3","releases":[{"version":"1.4.0-beta.3","versionCode":10}]}' \
      run_rel "$R4" 1.5.0 --internal "版本冲突" 2>&1); rc=$?
assert_contains '409 提示 versionCode 递增' "$OUT" '409 VERSION_CONFLICT'
R5="${WORK}/r5"; new_repo "$R5"
OUT=$(MOCK_MD5_OVERRIDE='deadbeefdeadbeefdeadbeefdeadbeef' run_rel "$R5" 1.5.0 --internal "md5 不符" 2>&1); rc=$?
assert_eq 'md5 不符 → 退出码 1' "$rc" 1
assert_contains 'md5 不符提示' "$OUT" '服务端 md5'

# ---------------------------------------------------------------- 4. 成功 + 续发
printf '\n[4] 成功路径 + 同 artifact 续发（versionCode 不重复递增）\n'
R6="${WORK}/r6"; new_repo "$R6"
: >"${MOCK_LOG}"
OUT=$(MOCK_RELEASES_JSON='{"latest":"1.4.0-beta.3","releases":[{"version":"1.4.0-beta.3","versionCode":10}]}' \
      run_rel "$R6" 1.5.0 --internal "新增：甲" "修复：乙" --wait-release 5 2>&1); rc=$?
assert_eq '成功路径退出码 0' "$rc" 0
assert_eq 'versionCode 10→11' "$(gradle_vc "$R6")" 11
assert_contains '核对服务端 md5' "$OUT" '服务端 md5'
assert_contains 'tag 已推送' "$OUT" '已推送'
assert_contains '不宣称全链路完成' "$OUT" '不宣称全链路已完成'
assert_eq 'tag 指向发布 commit' "$(git -C "$R6" rev-parse "refs/tags/v1.5.0")" "$(git -C "$R6" rev-parse HEAD)"
assert_eq '脚本未创建 Release（只有 view）' "$(count_in x 'GH release create' "${MOCK_LOG}")" 0
assert_eq '状态文件 dl=ok' "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["dl"]["status"])' "$R6/state/1.5.0.json")" ok
HEAD1=$(git -C "$R6" rev-parse HEAD); VC1=$(gradle_vc "$R6")
OUT2=$(MOCK_RELEASES_JSON='{"latest":"1.5.0","releases":[{"version":"1.5.0","versionCode":11}]}' \
       run_rel "$R6" 1.5.0 --internal "新增：甲" "修复：乙" 2>&1); rc2=$?
assert_eq '续发退出码 0' "$rc2" 0
assert_contains '续发跳过构建' "$OUT2" '跳过构建'
assert_contains '续发跳过上传' "$OUT2" '跳过重复上传'
assert_eq '续发 versionCode 不递增' "$(gradle_vc "$R6")" "$VC1"
assert_eq '续发不产生新 commit' "$(git -C "$R6" rev-parse HEAD)" "$HEAD1"
assert_eq '续发 tag 复用' "$(git -C "$R6" rev-parse "refs/tags/v1.5.0")" "$HEAD1"

# ---------------------------------------------------------------- 5. tag 冲突
printf '\n[5] 远端 tag 指错 commit → 停下报错、不 force\n'
R7="${WORK}/r7"; new_repo "$R7"
git -C "$R7" tag v1.6.0 "$(git -C "$R7" rev-parse HEAD)"
git -C "$R7" push -q origin refs/tags/v1.6.0
git -C "$R7" tag -d v1.6.0 >/dev/null
OUT=$(MOCK_RELEASES_JSON='{"latest":"1.5.0","releases":[{"version":"1.5.0","versionCode":11}]}' \
      run_rel "$R7" 1.6.0 --internal "tag 冲突" 2>&1); rc=$?
assert_eq 'tag 冲突退出码 3（部分成功）' "$rc" 3
assert_contains '明确报错并交人工' "$OUT" '脚本不会自动 force 改 tag'
assert_eq '远端 tag 未被改写' "$(git -C "${R7}.origin.git" rev-parse refs/tags/v1.6.0)" "$(git -C "$R7" rev-parse "HEAD~1")"
assert_eq 'dl 仍算已发布' "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["dl"]["status"])' "$R7/state/1.6.0.json")" ok

# ---------------------------------------------------------------- 6. 网络不可用 + 版本降级
printf '\n[6] releases.json 不可用 → 门禁降级 + 上传失败阻断\n'
R8="${WORK}/r8"; new_repo "$R8"
OUT=$(MOCK_NET=netfail run_rel "$R8" 1.5.0 --internal "断网" 2>&1); rc=$?
assert_eq '断网上传失败退出码 1' "$rc" 1
assert_contains '上传失败提示' "$OUT" '上传失败'

# ---------------------------------------------------------------- 7. 令牌来源
printf '\n[7] 令牌来源：文件（600）可用 / 缺失时明确报错\n'
R9="${WORK}/r9"; new_repo "$R9"
umask 077; printf 'file-token-for-mock\n' >"${R9}.token"; chmod 600 "${R9}.token"
OUT=$(MOCK_TOKEN_ENV='' MOCK_TOKEN_FILE="${R9}.token" \
      MOCK_RELEASES_JSON='{"latest":"1.4.0-beta.3","releases":[{"version":"1.4.0-beta.3","versionCode":10}]}' \
      run_rel "$R9" 1.5.0 --internal "文件令牌" 2>&1); rc=$?
assert_eq '文件令牌发布成功' "$rc" 0
R10="${WORK}/r10"; new_repo "$R10"
OUT=$(MOCK_TOKEN_ENV='' MOCK_TOKEN_FILE="${R10}.missing" run_rel "$R10" 1.5.0 --internal "缺令牌" 2>&1); rc=$?
assert_eq '缺令牌 → 退出码 1' "$rc" 1
assert_contains '缺令牌提示（含路径/chmod 600）' "$OUT" 'chmod 600'

# ---------------------------------------------------------------- 8. --skip-upstream-e2e 精细开关
printf '\n[8] --skip-upstream-e2e：只跳过真实模型上游 e2e\n'
R11="${WORK}/r11"; new_repo "$R11"
: >"${WORK}/preflight.args"
OUT=$(run_rel "$R11" 1.5.0 --internal "精细开关" --skip-upstream-e2e 2>&1); rc=$?
assert_eq '带开关可发布' "$rc" 0
assert_contains '门禁收到 --skip-upstream-e2e' "$(cat "${WORK}/preflight.args")" '--skip-upstream-e2e'
assert_contains 'CHANGELOG 标题留痕' "$(cat "$R11/CHANGELOG.md")" '[上游e2e待补测]'
assert_contains 'CHANGELOG 写明待补测' "$(cat "$R11/CHANGELOG.md")" '真实模型上游测试待发布后补测'
assert_eq '状态文件记录 skipUpstreamE2E' \
  "$(python3 -c 'import json,sys;print(json.load(open(sys.argv[1]))["skipUpstreamE2E"])' "$R11/state/1.5.0.json")" True
assert_contains '汇总提示延后补测' "$OUT" '真实模型上游 e2e 延后补测'
assert_eq '未使用全量 --skip-tests' "$(count_in x -- '--skip-tests' "${WORK}/preflight.args")" 0
# 两种 skip 不能同时用
OUT=$(run_rel "$R11" 1.6.0 --internal "冲突" --skip-tests --skip-upstream-e2e 2>&1); rc=$?
assert_eq '--skip-tests 与 --skip-upstream-e2e 互斥' "$rc" 1
assert_contains '互斥提示' "$OUT" '不能同时用'

# 真实 preflight 的门禁路由（临时仓库 + run-layer 桩）
PF="${WORK}/pf"; rm -rf "$PF"; mkdir -p "$PF/android/app" "$PF/tests/e2e"
cp "${ROOT}/preflight.sh" "$PF/"; cp "${ROOT}/CHANGELOG.md" "$PF/"; cp "${ROOT}/android/app/build.gradle" "$PF/android/app/"
sed -i 's/versionCode .*/versionCode 10/; s/versionName .*/versionName "1.4.0-beta.3"/' "$PF/android/app/build.gradle"
printf '{"name":"t","scripts":{"type":"true","lint":"true","test":"true","test:integration":"true","test:e2e":"node tests/run-layer.mjs e2e"}}\n' >"$PF/package.json"
printf 'import {appendFileSync} from "node:fs"\nappendFileSync(process.env.RL_LOG, process.argv.slice(2).join(" ")+"\\n")\n' >"$PF/tests/run-layer.mjs"
: >"$PF/tests/e2e/diagnostics-upload.test.mjs"; : >"$PF/tests/e2e/real-upstream.test.mjs"
( cd "$PF" && git init -q -b main . && git config user.email t@t && git config user.name t && git add -A >/dev/null && git commit -qm init )
pf_run(){ ( cd "$PF" && RL_LOG="${WORK}/rl.log" RELEASES_URL="https://127.0.0.1:1/x" E2E_API_KEY="${2:-}" ./preflight.sh --planned-version 1.5.0 --planned-versioncode 11 ${1:-} 2>&1 ); }
: >"${WORK}/rl.log"
OUT=$(pf_run --skip-upstream-e2e); rc=$?
assert_eq 'preflight + --skip-upstream-e2e 通过' "$rc" 0
assert_contains '上传类 e2e 已跑' "$(cat "${WORK}/rl.log")" 'diagnostics-upload'
assert_eq '真实上游 e2e 未跑' "$(count_in x real-upstream "${WORK}/rl.log")" 0
assert_contains '第 6 项标 SKIP 且写明待补测' "$OUT" '待发布后补测'
: >"${WORK}/rl.log"
OUT=$(pf_run ''); rc=$?
assert_eq '无 key 无开关 → 阻断' "$rc" 1
assert_contains '缺 key 提示指向精细开关' "$OUT" '--skip-upstream-e2e'
assert_eq '无 key 时不跑上游用例' "$(count_in x real-upstream "${WORK}/rl.log")" 0
: >"${WORK}/rl.log"
OUT=$(pf_run '' 'dummy-key-for-routing-only'); rc=$?
assert_eq '有 key 时照跑上游 e2e' "$(count_in x real-upstream "${WORK}/rl.log")" 1
assert_contains '有 key 时通过' "$OUT" '真实模型上游 e2e 全部通过'

printf '\n=== 结果：通过 %d，失败 %d ===\n' "${PASS}" "${FAIL}"
if (( FAIL )); then
  printf '失败项：\n'; for n in "${FAILED_NAMES[@]}"; do printf '  - %s\n' "$n"; done
  exit 1
fi
printf '✅ 全部通过（mock 环境，未真实联网/上传/推送/创建 Release）\n'

#!/usr/bin/env bash
# release-apk.sh — 一条命令发布 APK：门禁 → 版本号 → CHANGELOG → commit → 构建 → 双发
#
# 用法: ./release-apk.sh <x.y.z[-suffix]> (--internal|--standard) "变更1" "变更2" ... [选项]
#   --internal   内部构建（heavy-run pnpm build:internal）
#   --standard   标准/对外构建（heavy-run pnpm build）
#   --skip-tests 门禁里跳过 unit/integration/e2e 三项；CHANGELOG 标题与 Release notes 会留痕
#   --dry-run    只打印九步计划：不改文件、不 commit、不构建、不上传、不打 tag
#   --no-github  只发 dl.rose7.cn（应急）
#
# 幂等：同版本号重跑 = 覆盖（releases.json 覆盖同版本记录；GitHub 已存在则 upload --clobber + edit）。
# 失败策略：commit 之前失败 → 自动 git checkout 回滚 build.gradle/CHANGELOG；
#           commit 之后失败 → 已生成发布 commit，用 git reset --hard HEAD~1 撤销。
#           dl.rose7.cn 成功即算发布成功；GitHub 步骤失败只告警，退出码仍为 0。
set -euo pipefail

REMOTE=${REMOTE:-aliyun}
APK_SRC=${APK_SRC:-/root/deepseek-app/android/app/build/outputs/apk/debug/app-debug.apk}
AAPT2=${AAPT2:-/root/android-sdk/build-tools/35.0.0/aapt2}
BASE_URL=${BASE_URL:-https://dl.rose7.cn}
REMOTE_ROOT=/var/www/dl
GH_REPO=${GH_REPO:-zzy-repo/deepseek-app}
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHANGELOG=${CHANGELOG:-${ROOT_DIR}/CHANGELOG.md}
GRADLE=${GRADLE:-${ROOT_DIR}/android/app/build.gradle}
PREFLIGHT=${PREFLIGHT:-${ROOT_DIR}/preflight.sh}
GRADLE_REL=${GRADLE#${ROOT_DIR}/}
CHANGELOG_REL=${CHANGELOG#${ROOT_DIR}/}
TAG_PREFIX=v
SKIP_WEB_BUILD=${SKIP_WEB_BUILD:-0}
export SKIP_WEB_BUILD

TOUCHED=0      # build.gradle / CHANGELOG 已被改动且尚未 commit
COMMITTED=0    # 发布 commit 已建立

info(){ printf '  %s\n' "$*"; }
warn(){ printf '%s\n' "$*" >&2; }
step(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

rollback_files(){
  ( cd "${ROOT_DIR}" && git reset -q HEAD -- "${GRADLE_REL}" "${CHANGELOG_REL}" 2>/dev/null || true
    cd "${ROOT_DIR}" && git checkout -- "${GRADLE_REL}" "${CHANGELOG_REL}" 2>/dev/null || true ) || true
}
fail_cleanup(){
  if (( COMMITTED )); then
    warn "  ⚠️ 已创建发布 commit（$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null)），文件未回滚；撤销：cd ${ROOT_DIR} && git reset --hard HEAD~1"
  elif (( TOUCHED )); then
    rollback_files
    warn "  ↩️  已回滚 ${GRADLE_REL} 与 ${CHANGELOG_REL}（git checkout --）"
  fi
}
die(){ printf '\nERROR: %s\n' "$*" >&2; fail_cleanup; exit 1; }

usage(){
  cat <<'USAGE'
用法: ./release-apk.sh <x.y.z[-suffix]> (--internal|--standard) "变更1" "变更2" ... [选项]

  一条命令做完九步：门禁 → 版本号 → CHANGELOG → commit → 构建 → 上传 dl → 发 GitHub Release → 汇总

  必需:
    <x.y.z[-suffix]>      版本号，如 1.5.0 / 1.5.0-beta.1
    "变更1" "变更2" ...    至少一条，会写进 CHANGELOG 与 Release notes
    --internal | --standard
                          --internal → heavy-run pnpm build:internal（内测构建）
                          --standard → heavy-run pnpm build（对外构建，缺省值）

  选项:
    --skip-tests          跳过门禁第 4/5/6 项（unit/integration/e2e）；CHANGELOG 标题加 [未过门禁]
    --dry-run             只打印九步计划：不改文件、不 commit、不构建、不上传、不打 tag
    --no-github           只发 dl.rose7.cn，跳过 GitHub Release（应急）
    -h, --help            本帮助

  示例:
    ./release-apk.sh 1.5.0 --internal "新增：会话自动标题" "修复：手动改名被覆盖"
    ./release-apk.sh 1.5.0 --standard --dry-run "预演一次"
    ./release-apk.sh 1.5.0 --internal --skip-tests "紧急修崩溃"
USAGE
}

# --- 0) 解析参数（选项可放在任意位置）---
NO_GITHUB=0; SKIP_TESTS=0; DRY_RUN=0; BUILD_TYPE=''
ARGS=()
for a in "$@"; do
  case "$a" in
    --internal) BUILD_TYPE=internal ;;
    --standard) BUILD_TYPE=standard ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --no-github) NO_GITHUB=1 ;;
    -h|--help) usage; exit 0 ;;
    --*) usage >&2; die "未知选项: $a" ;;
    *) ARGS+=("$a") ;;
  esac
done
set -- ${ARGS[@]+"${ARGS[@]}"}

VER="${1:-}"; shift || true
CHANGES=("$@")
if [[ -z ${VER} ]]; then usage >&2; die '缺少版本号'; fi
if (( ${#CHANGES[@]} == 0 )); then usage >&2; die '至少给一条 changes（写人能看懂这次改了什么）'; fi
for c in "${CHANGES[@]}"; do [[ -n ${c// /} ]] || die 'changes 里有空字符串'; done
if [[ -z ${BUILD_TYPE} ]]; then
  BUILD_TYPE=standard
  warn '  ! 未指定 --internal/--standard，默认按 --standard（对外构建）'
fi
[[ -x ${PREFLIGHT} ]] || die "门禁脚本不可执行: ${PREFLIGHT}（先 chmod +x preflight.sh）"
[[ -f ${GRADLE} ]] || die "找不到 ${GRADLE}"
TAG="${TAG_PREFIX}${VER}"

# --- 版本号读取 / 工具 ---
gradle_versioncode(){ sed -n 's/^[[:space:]]*versionCode[[:space:]]\+\([0-9]\+\).*/\1/p' "${GRADLE}" | head -1; }
gradle_versionname(){ sed -n 's/^[[:space:]]*versionName[[:space:]]"\([^"]*\)".*/\1/p' "${GRADLE}" | head -1; }
OLD_VC=$(gradle_versioncode); OLD_VN=$(gradle_versionname)
[[ -n ${OLD_VC} && -n ${OLD_VN} ]] || die "读不到 ${GRADLE_REL} 的 versionCode/versionName"
NEW_VC=$(( OLD_VC + 1 ))

short_title(){
  python3 - "$1" <<'PY'
import re,sys
s=sys.argv[1]
s=re.sub(r'^\s*(新增|修复|优化|变更|调整|移除|删除|文档|重构|测试|性能)[：:]\s*','',s)
s=re.split(r'[。；;，,]',s)[0].strip()
print(s[:20])
PY
}
SHORT=$(short_title "${CHANGES[0]}")
[ -n "${SHORT}" ] || SHORT="${CHANGES[0]:0:20}"
DATE_STR=$(TZ=Asia/Shanghai date +%F)
TITLE_SUFFIX=''
if (( SKIP_TESTS )); then TITLE_SUFFIX=' [未过门禁]'; fi

# 只读检查：远端是否已发过这个版本（重发提醒）
check_republish(){
  local json out same rmax
  json=$(curl -fsS --max-time 12 "${BASE_URL}/releases.json" 2>/dev/null || true)
  if [[ -z ${json} ]]; then info "读不到 ${BASE_URL}/releases.json（跳过重复版本检查）"; return 0; fi
  out=$(printf '%s' "${json}" | python3 -c '
import json,sys
ver=sys.argv[1]
try: d=json.load(sys.stdin)
except Exception: print("0 0"); raise SystemExit
rel=d.get("releases") or []
same=any(str(r.get("version"))==ver for r in rel)
vcs=[int(r.get("versionCode") or 0) for r in rel]
print("%d %d"%(1 if same else 0,max(vcs) if vcs else 0))
' "${VER}" 2>/dev/null || echo "0 0")
  same=${out%% *}; rmax=${out##* }
  if [[ ${same} == 1 ]]; then
    warn "  ⚠️ ${VER} 已在 dl.rose7.cn 发布过：本次是【重发】，releases.json 覆盖同版本记录、APK 覆盖同名文件"
  fi
  if (( rmax >= NEW_VC )); then
    warn "  ⚠️ 远端最大 versionCode=${rmax} >= 本次 ${NEW_VC}：手机端可能不认为是升级，检查 ${GRADLE_REL}"
  fi
  return 0
}

# --- dry-run：只打印九步计划，然后立刻退出（零副作用）---
if (( DRY_RUN )); then
  if [[ ! ${VER} =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
    die "版本号必须形如 1.5.0 或 1.5.0-beta.1，收到: ${VER}"
  fi
  if [[ ${BUILD_TYPE} == internal ]]; then WEB_CMD='heavy-run pnpm build:internal'; else WEB_CMD='heavy-run pnpm build'; fi
  if (( SKIP_TESTS )); then GATE_DESC='九项中 4/5/6 跳过（--skip-tests，会留痕 [未过门禁]）'; else GATE_DESC='九项全跑'; fi
  printf '\n\033[1;33m[dry-run] 发布演练：不改文件 / 不 commit / 不构建 / 不上传 / 不打 tag\033[0m\n'
  printf '  版本          %s\n' "${VER}"
  printf '  构建类型      %s（%s）\n' "${BUILD_TYPE}" "${WEB_CMD}"
  printf '  versionCode   %s → %s\n' "${OLD_VC}" "${NEW_VC}"
  printf '  versionName   %s → %s\n' "${OLD_VN}" "${VER}"
  printf '  门禁          ./preflight.sh --planned-version %s（%s）\n' "${VER}" "${GATE_DESC}"
  printf '  CHANGELOG     将插入: ## %s (%s) — %s%s\n' "${VER}" "${DATE_STR}" "${SHORT}" "${TITLE_SUFFIX}"
  printf '  重复版本检查  %s\n' "${BASE_URL}/releases.json（只读）"
  printf '\n  将执行：改 gradle → 写 CHANGELOG → commit → 构建 → 上传 → 发 Release\n'
  printf '  1) ./preflight.sh --planned-version %s   发布门禁九项（失败即中止，不碰任何文件）\n' "${VER}"
  printf '  2) 版本号格式校验                          x.y.z / x.y.z-beta.1（收到 %s）\n' "${VER}"
  printf '  3) 改 %s            versionCode %s→%s，versionName→%s\n' "${GRADLE_REL}" "${OLD_VC}" "${NEW_VC}" "${VER}"
  printf '  4) 写 CHANGELOG.md                         插入 "## %s (%s) — %s"%s\n' "${VER}" "${DATE_STR}" "${SHORT}" "${TITLE_SUFFIX}"
  printf '  5) commit                                  git add %s CHANGELOG.md && git commit -m "chore: 发布 %s"\n' "${GRADLE_REL}" "${VER}"
  printf '  6) 构建                                    %s → npx cap sync android → (cd android && heavy-run ./gradlew assembleDebug)\n' "${WEB_CMD}"
  printf '  7) 上传 dl.rose7.cn                        apk/deepseek-chat-%s.apk + 原子替换 releases.json\n' "${VER}"
  printf '  8) GitHub Release                          git push origin main → gh release create %s --target <HEAD> → 校验 tag 指向\n' "${TAG}"
  printf '  9) 汇总                                    打印 APK URL / GitHub Release 链接\n'
  check_republish >/dev/null 2>&1 || true
  printf '\n  \033[1;32m✅ dry-run 结束：以上仅为计划，工作区未被改动\033[0m\n'
  exit 0
fi

# --- 1) 发布门禁（失败即中止，此时还没碰任何文件）---
step "1/9 门禁 preflight"
PF_ARGS=(--planned-version "${VER}")
if (( SKIP_TESTS )); then PF_ARGS+=(--skip-tests); fi
info "./preflight.sh ${PF_ARGS[*]}"
if ! "${PREFLIGHT}" "${PF_ARGS[@]}"; then
  die '门禁未通过：发布中止（build.gradle / CHANGELOG / git 都没有被改动）'
fi

# --- 2) 版本号格式 ---
step "2/9 版本号格式校验"
if [[ ! ${VER} =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]]; then
  die "版本号必须形如 1.5.0 或 1.5.0-beta.1，收到: ${VER}"
fi
info "${VER} 合法（tag 将是 ${TAG}）"

# --- 2.5) 重复版本检查（只读告警）---
check_republish

# --- 3) 改 build.gradle：versionCode +1 / versionName = VER ---
step "3/9 改 ${GRADLE_REL}"
TOUCHED=1
if ! python3 - "${GRADLE}" "${VER}" <<'PY'
import re,sys
p,ver=sys.argv[1],sys.argv[2]
s=open(p,encoding='utf-8').read()
mc=re.search(r'(?m)^([ \t]*)versionCode[ \t]+(\d+)',s)
mn=re.search(r'(?m)^([ \t]*)versionName[ \t]+"([^"]*)"',s)
if not mc or not mn:
    sys.stderr.write('versionCode/versionName 行找不到\n'); sys.exit(1)
newvc=int(mc.group(2))+1
s=s[:mc.start()]+"%sversionCode %d"%(mc.group(1),newvc)+s[mc.end():]
mn=re.search(r'(?m)^([ \t]*)versionName[ \t]+"([^"]*)"',s)
s=s[:mn.start()]+'%sversionName "%s"'%(mn.group(1),ver)+s[mn.end():]
open(p,'w',encoding='utf-8').write(s)
PY
then
  die "改 ${GRADLE_REL} 失败"
fi
CHK_VC=$(gradle_versioncode); CHK_VN=$(gradle_versionname)
if [[ ${CHK_VC} != "${NEW_VC}" || ${CHK_VN} != "${VER}" ]]; then
  die "改完后校验不一致（versionCode=${CHK_VC} versionName=${CHK_VN}，期望 ${NEW_VC}/${VER}）"
fi
info "versionCode ${OLD_VC} → ${NEW_VC}；versionName ${OLD_VN} → ${VER}"

# --- 4) 写 CHANGELOG（插在最新一条之前）---
step "4/9 写 ${CHANGELOG_REL}"
if ! python3 - "${CHANGELOG}" "${VER}" "${DATE_STR}" "${TITLE_SUFFIX}" "${CHANGES[@]}" <<'PY'
import re,sys
path,ver,date,suffix=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4]
changes=sys.argv[5:]
text=open(path,encoding='utf-8').read()
if re.search(r'(?m)^##[ \t]+'+re.escape(ver)+r'([ \t(]|$)',text):
    print('EXISTS'); raise SystemExit(0)
short=re.sub(r'^\s*(新增|修复|优化|变更|调整|移除|删除|文档|重构|测试|性能)[：:]\s*','',changes[0])
short=re.split(r'[。；;，,]',short)[0].strip()[:20]
title='## %s (%s) — %s%s'%(ver,date,short,suffix)
block=[title,'']+['- %s'%c for c in changes]+['']
lines=text.split('\n')
idx=None
for i,l in enumerate(lines):
    if l.startswith('## '): idx=i; break
if idx is None:
    new=lines+['']+block
else:
    new=lines[:idx]+block+lines[idx:]
open(path,'w',encoding='utf-8').write('\n'.join(new))
print('INSERTED')
PY
then
  die "写 ${CHANGELOG_REL} 失败"
fi
if ! grep -qE "^##[[:space:]]+${VER}([[:space:](]|$)" "${CHANGELOG}"; then
  die "写完校验失败：${CHANGELOG_REL} 里找不到 '## ${VER}' 段落"
fi
info "已写入 '## ${VER} (${DATE_STR}) — ${SHORT}${TITLE_SUFFIX}'"
if (( SKIP_TESTS )); then
  warn "  ⚠️ --skip-tests 生效：CHANGELOG 标题已标 [未过门禁]，Release notes 会追加说明行"
fi

# --- 5) commit ---
step "5/9 commit"
if ! ( cd "${ROOT_DIR}" && git add "${GRADLE_REL}" "${CHANGELOG_REL}" && git commit -q -m "chore: 发布 ${VER}" ); then
  die 'commit 失败（检查 git 身份配置 / pre-commit hook）'
fi
COMMITTED=1
COMMIT_SHA=$(git -C "${ROOT_DIR}" rev-parse --short HEAD)
info "commit ${COMMIT_SHA}  chore: 发布 ${VER}"

# --- 6) 构建 ---
step "6/9 构建（${BUILD_TYPE}）"
if [[ ${SKIP_WEB_BUILD} == 1 && -f "${ROOT_DIR}/dist/index.html" ]]; then
  info "SKIP_WEB_BUILD=1：复用现有 dist/（跳过前端构建）"
else
  if [[ ${BUILD_TYPE} == internal ]]; then WEB_CMD=(pnpm build:internal); else WEB_CMD=(pnpm build); fi
  if command -v heavy-run >/dev/null 2>&1; then
    info "heavy-run ${WEB_CMD[*]}"
    if ! ( cd "${ROOT_DIR}" && heavy-run "${WEB_CMD[@]}" ); then die "前端构建失败: ${WEB_CMD[*]}"; fi
  else
    info "${WEB_CMD[*]}（无 heavy-run，直接跑）"
    if ! ( cd "${ROOT_DIR}" && "${WEB_CMD[@]}" ); then die "前端构建失败: ${WEB_CMD[*]}"; fi
  fi
fi
info 'npx cap sync android'
if ! ( cd "${ROOT_DIR}" && npx cap sync android ); then die 'npx cap sync android 失败'; fi
info '(cd android && heavy-run ./gradlew assembleDebug)'
if command -v heavy-run >/dev/null 2>&1; then
  if ! ( cd "${ROOT_DIR}/android" && heavy-run ./gradlew assembleDebug ); then die 'gradlew assembleDebug 失败'; fi
else
  if ! ( cd "${ROOT_DIR}/android" && ./gradlew assembleDebug ); then die 'gradlew assembleDebug 失败'; fi
fi
[[ -s ${APK_SRC} ]] || die "构建后 APK 不存在或为空: ${APK_SRC}"
[[ -x ${AAPT2} ]] || die "aapt2 不可执行: ${AAPT2}"
info "APK $(stat -c%s "${APK_SRC}") B  ${APK_SRC}"

# --- 0.5) 记下本机 HEAD：GitHub Release 的 tag 必须钉在这个 commit 上 ---
#   坑（已踩两次）：`gh release create` 不给 --target 时，gh 用「远端默认分支当前 sha」建 tag；
#   如果本地 commit 还没 push，远端还是旧 sha → release tag 指向错误 commit。
#   所以这里先固定 HEAD_SHA，后面用 --target + push 顺序 + 事后校验三重保险。
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GH_BRANCH_NAME=${GH_BRANCH_NAME:-main}
HEAD_SHA=''
if HEAD_SHA=$(git -C "${ROOT_DIR}" rev-parse HEAD 2>/dev/null); then
  [[ -n ${HEAD_SHA} ]] || { HEAD_SHA=''; warn '  ! 读不到 git HEAD，tag 指向将不做校验'; }
else
  HEAD_SHA=''
  warn '  ! 当前目录不是可用的 git 仓库，GitHub Release 的 tag 指向将不做校验'
fi
# 只有拿到 HEAD 才把 --target 拼进命令（避免空值让 gh 报错）
TARGET_ARGS=()
if [[ -n ${HEAD_SHA} ]]; then TARGET_ARGS=(--target "${HEAD_SHA}"); fi

# --- 1) 从 APK 自身读 versionCode / versionName（不信手填）---
BADGING=$("${AAPT2}" dump badging "${APK_SRC}" 2>/dev/null) || die "aapt2 读取失败: ${APK_SRC}"
VCODE=$(printf '%s\n' "${BADGING}" | sed -n "s/^package:.* versionCode='\([0-9]*\)'.*/\1/p" | head -1)
VNAME=$(printf '%s\n' "${BADGING}" | sed -n "s/^package:.* versionName='\([^']*\)'.*/\1/p" | head -1)
[[ -n ${VCODE} ]] || die '读不到 versionCode（APK 是否损坏？）'
if [[ ${VNAME} != "${VER}" ]]; then
  warn "  ! APK 内 versionName=${VNAME:-?}，本次发布号=${VER}（按发布号入库）"
fi

# --- 2) 校验和 / 大小 ---
SIZE=$(stat -c%s "${APK_SRC}")
MD5=$(md5sum "${APK_SRC}" | cut -d' ' -f1)

TMPD=$(mktemp -d /tmp/relapk.XXXXXX)
STAGE="${REMOTE_ROOT}/.stage-${VER}"
NOTES_FILE="${TMPD}/release-notes-${VER}.md"   # 放在 /tmp 下的临时 notes，退出即删
cleanup(){ rm -rf "${TMPD}"; ssh "$REMOTE" "rm -rf '${STAGE}'" 2>/dev/null || true; }
trap cleanup EXIT
NEW_APK="${TMPD}/deepseek-chat-${VER}.apk"
cp -f "${APK_SRC}" "${NEW_APK}"
NOW=$(TZ=Asia/Shanghai date +%Y-%m-%dT%H:%M:%S+08:00)

python3 - "${VER}" "${VCODE}" "${NOW}" "${SIZE}" "${MD5}" "${CHANGES[@]}" >"${TMPD}/entry.json" <<'PY'
import json,sys
ver,vcode,now,size,md5=sys.argv[1:6]
json.dump({"version":ver,"versionCode":int(vcode),"releasedAt":now,
           "file":"apk/deepseek-chat-%s.apk"%ver,"size":int(size),"md5":md5,
           "changes":sys.argv[6:],"breaking":False},
          sys.stdout,ensure_ascii=False,indent=2)
PY

# --- 3) 上传到远端暂存目录（重活走 heavy-run）---
ssh "$REMOTE" "rm -rf '${STAGE}' && mkdir -p '${STAGE}' && install -d -m 755 ${REMOTE_ROOT}/apk"
SCP=(scp -q -o BatchMode=yes)
if command -v heavy-run >/dev/null 2>&1; then SCP=(heavy-run scp -q -o BatchMode=yes); fi
if ! "${SCP[@]}" "${NEW_APK}" "${TMPD}/entry.json" "${REMOTE}:${STAGE}/"; then
  warn '  ! heavy-run 通道失败，回退普通 scp'
  scp -q -o BatchMode=yes "${NEW_APK}" "${TMPD}/entry.json" "${REMOTE}:${STAGE}/"
fi

# --- 4) 远端原子落位：APK 先就位，再原子替换 releases.json ---
ssh "$REMOTE" bash -s -- "${VER}" "${STAGE}" <<'REMOTE'
set -euo pipefail
VER="$1"; STAGE="$2"; ROOT=/var/www/dl
trap 'rm -rf "$STAGE"' EXIT
[ -s "$STAGE/deepseek-chat-$VER.apk" ] || { echo "staged apk missing" >&2; exit 1; }
[ -s "$STAGE/entry.json" ]           || { echo "staged entry.json missing" >&2; exit 1; }
chmod 644 "$STAGE/deepseek-chat-$VER.apk" "$STAGE/entry.json"
install -d -m 755 "$ROOT/apk"
mv -f "$STAGE/deepseek-chat-$VER.apk" "$ROOT/apk/deepseek-chat-$VER.apk"
python3 - "$VER" "$STAGE/entry.json" "$ROOT" <<'PY'
import json,os,sys,tempfile
ver,entry_path,root=sys.argv[1:4]
rj=os.path.join(root,"releases.json")
entry=json.load(open(entry_path,encoding="utf-8"))
try:
    data=json.load(open(rj,encoding="utf-8"))
except FileNotFoundError:
    data={"latest":"","releases":[]}
if not isinstance(data.get("releases"),list): data["releases"]=[]
data["releases"]=[r for r in data["releases"] if r.get("version")!=ver]   # 幂等：覆盖同版本
data["releases"].insert(0,entry)
data["latest"]=max(data["releases"],key=lambda r:(int(r.get("versionCode") or 0),r.get("releasedAt") or ""))["version"]
fd,tmp=tempfile.mkstemp(dir=root,prefix=".releases.",suffix=".tmp")
with os.fdopen(fd,"w",encoding="utf-8") as f:
    json.dump(data,f,ensure_ascii=False,indent=2); f.write("\n"); f.flush(); os.fsync(f.fileno())
os.chmod(tmp,0o644)
os.replace(tmp,rj)
print("releases.json: latest=%s count=%d"%(data["latest"],len(data["releases"])))
PY
REMOTE

DL_OK=1
printf '✅ dl.rose7.cn 发布完成 %s\n' "${VER}"
info "URL   ${BASE_URL}/apk/deepseek-chat-${VER}.apk"
info "大小  ${SIZE} B  MD5 ${MD5}  versionCode ${VCODE}"

# =====================================================================
# 5) GitHub Release（追加步骤；失败不影响整体发布）
# =====================================================================

# 5.1) 生成 notes：优先 CHANGELOG 的 "## $VER" 段落，否则用 changes 参数
changelog_section(){
  [[ -r ${CHANGELOG} ]] || return 1
  local body
  body=$(awk -v ver="${VER}" '
    $0 ~ "^##[[:space:]]+" ver "([^0-9A-Za-z._-]|$)" { found=1; next }
    found && /^##[[:space:]]/ { exit }
    found { print }
  ' "${CHANGELOG}")
  # 去掉首尾空行
  body=$(printf '%s\n' "${body}" | sed -e '/./,$!d' | tac | sed -e '/./,$!d' | tac)
  [[ -n ${body//[$' \t\n']/} ]] || return 1
  printf '%s\n' "${body}"
}

make_notes(){
  local body src
  if body=$(changelog_section); then
    src="CHANGELOG.md"
    {
      printf '## %s\n\n' "${VER}"
      printf '%s\n' "${body}"
    } >"${NOTES_FILE}"
  else
    src="changes 参数"
    {
      printf '## %s\n\n' "${VER}"
      printf '更新内容：\n\n'
      local c
      for c in "${CHANGES[@]}"; do printf -- '- %s\n' "${c}"; done
    } >"${NOTES_FILE}"
  fi
  # 统一追加 APK 直链
  {
    printf '\nAPK 直链：%s/apk/deepseek-chat-%s.apk\n' "${BASE_URL}" "${VER}"
  } >>"${NOTES_FILE}"
  # --skip-tests 留痕：notes 里必须能看出这次没跑测试
  if (( SKIP_TESTS )); then
    {
      printf '\n> ⚠️ 本次发布使用 `--skip-tests`：unit / integration / e2e 未执行，'
      printf '仅通过类型检查、lint、版本号递增、CHANGELOG 段落校验。\n'
    } >>"${NOTES_FILE}"
  fi
  NOTES_SRC="${src}"
}

# 5.2) 幂等发布：已存在 → upload --clobber + edit；不存在 → create
gh_publish(){
  local view_out existing
  if view_out=$(gh release view "${TAG}" --repo "${GH_REPO}" 2>&1); then
    existing=1
  elif printf '%s' "${view_out}" | grep -qiE 'not found|could not find|release not found|HTTP 404'; then
    existing=0
  else
    printf '%s\n' "${view_out}" >&2
    return 1
  fi

  if (( existing )); then
    GH_BRANCH='upload/edit'
    gh release upload "${TAG}" "${NEW_APK}" --repo "${GH_REPO}" --clobber
    gh release edit   "${TAG}" --repo "${GH_REPO}" --title "${TAG}" \
                       --notes-file "${NOTES_FILE}" --latest
  else
    GH_BRANCH='create'
    # --target 必须显式给：否则 gh 用「远端默认分支当前 sha」建 tag，本地 commit 还没 push 时 tag 会指到旧 commit
    gh release create "${TAG}" "${NEW_APK}" --repo "${GH_REPO}" --title "${TAG}" \
                       "${TARGET_ARGS[@]+"${TARGET_ARGS[@]}"}" \
                       --notes-file "${NOTES_FILE}" --latest
  fi
}

# 5.2.5) 建 Release 之前先把 main 推到远端（顺序不能反：先让远端追上本地 HEAD，再建 tag）
push_main(){
  if [[ -z ${HEAD_SHA} ]]; then
    warn '  ! 跳过 push main（拿不到本机 HEAD）'
    return 0
  fi
  info "git push origin HEAD:${GH_BRANCH_NAME}（让远端追上本地 ${HEAD_SHA:0:8}）"
  if git -C "${ROOT_DIR}" push origin "HEAD:${GH_BRANCH_NAME}"; then
    return 0
  fi
  warn "  ! push ${GH_BRANCH_NAME} 失败；仍会用 --target ${HEAD_SHA:0:8} 钉 tag，稍后校验会兜底"
  return 1
}

# 5.2.6) 事后校验：远端 tag 的 sha 必须等于本机 HEAD，不一致立刻报错并强制更正 tag
verify_tag_target(){
  if [[ -z ${HEAD_SHA} ]]; then
    return 0
  fi
  local remote_sha=''
  # 附注对象 tag 读 ^{}，轻量 tag（gh 默认创建的形态）读不带 ^{} 的 ref，两者都试
  remote_sha=$(git -C "${ROOT_DIR}" ls-remote origin "refs/tags/${TAG}^{}" 2>/dev/null | cut -f1 | head -1)
  if [[ -z ${remote_sha} ]]; then
    remote_sha=$(git -C "${ROOT_DIR}" ls-remote origin "refs/tags/${TAG}" 2>/dev/null | cut -f1 | head -1)
  fi
  if [[ -z ${remote_sha} ]]; then
    warn "  ! 读不到远端 tag ${TAG} 的 sha，跳过 tag 指向校验（可用 gh release view ${TAG} --json targetCommitish 复核）"
    return 0
  fi
  if [[ ${remote_sha} == "${HEAD_SHA}" ]]; then
    info "tag ${TAG} → ${remote_sha:0:8}（与本机 HEAD 一致）"
    return 0
  fi
  warn "  ⚠️ tag ${TAG} 指向 ${remote_sha:0:8}，但本机 HEAD 是 ${HEAD_SHA:0:8}：tag 指错了，立即更正"
  if git -C "${ROOT_DIR}" push -f origin "${HEAD_SHA}:refs/tags/${TAG}"; then
    warn "  ✅ 已强制更正 tag ${TAG} → ${HEAD_SHA:0:8}"
    return 0
  fi
  warn "  ❌ 强制更正 tag 失败，请手动执行：git push -f origin ${HEAD_SHA}:refs/tags/${TAG}"
  return 1
}

GH_OK=0
TAG_BROKEN=0
GH_BRANCH='skipped'
if (( NO_GITHUB )); then
  info 'GitHub 已跳过（--no-github）'
else
  # 顺序铁律：先 push main（远端追上本地 HEAD），再建 Release。
  # 反过来做会踩 tag 指向错误的老坑（gh 用远端默认分支 sha 建 tag）。
  push_main || true
  make_notes
  info "notes 来源 ${NOTES_SRC}  → ${NOTES_FILE}"
  GH_ERR_FILE="${TMPD}/gh.err"
  # 不用命令替换：否则 gh_publish 里的 GH_BRANCH 会丢在子 shell 里
  if gh_publish 2>"${GH_ERR_FILE}"; then
    GH_OK=1
    info "GitHub Release OK（${GH_BRANCH} 分支）"
    # 第三道保险：建完立刻核对 tag 指向，不等于本机 HEAD 就报错并强制更正
    if ! verify_tag_target; then
      TAG_BROKEN=1
      printf '  ⚠️ tag %s 指向未修正，请人工处理（本机 HEAD %s）\n' "${TAG}" "${HEAD_SHA:0:8}" >&2
    fi
  else
    GH_OK=0
    gh_err=$(cat "${GH_ERR_FILE}" 2>/dev/null || true)
    printf '\n' >&2
    printf '  ⚠️ GitHub Release 发布失败，dl.rose7.cn 已成功\n' >&2
    printf '  ---- gh 错误原文 ----\n' >&2
    printf '%s\n' "${gh_err}" >&2
    printf '  ---------------------\n' >&2
    printf '  修复后可用同版本重跑（幂等），或加 --no-github 跳过。\n\n' >&2
  fi
  rm -f "${NOTES_FILE}"
fi

# --- 9) 汇总 ---
printf '\n发布汇总 %s\n' "${VER}"
printf '  构建 %s   versionCode %s (%s→%s)   commit %s\n' "${BUILD_TYPE}" "${NEW_VC}" "${OLD_VC}" "${NEW_VC}" "$(git -C "${ROOT_DIR}" rev-parse --short HEAD 2>/dev/null || echo '?')"
if (( SKIP_TESTS )); then
  printf '⚠️  本次 --skip-tests：4/5/6 未跑，CHANGELOG/notes 已标 [未过门禁]\n'
fi
printf '✅ dl.rose7.cn   %s/apk/deepseek-chat-%s.apk\n' "${BASE_URL}" "${VER}"
if (( NO_GITHUB )); then
  printf '⏭️  GitHub Release 已跳过（--no-github）\n'
elif (( GH_OK )); then
  printf '✅ GitHub Release https://github.com/%s/releases/tag/%s\n' "${GH_REPO}" "${TAG}"
else
  printf '❌ GitHub Release 发布失败（见上方 gh 错误原文），dl.rose7.cn 已成功\n'
fi
if (( TAG_BROKEN )); then
  printf '⚠️  tag %s 指向与本机 HEAD（%s）不一致且自动更正失败：请手动 git push -f origin %s:refs/tags/%s\n' \
    "${TAG}" "${HEAD_SHA:0:8}" "${HEAD_SHA:0:8}" "${TAG}"
fi
exit 0

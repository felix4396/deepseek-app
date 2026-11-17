#!/usr/bin/env bash
# release-apk.sh — 一条命令把 APK「双发」：dl.rose7.cn（自建下载站）+ GitHub Release
#
# 用法: ./release-apk.sh <x.y.z[-suffix]> "变更1" "变更2" ... [--no-github]
#   --no-github  只发 dl.rose7.cn，跳过 GitHub Release（应急用）
#
# 幂等：同版本号重跑 = 覆盖（releases.json 覆盖同版本记录；GitHub 已存在则 upload --clobber + edit）。
# 失败策略：dl.rose7.cn 成功即算发布成功；GitHub 步骤失败只告警，退出码仍为 0。
set -euo pipefail

REMOTE=${REMOTE:-aliyun}
APK_SRC=${APK_SRC:-/root/deepseek-app/android/app/build/outputs/apk/debug/app-debug.apk}
AAPT2=${AAPT2:-/root/android-sdk/build-tools/35.0.0/aapt2}
BASE_URL=${BASE_URL:-https://dl.rose7.cn}
REMOTE_ROOT=/var/www/dl
GH_REPO=${GH_REPO:-zzy-repo/deepseek-app}
CHANGELOG=${CHANGELOG:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/CHANGELOG.md}
TAG_PREFIX=v

die(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info(){ printf '  %s\n' "$*"; }
warn(){ printf '%s\n' "$*" >&2; }

usage(){
  cat <<'USAGE'
用法: ./release-apk.sh <x.y.z[-suffix]> "变更1" "变更2" ... [--no-github]

  同时发布到 dl.rose7.cn 与 GitHub Release。
  --no-github      跳过 GitHub Release（应急用；dl.rose7.cn 仍会发布）
  --no-github 之外的位置随意，例如:
      ./release-apk.sh --no-github 1.2.3 "修复 A" "修复 B"
      ./release-apk.sh 1.2.3 "修复 A" --no-github
USAGE
}

# --- 0) 解析参数（--no-github 可放在任意位置）---
NO_GITHUB=0
ARGS=()
for a in "$@"; do
  case "$a" in
    --no-github) NO_GITHUB=1 ;;
    -h|--help) usage; exit 0 ;;
    *) ARGS+=("$a") ;;
  esac
done
set -- ${ARGS[@]+"${ARGS[@]}"}

VER="${1:-}"; shift || true
CHANGES=("$@")
[[ -n ${VER} ]] || { usage >&2; die '缺少版本号'; }
[[ ${VER} =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "版本号必须形如 1.2.3（允许 1.2.3-test 后缀），收到: ${VER}"
(( ${#CHANGES[@]} > 0 )) || die '至少给一条 changes（写人能看懂这次改了什么）'
for c in "${CHANGES[@]}"; do [[ -n ${c// /} ]] || die 'changes 里有空字符串'; done
[[ -s ${APK_SRC} ]] || die "APK 不存在或为空: ${APK_SRC}"
[[ -x ${AAPT2} ]] || die "aapt2 不可执行: ${AAPT2}"
TAG="${TAG_PREFIX}${VER}"

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
    gh release create "${TAG}" "${NEW_APK}" --repo "${GH_REPO}" --title "${TAG}" \
                       --notes-file "${NOTES_FILE}" --latest
  fi
}

GH_OK=0
GH_BRANCH='skipped'
if (( NO_GITHUB )); then
  info 'GitHub 已跳过（--no-github）'
else
  make_notes
  info "notes 来源 ${NOTES_SRC}  → ${NOTES_FILE}"
  GH_ERR_FILE="${TMPD}/gh.err"
  # 不用命令替换：否则 gh_publish 里的 GH_BRANCH 会丢在子 shell 里
  if gh_publish 2>"${GH_ERR_FILE}"; then
    GH_OK=1
    info "GitHub Release OK（${GH_BRANCH} 分支）"
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

# --- 6) 双发汇总 ---
printf '\n发布汇总 %s\n' "${VER}"
printf '✅ dl.rose7.cn   %s/apk/deepseek-chat-%s.apk\n' "${BASE_URL}" "${VER}"
if (( NO_GITHUB )); then
  printf '⏭️  GitHub Release 已跳过（--no-github）\n'
elif (( GH_OK )); then
  printf '✅ GitHub Release https://github.com/%s/releases/tag/%s\n' "${GH_REPO}" "${TAG}"
else
  printf '❌ GitHub Release 发布失败（见上方 gh 错误原文），dl.rose7.cn 已成功\n'
fi
exit 0

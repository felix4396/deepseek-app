#!/usr/bin/env bash
# release-apk.sh — 一条命令发布 APK 到 dl.rose7.cn
# 用法: ./release-apk.sh <x.y.z[-suffix]> "变更1" "变更2" ...
# 幂等：同版本号重跑 = 覆盖（不新增记录）；失败不留半成品（远端暂存目录全清）。
set -euo pipefail

REMOTE=${REMOTE:-aliyun}
APK_SRC=${APK_SRC:-/root/deepseek-app/android/app/build/outputs/apk/debug/app-debug.apk}
AAPT2=${AAPT2:-/root/android-sdk/build-tools/35.0.0/aapt2}
BASE_URL=${BASE_URL:-https://dl.rose7.cn}
REMOTE_ROOT=/var/www/dl

die(){ printf 'ERROR: %s\n' "$*" >&2; exit 1; }
info(){ printf '  %s\n' "$*"; }

VER="${1:-}"; shift || true
CHANGES=("$@")
[[ -n ${VER} ]] || die '用法: ./release-apk.sh <x.y.z[-suffix]> "变更1" "变更2" ...'
[[ ${VER} =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "版本号必须形如 1.2.3（允许 1.2.3-test 后缀），收到: ${VER}"
(( ${#CHANGES[@]} > 0 )) || die '至少给一条 changes（写人能看懂这次改了什么）'
for c in "${CHANGES[@]}"; do [[ -n ${c// /} ]] || die 'changes 里有空字符串'; done
[[ -s ${APK_SRC} ]] || die "APK 不存在或为空: ${APK_SRC}"
[[ -x ${AAPT2} ]] || die "aapt2 不可执行: ${AAPT2}"

# --- 1) 从 APK 自身读 versionCode / versionName（不信手填）---
BADGING=$("${AAPT2}" dump badging "${APK_SRC}" 2>/dev/null) || die "aapt2 读取失败: ${APK_SRC}"
VCODE=$(printf '%s\n' "${BADGING}" | sed -n "s/^package:.* versionCode='\([0-9]*\)'.*/\1/p" | head -1)
VNAME=$(printf '%s\n' "${BADGING}" | sed -n "s/^package:.* versionName='\([^']*\)'.*/\1/p" | head -1)
[[ -n ${VCODE} ]] || die '读不到 versionCode（APK 是否损坏？）'
if [[ ${VNAME} != "${VER}" ]]; then
  printf '  ! APK 内 versionName=%s，本次发布号=%s（按发布号入库）\n' "${VNAME:-?}" "${VER}" >&2
fi

# --- 2) 校验和 / 大小 ---
SIZE=$(stat -c%s "${APK_SRC}")
MD5=$(md5sum "${APK_SRC}" | cut -d' ' -f1)

TMPD=$(mktemp -d /tmp/relapk.XXXXXX)
STAGE="${REMOTE_ROOT}/.stage-${VER}"
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
  printf '  ! heavy-run 通道失败，回退普通 scp\n' >&2
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

# --- 5) 结果 ---
printf '✅ 发布完成 %s\n' "${VER}"
info "URL   ${BASE_URL}/apk/deepseek-chat-${VER}.apk"
info "大小  ${SIZE} B  MD5 ${MD5}  versionCode ${VCODE}"
info "页面  ${BASE_URL}/   清单 ${BASE_URL}/releases.json"

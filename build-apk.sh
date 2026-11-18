#!/usr/bin/env bash
# =============================================================================
# build-apk.sh —— 一条命令出 APK（Capacitor 套壳，对 src/ 零侵入）
#
# 用法:
#   ./build-apk.sh            # debug APK（默认，自动使用 android/keystore/debug.keystore 签名）
#   ./build-apk.sh release    # release APK（使用自签 release keystore）
#   ./build-apk.sh release --clean   # 额外执行 gradlew clean
#
# 可选环境变量:
#   SKIP_WEB_BUILD=1   跳过 pnpm build（复用现有 dist/）
#   ANDROID_HOME=...   覆盖 SDK 路径（默认 $HOME/android-sdk，其次 $ANDROID_SDK_ROOT）
#
# 说明: 本脚本不依赖交互式 shell 环境，自行 export ANDROID_HOME / PATH；
#       首次运行会自动生成 keystore（若 android/keystore/keystore.properties 缺失）。
# =============================================================================
set -euo pipefail

MODE="${1:-debug}"                 # debug | release
EXTRA_ARG="${2:-}"
case "$MODE" in
  debug|release) ;;
  -h|--help|help) sed -n '2,20p' "$0"; exit 0 ;;
  *) echo "[build-apk] 未知模式: $MODE （只支持 debug / release）" >&2; exit 2 ;;
esac

PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_ROOT"
ANDROID_DIR="$PROJECT_ROOT/android"

log() { printf '\n\033[1;36m[build-apk] %s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m[build-apk][ERROR] %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. 环境准备
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/android-sdk}}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
[ -d "$ANDROID_HOME" ] || die "找不到 Android SDK: $ANDROID_HOME （请先按 README.android.md 安装，或 export ANDROID_HOME）"
export PATH="$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$PATH"

# JDK：gradle 需要 JAVA_HOME（没有就按 PATH 里的 java 反推）
if [ -z "${JAVA_HOME:-}" ]; then
  JAVA_BIN="$(command -v java || true)"
  [ -n "$JAVA_BIN" ] || die "找不到 java，需要 JDK 21"
  JAVA_HOME="$(dirname "$(dirname "$(readlink -f "$JAVA_BIN")")")"
  export JAVA_HOME
fi
export PATH="$JAVA_HOME/bin:$PATH"

log "模式=$MODE  ANDROID_HOME=$ANDROID_HOME  JAVA_HOME=$JAVA_HOME"

# local.properties：把 SDK 路径钉进 Gradle（该文件已 gitignore）
printf 'sdk.dir=%s\n' "$ANDROID_HOME" > "$ANDROID_DIR/local.properties"

# --------------------------------------------------- 2. 首次运行自动生成签名材料
KS_DIR="$ANDROID_DIR/keystore"
KS_PROPS="$KS_DIR/keystore.properties"
if [ ! -f "$KS_PROPS" ]; then
  log "未找到 android/keystore/keystore.properties，自动生成 debug + release keystore（仅本机，不提交）"
  mkdir -p "$KS_DIR"
  command -v keytool >/dev/null || die "找不到 keytool（请安装 JDK 21）"
  rand_pass() { head -c 24 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20; }
  REL_PASS="$(rand_pass)"; DBG_PASS="$(rand_pass)"
  [ -f "$KS_DIR/release.keystore" ] || keytool -genkeypair -v -keystore "$KS_DIR/release.keystore" \
    -alias deepseekchat -keyalg RSA -keysize 2048 -validity 10950 -storetype PKCS12 \
    -storepass "$REL_PASS" -keypass "$REL_PASS" \
    -dname "CN=DeepSeek Chat, OU=Dev, O=DeepSeek, L=Shanghai, ST=Shanghai, C=CN" >/dev/null
  [ -f "$KS_DIR/debug.keystore" ] || keytool -genkeypair -v -keystore "$KS_DIR/debug.keystore" \
    -alias androiddebugkey -keyalg RSA -keysize 2048 -validity 10950 -storetype PKCS12 \
    -storepass "$DBG_PASS" -keypass "$DBG_PASS" \
    -dname "CN=Android Debug, O=Android, C=US" >/dev/null
  umask 077
  cat > "$KS_PROPS" <<EOF
# 本地签名凭据 —— 已被 .gitignore 排除，切勿提交
storeFileRelease=../keystore/release.keystore
storePasswordRelease=$REL_PASS
keyAliasRelease=deepseekchat
keyPasswordRelease=$REL_PASS

storeFileDebug=../keystore/debug.keystore
storePasswordDebug=$DBG_PASS
keyAliasDebug=androiddebugkey
keyPasswordDebug=$DBG_PASS
EOF
  chmod 600 "$KS_PROPS"
  log "keystore 生成完成: $KS_DIR"
fi

# ------------------------------------------------------------ 3. 前端构建产物
if [ "${SKIP_WEB_BUILD:-0}" = "1" ] && [ -f "$PROJECT_ROOT/dist/index.html" ]; then
  log "SKIP_WEB_BUILD=1，复用现有 dist/"
else
  log "步骤 1/3：pnpm build（产物 -> dist/）"
  pnpm build
fi
[ -f "$PROJECT_ROOT/dist/index.html" ] || die "dist/index.html 不存在，前端构建失败"

# ------------------------------------------------------ 4. 同步 web 产物到原生工程
log "步骤 2/3：npx cap sync android（dist -> android/app/src/main/assets/public）"
npx cap sync android

# ------------------------------------------------------------ 5. Gradle 出包
if [ "$MODE" = "release" ]; then
  GRADLE_TASK="assembleRelease"; APK_DIR="$ANDROID_DIR/app/build/outputs/apk/release"; APK_NAME="app-release.apk"
else
  GRADLE_TASK="assembleDebug";   APK_DIR="$ANDROID_DIR/app/build/outputs/apk/debug";   APK_NAME="app-debug.apk"
fi

cd "$ANDROID_DIR"
chmod +x ./gradlew
GRADLE_ARGS=("$GRADLE_TASK" "--console=plain")
[ "$EXTRA_ARG" = "--clean" ] && GRADLE_ARGS=("clean" "${GRADLE_ARGS[@]}")

log "步骤 3/3：./gradlew ${GRADLE_ARGS[*]}"
./gradlew "${GRADLE_ARGS[@]}"

APK_PATH="$APK_DIR/$APK_NAME"
[ -f "$APK_PATH" ] || die "构建结束但未找到 APK: $APK_PATH"
APK_PATH="$(readlink -f "$APK_PATH")"
APK_SIZE="$(du -h "$APK_PATH" | cut -f1)"
APK_BYTES="$(stat -c %s "$APK_PATH")"

printf '\n\033[1;32m================ BUILD OK (%s) ================\033[0m\n' "$MODE"
printf 'APK 绝对路径 : %s\n' "$APK_PATH"
printf 'APK 大小     : %s (%s bytes)\n' "$APK_SIZE" "$APK_BYTES"
if command -v aapt2 >/dev/null 2>&1 || ls "$ANDROID_HOME"/build-tools/*/aapt2 >/dev/null 2>&1; then
  AAPT2_BIN="$(command -v aapt2 || ls "$ANDROID_HOME"/build-tools/*/aapt2 | sort -V | tail -1)"
  printf '包名/版本    : %s\n' "$("$AAPT2_BIN" dump badging "$APK_PATH" 2>/dev/null | grep -E "^package:" || echo 'n/a')"
fi
printf '安装命令     : adb install -r "%s"\n' "$APK_PATH"
printf '\033[1;32m==============================================\033[0m\n'

# ------------------------------------- 4. 发布完整性关卡：android:debuggable 必须为 false
# Issue #60：1.0.0～1.4.0-beta.8 共 15 个已发布包都是 debug 变体产物，带 android:debuggable="true"，
# 任何已授权 adb 的机器都能 run-as 读私有数据。这道关卡读 APK 内的 AndroidManifest.xml（不依赖 aapt2），
# release 模式判不过就直接失败，产物留在原地但不许上传/分发。
log "步骤 4：发布完整性关卡（android:debuggable 必须为 false）"
if node "$PROJECT_ROOT/scripts/check-apk-debuggable.mjs" "$APK_PATH"; then
  DEBUGBLE_STATE=clean
else
  DEBUGBLE_STATE=dirty
fi
if [ "$MODE" = "release" ]; then
  [ "$DEBUGBLE_STATE" = "clean" ] || die "release 产物带 android:debuggable=true，禁止上传 dl / 禁止分发（Issue #60）。
  APK: $APK_PATH
  重出包：cd android && ./gradlew :app:assembleRelease -PartifactVariant=internal"
else
  printf '\033[1;33m[警告] debug 变体天生就是 debuggable：只许本地联调 / 模拟器烟测，禁止上传 dl.rose7.cn、禁止当发布包分发（Issue #60）\033[0m\n'
fi

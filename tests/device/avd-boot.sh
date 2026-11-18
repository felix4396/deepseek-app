#!/usr/bin/env bash
# =============================================================================
# avd-boot.sh — 串行启动一台 AVD（兼容性矩阵用），带内存预算守卫
#
#   tests/device/avd-boot.sh compat30 [--mem 1280]
#   tests/device/avd-boot.sh --stop compat30
#
# 设计约束（来自宿主机的真实教训，不要改）：
#   1. 同一时间只允许一台 emulator（宿主 MemAvailable 只有 ~6.5GiB，swap 近满）。
#      启动前 MemAvailable < GUARD_MIB 直接拒启；
#      启动/运行中 MemAvailable < 2048MiB 立即停掉本轮 scope，标记 OOM。
#   2. emulator 会「强制提升」guest RAM（hw.ramSize 写了也不一定生效），
#      所以不猜：先按临时上限起 scope，读日志里真实强制值，
#      再用 systemctl set-property 把 MemoryMax 调成「实际强制 RAM + 800M」。
#   3. 独立 slice（dsh-avd-<avd>.slice），不放进 dsh-heavy.slice ——
#      后者 MemoryMax=4G 是共享父限额，之前把 emulator 和 Gradle 塞一起导致过两次 OOM。
# =============================================================================
set -uo pipefail

SDK=/root/android-sdk
EMU=$SDK/emulator/emulator
ADB=$SDK/platform-tools/adb
GUARD_MIB=${GUARD_MIB:-6144}   # 启动门槛
LOW_MIB=${LOW_MIB:-2048}       # 运行中下限
# emulator 的宿主侧开销（QEMU + swiftshader + WebView 渲染进程）实测比 guest RAM 大：
# API31/Chrome91 在 2048+800=2848M 的 scope 里被 cgroup OOM 干掉（anon-rss 2.89G），
# 所以余量默认提到 1200M，可用 HEADROOM_MIB 覆盖。
HEADROOM_MIB=${HEADROOM_MIB:-1200}
BOOT_TIMEOUT=${BOOT_TIMEOUT:-300}

mem_avail_mib() { awk '/^MemAvailable:/{print int($2/1024)}' /proc/meminfo; }

stop_avd() {
  local avd="$1"
  local unit="avd-$avd"
  systemctl stop "$unit.scope" 2>/dev/null
  pkill -f "qemu-system-x86_64.*-avd $avd" 2>/dev/null
  sleep 3
  echo "[stop] $avd 已停止（残留 qemu: $(pgrep -cf qemu-system-x86_64) 个）"
}

if [ "${1:-}" = "--stop" ]; then
  stop_avd "${2:?usage: avd-boot.sh --stop <avd>}"
  exit 0
fi

AVD="${1:?usage: avd-boot.sh <avd> [--mem N]}"
REQ_MEM=${3:-2048}   # 实测 emulator 对 API30+ 一律强制到 2048MB，直接按 2048 请求，避免「请求 1280 却吃 2048」的预算错位
LOG=/tmp/avd-$AVD.log
SLICE="dsh-avd-$AVD.slice"
UNIT="avd-$AVD"

# ── 守卫 1：串行 ────────────────────────────────────────────────────────────
if pgrep -f "qemu-system-x86_64" >/dev/null; then
  echo "[abort] 已有 emulator 在跑，本机只允许单台（pkill 前不要并行）"
  pgrep -af "qemu-system-x86_64" | sed 's/^/   /'
  exit 13
fi
# ── 守卫 2：内存门槛 ────────────────────────────────────────────────────────
avail=$(mem_avail_mib)
if [ "$avail" -lt "$GUARD_MIB" ]; then
  echo "[abort] MemAvailable=${avail}MiB < ${GUARD_MIB}MiB，不启动（避免 OOM 连坐 DSH）"
  exit 12
fi
echo "[boot] $AVD 可用内存 ${avail}MiB，请求 guest RAM=${REQ_MEM}MiB"

: > "$LOG"
# 上一轮失败/被 OOM 的 transient scope 会残留，先清掉同名 unit 才能复用
systemctl stop "$UNIT.scope" 2>/dev/null
systemctl reset-failed "$UNIT.scope" 2>/dev/null
# 临时上限：先给 3.5G 让 emulator 自己决定强制 RAM，读到真实值后再收紧。
systemd-run --scope --unit="$UNIT" --slice="$SLICE" \
  -p MemoryMax=3584M -p MemorySwapMax=0 -p CPUWeight=50 \
  -- "$EMU" -avd "$AVD" -memory "$REQ_MEM" \
     -no-window -no-audio -no-boot-anim -no-snapshot \
     -gpu swiftshader_indirect -port 5554 \
  >>"$LOG" 2>&1 &
launcher=$!

# ── 等 emulator 打印真实 RAM 决策（emulator 会在启动早期 "Increasing RAM"/"ramSize"）──
forced=""
for _ in $(seq 1 40); do
  sleep 1
  forced=$(grep -oiE "(increasing|setting) ram (size )?(from [0-9]+ ?(mib|mb) )?to [0-9]+ ?(mib|mb)|ram size (is |set to )?[0-9]+ ?(mib|mb)" "$LOG" 2>/dev/null | tail -1)
  [ -n "$forced" ] && break
done
ram_mib=$(printf '%s' "$forced" | grep -oE "[0-9]+" | tail -1)
if [ -z "${ram_mib:-}" ]; then
  ram_mib=$REQ_MEM
  echo "[boot] 日志未出现强制 RAM 提示，按请求值 ${ram_mib}MiB 计预算"
else
  echo "[boot] 日志真实 RAM 决策：$forced  → 取 ${ram_mib}MiB"
fi
# 双保险：预算永远不低于「请求值」——emulator 可能不打印提示但实际仍按更大值分配
[ "$ram_mib" -lt "$REQ_MEM" ] && ram_mib=$REQ_MEM
budget=$((ram_mib + HEADROOM_MIB))
systemctl set-property "$UNIT.scope" MemoryMax="${budget}M" 2>/dev/null && \
  echo "[boot] scope MemoryMax 收紧为 ${budget}M（= 实际 ${ram_mib}MiB + ${HEADROOM_MIB}MiB 余量）"

# ── 等 adb + 开机完成，同时守内存下限 ───────────────────────────────────────
"$ADB" start-server >/dev/null 2>&1
deadline=$((SECONDS + BOOT_TIMEOUT))
booted=0
while [ $SECONDS -lt $deadline ]; do
  avail=$(mem_avail_mib)
  if [ "$avail" -lt "$LOW_MIB" ]; then
    echo "[oom] MemAvailable=${avail}MiB < ${LOW_MIB}MiB → 停止本轮（记为不可判定，不重试同配置）"
    stop_avd "$AVD"; exit 14
  fi
  state=$("$ADB" -s emulator-5554 get-state 2>/dev/null)
  if [ "$state" = "device" ]; then
    done_=$("$ADB" -s emulator-5554 shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')
    if [ "$done_" = "1" ]; then booted=1; break; fi
  fi
  sleep 5
done
if [ "$booted" != "1" ]; then
  echo "[fail] ${BOOT_TIMEOUT}s 内未开机完成；日志尾部："
  tail -n 20 "$LOG"
  stop_avd "$AVD"; exit 15
fi

echo "[boot] $AVD 开机完成（${SECONDS}s）"
echo "[scope] unit=$UNIT.slice  MemoryMax=$(systemctl show -p MemoryMax --value "$UNIT.scope" 2>/dev/null)  peak=$(cat "/sys/fs/cgroup$(systemctl show -p ControlGroup --value "$UNIT.scope" 2>/dev/null)/memory.peak" 2>/dev/null)"
echo "[facts] ro.build.version.release=$("$ADB" -s emulator-5554 shell getprop ro.build.version.release | tr -d '\r')  ro.build.version.sdk=$("$ADB" -s emulator-5554 shell getprop ro.build.version.sdk | tr -d '\r')"
echo "[facts] ro.product.cpu.abi=$("$ADB" -s emulator-5554 shell getprop ro.product.cpu.abi | tr -d '\r')  ro.build.flavor=$("$ADB" -s emulator-5554 shell getprop ro.build.flavor | tr -d '\r')"
echo "[webview]"
"$ADB" -s emulator-5554 shell dumpsys webviewupdate 2>/dev/null | sed -n '1,40p' | sed 's/^/   /' | tee "/tmp/avd-$AVD-webviewupdate.txt"
echo "[mem] 宿主 MemAvailable=$(mem_avail_mib)MiB"

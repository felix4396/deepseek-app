#!/usr/bin/env node
/**
 * check-apk-debuggable.mjs —— 发布完整性关卡：APK 不得是 debuggable 构建。
 *
 * 背景（GitHub Issue #60）：`1.0.0` ～ `1.4.0-beta.8` 共 15 个已发布包全部是 debug 变体产物，
 * APK 里编译进了 `android:debuggable="true"`，任何已授权 adb 的机器都能 `run-as` 读私有目录
 * （shared_prefs / WebView 存储里的服务地址、API Key、会话缓存）或挂 JDWP 调试。
 * 根因是发布路径本身（用 `assembleDebug` 出包），所以关卡必须挂在「产物 → 发布」之间，
 * 而不是指望人记得手敲 aapt2。
 *
 * 判据：解 APK 的 zip，取 `AndroidManifest.xml`（二进制 AXML），读 application 元素的
 *       `android:debuggable`（属性名 debuggable 或资源 id 0x0101000f）。
 *
 * 用法：
 *   node scripts/check-apk-debuggable.mjs <apk> [更多.apk ...] [--json] [--quiet]
 *
 * 退出码：
 *   0  全部通过（无 debuggable 标记）→ 允许发布
 *   1  发现 debuggable 包        → 禁止发布
 *   2  判不出来（不是 APK / 损坏 / 用法错误）→ 同样禁止发布（fail-closed）
 */

import path from 'node:path';
import { inspectApkDebugState } from '../deploy/dl-release/apk-manifest.mjs';

const EXIT_OK = 0;
const EXIT_DEBUGGABLE = 1;
const EXIT_UNKNOWN = 2;

function usage() {
  return [
    '用法: node scripts/check-apk-debuggable.mjs <apk> [更多.apk ...] [--json] [--quiet]',
    '',
    '退出码: 0 通过 / 1 发现 debuggable 包（禁止发布）/ 2 判不出来（同样禁止发布）',
  ].join('\n');
}

function main(argv) {
  const files = [];
  let json = false;
  let quiet = false;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--quiet' || arg === '-q') quiet = true;
    else if (arg === '-h' || arg === '--help') {
      console.log(usage());
      return EXIT_OK;
    } else if (arg.startsWith('-')) {
      console.error(`未知参数: ${arg}\n${usage()}`);
      return EXIT_UNKNOWN;
    } else files.push(arg);
  }
  if (!files.length) {
    console.error(usage());
    return EXIT_UNKNOWN;
  }

  const results = files.map((file) => {
    const r = inspectApkDebugState(file);
    const verdict = r.debuggable === true ? 'debuggable' : r.debuggable === false ? 'clean' : 'unknown';
    return { file, verdict, ...r };
  });

  if (json) {
    console.log(JSON.stringify(results.map((r) => ({
      file: r.file,
      verdict: r.verdict,
      debuggable: r.debuggable,
      reason: r.reason,
      packageName: r.info.packageName ?? null,
      versionName: r.info.versionName ?? null,
      versionCode: r.info.versionCode ?? null,
    })), null, 2));
  } else if (!quiet) {
    for (const r of results) {
      const tag = r.verdict === 'clean' ? '[OK]  ' : r.verdict === 'debuggable' ? '[FAIL]' : '[??]  ';
      const ident = [
        r.info.packageName ? `package=${r.info.packageName}` : null,
        r.info.versionName ? `versionName=${r.info.versionName}` : null,
        r.info.versionCode !== undefined ? `versionCode=${r.info.versionCode}` : null,
      ].filter(Boolean).join(' ');
      const state = r.debuggable === true ? 'true' : r.debuggable === false ? 'false' : 'unknown';
      console.log(`${tag} ${path.basename(r.file)}  ${ident} debuggable=${state} (${r.reason})`);
    }
  }

  const bad = results.filter((r) => r.verdict !== 'clean');
  if (!bad.length) {
    if (!quiet) console.log(`\n通过：${results.length} 个 APK 均无 android:debuggable 标记，可以发布。`);
    return EXIT_OK;
  }

  const dbg = bad.filter((r) => r.verdict === 'debuggable');
  const unknown = bad.filter((r) => r.verdict === 'unknown');
  if (!json) {
    console.error('');
    if (dbg.length) {
      console.error(`禁止发布：${dbg.length} 个 APK 是 debuggable 构建（android:debuggable="true"）。`);
      console.error('  这些包可被任何已授权 adb 的机器 run-as 读私有数据 / 挂 JDWP 调试（Issue #60）。');
      console.error('  正确处理：用 ./gradlew :app:assembleRelease -PartifactVariant=internal 重新出包，不要上传这个文件。');
    }
    if (unknown.length) {
      console.error(`判不出来：${unknown.length} 个文件无法确认 debuggable 状态（按禁止发布处理）。`);
    }
  }
  return dbg.length ? EXIT_DEBUGGABLE : EXIT_UNKNOWN;
}

process.exitCode = main(process.argv.slice(2));

/**
 * apk-manifest.mjs / scripts/check-apk-debuggable.mjs 的离线单测。
 *
 * 为什么要自己造 AXML：真 APK 不方便入库（体积 + 许可证），而这里要验的正是
 * 「解 zip → 解二进制 XML → 读 application/android:debuggable」这条链路。
 * 测试里用最小 AXML 编码器 + 最小 ZIP 编码器造出可控样例，
 * 真 APK 的红绿证据另见 Issue #60 评论（现网 beta.8 / beta.9）。
 *
 * 运行：node --test deploy/dl-release/test/apk-manifest.test.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { ATTR_DEBUGGABLE_RES_ID, inspectApkDebugState } from '../apk-manifest.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '../../..');
const CLI = path.join(REPO, 'scripts', 'check-apk-debuggable.mjs');

// ------------------------------------------------------------ 最小 AXML 编码

function chunk(type, headerSize, body) {
  const head = Buffer.alloc(headerSize);
  head.writeUInt16LE(type, 0);
  head.writeUInt16LE(headerSize, 2);
  head.writeUInt32LE(headerSize + body.length, 4);
  return Buffer.concat([head, body]);
}

function stringPool(strings) {
  const offsets = [];
  const bytes = [];
  for (const s of strings) {
    offsets.push(bytes.length);
    const utf8 = Buffer.from(s, 'utf8');
    const pushLen = (n) => {
      if (n > 0x7f) bytes.push(0x80 | ((n >> 8) & 0xff), n & 0xff);
      else bytes.push(n);
    };
    pushLen(s.length);
    pushLen(utf8.length);
    bytes.push(...utf8, 0);
  }
  const headerSize = 28;
  const stringsStart = headerSize + offsets.length * 4;
  const head = Buffer.alloc(headerSize);
  head.writeUInt16LE(0x0001, 0);
  head.writeUInt16LE(headerSize, 2);
  head.writeUInt32LE(stringsStart + bytes.length, 4);
  head.writeUInt32LE(offsets.length, 8);
  head.writeUInt32LE(0, 12); // styleCount
  head.writeUInt32LE(0x100, 16); // UTF8_FLAG
  head.writeUInt32LE(stringsStart, 20);
  head.writeUInt32LE(0, 24);
  const offBuf = Buffer.alloc(offsets.length * 4);
  offsets.forEach((o, i) => offBuf.writeUInt32LE(o, i * 4));
  return Buffer.concat([head, offBuf, Buffer.from(bytes)]);
}

/**
 * 造一份 AndroidManifest.xml 二进制：
 *   attributes: android:versionCode(int) / android:versionName(string) / android:debuggable
 *   debuggable: true | false | undefined（不写这个属性 = release 包的常见形态）
 */
function buildManifestAxml({ versionCode = 1, versionName = '0.0.0', debuggable } = {}) {
  const strings = [
    'android', // 0 prefix
    'http://schemas.android.com/apk/res/android', // 1 ns uri
    'manifest', // 2
    'package', // 3
    'versionCode', // 4
    'versionName', // 5
    'application', // 6
    'debuggable', // 7
    'com.example.deepseekchat', // 8
    versionName, // 9
  ];
  const RES = { 4: 0x0101021b, 5: 0x0101021c, 7: ATTR_DEBUGGABLE_RES_ID };
  const resMap = Buffer.alloc(strings.length * 4);
  for (const [idx, id] of Object.entries(RES)) resMap.writeUInt32LE(id, Number(idx) * 4);

  const NS = 1;
  const attr = (nameIdx, { rawValue = 0xffffffff, dataType = 0x00, data = 0 }) => {
    const b = Buffer.alloc(20);
    b.writeInt32LE(NS, 0);
    b.writeUInt32LE(nameIdx, 4);
    b.writeUInt32LE(rawValue >>> 0, 8);
    b.writeUInt16LE(8, 12);
    b.writeUInt8(0, 14);
    b.writeUInt8(dataType, 15);
    b.writeUInt32LE(data >>> 0, 16);
    return b;
  };

  const manifestAttrs = [];
  {
    // package（无命名空间，字符串）
    const b = Buffer.alloc(20);
    b.writeInt32LE(-1, 0);
    b.writeUInt32LE(3, 4);
    b.writeInt32LE(8, 8);
    b.writeUInt16LE(8, 12);
    b.writeUInt8(0, 14);
    b.writeUInt8(0x03, 15);
    b.writeUInt32LE(8, 16);
    manifestAttrs.push(b);
  }
  manifestAttrs.push(attr(4, { dataType: 0x10, data: versionCode }));
  manifestAttrs.push(attr(5, { rawValue: 9, dataType: 0x03, data: 9 }));

  const appAttrs = [];
  if (debuggable !== undefined) {
    appAttrs.push(attr(7, { dataType: 0x12, data: debuggable ? 0xffffffff : 0 }));
  }

  const element = (nameIdx, attrs) => {
    const body = Buffer.alloc(20 + attrs.length * 20);
    body.writeUInt32LE(0xffffffff, 0); // ns = none
    body.writeUInt32LE(nameIdx, 4);
    body.writeUInt16LE(20, 8); // attributeStart
    body.writeUInt16LE(20, 10); // attributeSize
    body.writeUInt16LE(attrs.length, 12);
    body.writeUInt16LE(0, 14);
    body.writeUInt16LE(0, 16);
    body.writeUInt16LE(0, 18);
    attrs.forEach((a, i) => a.copy(body, 20 + i * 20));
    return chunk(0x0102, 16, body);
  };

  const startNs = (() => {
    const body = Buffer.alloc(8);
    body.writeInt32LE(0, 0); // prefix = android
    body.writeInt32LE(NS, 4);
    const b = Buffer.alloc(16);
    b.writeUInt16LE(0x0100, 0);
    b.writeUInt16LE(16, 2);
    b.writeUInt32LE(24, 4);
    return Buffer.concat([b, body]);
  })();

  const parts = [
    stringPool(strings),
    chunk(0x0180, 8, resMap),
    startNs,
    element(2, manifestAttrs),
    element(6, appAttrs),
  ];
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt16LE(0x0003, 0);
  head.writeUInt16LE(8, 2);
  head.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

// ------------------------------------------------------------- 最小 ZIP 编码

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function apkWith(manifestOpts) {
  return buildZip([
    { name: 'AndroidManifest.xml', data: buildManifestAxml(manifestOpts) },
    { name: 'classes.dex', data: Buffer.from('dex\n035\0', 'binary') },
  ]);
}

// ------------------------------------------------------------------ 用例

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-dbg-test-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const write = (name, buf) => {
  const p = path.join(tmp, name);
  fs.writeFileSync(p, buf);
  return p;
};

test('application 里有 android:debuggable="true" → debuggable=true', () => {
  const r = inspectApkDebugState(Buffer.from(apkWith({ debuggable: true, versionCode: 15, versionName: '1.4.0-beta.8' })));
  assert.equal(r.debuggable, true);
  assert.equal(r.reason, 'debuggable_true');
  assert.equal(r.info.versionCode, 15);
  assert.equal(r.info.versionName, '1.4.0-beta.8');
});

test('显式 android:debuggable="false" → debuggable=false', () => {
  const r = inspectApkDebugState(Buffer.from(apkWith({ debuggable: false })));
  assert.equal(r.debuggable, false);
  assert.equal(r.reason, 'debuggable_false');
});

test('属性缺失（release 变体常见形态）→ debuggable=false', () => {
  const r = inspectApkDebugState(Buffer.from(apkWith({ debuggable: undefined })));
  assert.equal(r.debuggable, false);
  assert.equal(r.reason, 'attr_absent');
});

test('不是 ZIP → 判不出来（null），不默认放行', () => {
  const r = inspectApkDebugState(Buffer.from('not-an-apk'));
  assert.equal(r.debuggable, null);
  assert.match(r.reason, /^zip_failed/);
});

test('zip 里没有 AndroidManifest.xml → 判不出来', () => {
  const r = inspectApkDebugState(buildZip([{ name: 'a.txt', data: Buffer.from('x') }]));
  assert.equal(r.debuggable, null);
  assert.equal(r.reason, 'manifest_absent');
});

test('AndroidManifest.xml 不是 AXML → 判不出来', () => {
  const r = inspectApkDebugState(buildZip([
    { name: 'AndroidManifest.xml', data: Buffer.from('<manifest/>') },
  ]));
  assert.equal(r.debuggable, null);
  assert.match(r.reason, /axml_parse_failed/);
});

test('CLI: debuggable 包 → exit 1，release 包 → exit 0', () => {
  const bad = write('bad.apk', apkWith({ debuggable: true }));
  const good = write('good.apk', apkWith({ debuggable: undefined }));

  const r1 = spawnSync(process.execPath, [CLI, bad], { encoding: 'utf8' });
  assert.equal(r1.status, 1, r1.stdout + r1.stderr);
  assert.match(r1.stdout, /\[FAIL\] bad\.apk .*debuggable=true/);

  const r2 = spawnSync(process.execPath, [CLI, good], { encoding: 'utf8' });
  assert.equal(r2.status, 0, r2.stdout + r2.stderr);
  assert.match(r2.stdout, /\[OK\] {3}good\.apk .*debuggable=false/);
});

test('CLI: 混在一起只要有 debuggable 就整体失败，判不出来的算失败', () => {
  const bad = write('mix-bad.apk', apkWith({ debuggable: true }));
  const good = write('mix-good.apk', apkWith({ debuggable: undefined }));
  const junk = write('mix-junk.apk', Buffer.from('nope'));

  const r = spawnSync(process.execPath, [CLI, good, bad], { encoding: 'utf8' });
  assert.equal(r.status, 1);

  const r2 = spawnSync(process.execPath, [CLI, good, junk], { encoding: 'utf8' });
  assert.equal(r2.status, 2);
  assert.match(r2.stdout + r2.stderr, /判不出来/);
});

test('CLI: 无参数 → exit 2（用法错误也不放行）', () => {
  const r = spawnSync(process.execPath, [CLI], { encoding: 'utf8' });
  assert.equal(r.status, 2);
});

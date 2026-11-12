import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSystemProcess,
  parseAmAnrLine,
  parseAmCrashLine,
  parseHosFaultlog,
  parseNativeSignalLine,
  parseTombstoneProcessLine,
} from './crashwatch.ts';

test('am_crash 解析：应用崩溃归到包名，系统进程归 SYSTEM', () => {
  // android-36 字段序：User, PID, Process Name, Flags, Exception, Message, File, Line, Recoverable
  const app = parseAmCrashLine(
    '11-09 08:52:13.123  1234  1250 I am_crash: [0,1234,com.example.demo,0,java.lang.NullPointerException,Attempt to invoke virtual method, on a null object reference,/data/app/demo/Main.java,42,0]',
  );
  assert.ok(app);
  assert.equal(app.process, 'com.example.demo');
  assert.equal(app.source, 'com.example.demo');
  assert.equal(app.kind, 'java');
  // 消息含逗号也不会被截断
  assert.equal(
    app.summary,
    'java.lang.NullPointerException: Attempt to invoke virtual method, on a null object reference (/data/app/demo/Main.java:42)',
  );

  // 旧版本没有 Recoverable 列
  const old = parseAmCrashLine(
    '11-09 08:52:13.123  1234  1250 I am_crash: [0,1234,com.example.demo,0,com.example.Error,boom,/data/app/A.java,7]',
  );
  assert.equal(old?.summary, 'com.example.Error: boom (/data/app/A.java:7)');

  const sys = parseAmCrashLine(
    '11-09 09:00:00.000   500   520 I am_crash: [0,500,system_server,0,java.lang.RuntimeException,Fatal,/system/framework/A.java,7]',
  );
  assert.ok(sys);
  assert.equal(sys.source, 'SYSTEM');
});

test('native 崩溃：异常含 SIGSEGV 归为 native，子进程名归到主包', () => {
  const crash = parseAmCrashLine(
    '11-09 09:10:00.000  2000  2010 I am_crash: [0,2000,com.example.demo:remote,0,com.example.demo,Native crash SIGSEGV,/data/app/lib.so,-1]',
  );
  assert.ok(crash);
  assert.equal(crash.kind, 'native');
  assert.equal(crash.source, 'com.example.demo');
  // file/line 缺失时不拼出 (null:-1)
  assert.equal(crash.summary, 'com.example.demo: Native crash SIGSEGV');
});

test('am_anr 解析：无响应归为 anr，完整理由进摘要', () => {
  // android-36 字段序：User, pid, Package Name, Flags, reason
  const anr = parseAmAnrLine(
    '11-09 09:20:00.000  1234  1250 I am_anr: [0,1234,com.example.demo,0,Input dispatching timed out (Waiting because no window has focus)]',
  );
  assert.ok(anr);
  assert.equal(anr.source, 'com.example.demo');
  assert.equal(anr.kind, 'anr');
  assert.equal(
    anr.summary,
    '应用无响应：Input dispatching timed out (Waiting because no window has focus)',
  );
  // 非 am_crash/am_anr 行不产生事件
  assert.equal(parseAmCrashLine('I/ActivityManager: start proc'), undefined);
  assert.equal(parseAmAnrLine('I/ActivityManager: start proc'), undefined);
});

test('tombstone 信号行转成可读摘要', () => {
  // 真实 logcat crash 缓冲行：name 是线程名，>>> 后是进程名
  assert.equal(
    parseTombstoneProcessLine(
      '11-09 09:51:25.997  5901  5901 F DEBUG   : pid: 5878, tid: 5893, name: chaoxing.mobile  >>> com.chaoxing.mobile <<<',
    ),
    'com.chaoxing.mobile',
  );
  assert.equal(
    parseTombstoneProcessLine(
      'pid: 100, tid: 101, name: RenderThread  >>> com.example.demo:remote <<<',
    ),
    'com.example.demo:remote',
  );
  assert.equal(
    parseNativeSignalLine(
      'signal 11 (SIGSEGV), code 1 (SEGV_MAPERR), fault addr 0x0000000000000010',
    ),
    '信号 11 (SIGSEGV)，code 1 (SEGV_MAPERR)，fault addr 0x0000000000000010',
  );
  assert.equal(parseNativeSignalLine('signal handler installed'), undefined);
});

test('isSystemProcess：反向域名包名才算应用进程', () => {
  assert.equal(isSystemProcess('com.example.demo'), false);
  assert.equal(isSystemProcess('com.example.demo:push'), false);
  assert.equal(isSystemProcess('system_server'), true);
  assert.equal(isSystemProcess('surfaceflinger'), true);
  // 单点域名（com.example）也按应用处理；无点或非域名开头才算系统
  assert.equal(isSystemProcess('com.example'), false);
  assert.equal(isSystemProcess(''), true);
});

test('HOS faultlogger：类型来自文件名，时间取日志自带 Timestamp', () => {
  const text = [
    'Timestamp:2026-11-09 08:52:13.123',
    'Pid:1234',
    'Process name:com.example.demo',
    'Module name:entry',
    'Reason:TypeError: Cannot read property of undefined',
  ].join('\n');
  const parsed = parseHosFaultlog(text, 'jscrash-com.example.demo-1234-20261109090000000.log');
  // 文件名时间（09:00）与日志时间不一致时取日志时间：HOS 时钟会跳
  assert.equal(parsed.at.getHours(), 8);
  assert.equal(parsed.at.getMinutes(), 52);
  assert.equal(parsed.source, 'com.example.demo');
  assert.equal(parsed.kind, 'java');
  assert.equal(parsed.summary, 'TypeError: Cannot read property of undefined');

  const native = parseHosFaultlog(text, 'cppcrash-render_service-1-20261109085213123.log');
  assert.equal(native.kind, 'native');

  const freeze = parseHosFaultlog('Process name:com.example.demo\n', 'appfreeze-com.example.demo-1-20261109085213123.log');
  assert.equal(freeze.kind, 'anr');
  assert.equal(freeze.summary, '应用无响应');
  // 文件名为 17 位时间戳时作为兜底
  assert.equal(freeze.at.getFullYear(), 2026);
  assert.equal(freeze.at.getMonth(), 10);
  assert.equal(freeze.at.getDate(), 9);

  // 无进程名的系统级崩溃归 SYSTEM
  const sys = parseHosFaultlog('Reason:crash\n', 'cppcrash-foundation-9-20261109085213123.log');
  assert.equal(sys.source, 'SYSTEM');
});

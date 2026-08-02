// スマホでの見え方の検証。実物のCSSと部品を本物のブラウザに載せ、
// ソフトキーボードを出した状態のレイアウトを測って確かめる。
//
// jsdomはレイアウトを持たない(幅も高さも0)ので、この種の不具合はユニット
// テストでは捕まらない。ヘッドレスChromeをCDPで直接動かす(依存を増やさない)。
// Chromeが無い環境ではスキップする。
//
//   node test/layout.mjs        # または npm run test:layout
//   CHROME_PATH=... で実行ファイルを指定できる

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild"; // viteに同梱されている

const here = dirname(fileURLToPath(import.meta.url));

// ---- Chromeを探す ----------------------------------------------------------
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const local = process.env.LOCALAPPDATA;
  const pw = local && join(local, "ms-playwright");
  if (pw && existsSync(pw)) {
    for (const d of readdirSync(pw).filter((n) => n.startsWith("chromium-"))) {
      for (const sub of ["chrome-win64", "chrome-win", "chrome-linux"]) {
        for (const exe of ["chrome.exe", "chrome"]) {
          const p = join(pw, d, sub, exe);
          if (existsSync(p)) return p;
        }
      }
    }
  }
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ];
  return candidates.find((p) => existsSync(p));
}

// ---- CDPの最小クライアント -------------------------------------------------
async function openBrowser(exe) {
  const port = 9222 + Math.floor(Math.random() * 500);
  const proc = spawn(exe, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--hide-scrollbars",
    "--autoplay-policy=no-user-gesture-required",
    `--user-data-dir=${mkdtempSync(join(tmpdir(), "remote-layout-"))}`,
    "about:blank",
  ]);
  proc.stderr.on("data", () => {});
  let wsUrl;
  for (let i = 0; i < 80 && !wsUrl; i++) {
    try {
      wsUrl = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json())
        .webSocketDebuggerUrl;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  if (!wsUrl) throw new Error("ヘッドレスChromeが起動しませんでした");

  const sock = new WebSocket(wsUrl);
  await new Promise((r) => (sock.onopen = r));
  let id = 0;
  const waiting = new Map();
  sock.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && waiting.has(m.id)) {
      waiting.get(m.id)(m);
      waiting.delete(m.id);
    }
  };
  const rpc = (method, params = {}, sessionId) =>
    new Promise((res, rej) => {
      const n = ++id;
      waiting.set(n, (m) => (m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result)));
      sock.send(JSON.stringify({ id: n, method, params, sessionId }));
    });

  const { targetId } = await rpc("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await rpc("Target.attachToTarget", { targetId, flatten: true });
  const call = (m, p) => rpc(m, p, sessionId);
  await call("Page.enable");
  await call("Runtime.enable");
  return {
    call,
    async evaluate(expression) {
      const r = await call("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "評価に失敗");
      return r.result.value;
    },
    close() {
      sock.close();
      proc.kill();
    },
  };
}

// ---- 検証 ------------------------------------------------------------------
const failures = [];
let checks = 0;
function ok(cond, what, detail) {
  checks++;
  if (!cond) failures.push(`${what}${detail ? ` — ${detail}` : ""}`);
}
function near(a, b, tol, what) {
  ok(Math.abs(a - b) <= tol, what, `${a.toFixed(1)} と ${b.toFixed(1)} が ${tol}px 以上ちがう`);
}

const OS_KEYBOARD = { 縦持ち: 300, 横持ち: 190 }; // ソフトキーボードの高さの目安

async function run(page, name, width, height) {
  await page.call("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 2,
    mobile: true,
  });
  await page.call("Page.navigate", { url: `file:///${join(here, "page.html").replace(/\\/g, "/")}` });
  for (let i = 0; i < 40; i++) {
    if (await page.evaluate("!!window.test && window.test.ready()")) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  ok(await page.evaluate("!!window.test && window.test.ready()"), `${name}: 映像が始まらない`);

  // 1. キーボードを出す前
  const closed = await page.evaluate("JSON.stringify(window.test.measure())").then(JSON.parse);
  near(closed.viewer.h, height, 1, `${name}: ビューアが画面の高さと合っていない`);
  near(closed.stage.h, height, 1, `${name}: 映像の領域が画面の高さと合っていない`);
  ok(
    closed.transform === "none",
    `${name}: 等倍なのにtransformが付いている`,
    // 端末によっては映像が合成レイヤーへ移って何も描かれなくなる
    closed.transform
  );
  ok(closed.micShown, `${name}: マイクボタンが出ていない`);
  ok(closed.content.h > 0 && closed.content.w > 0, `${name}: 映像が表示されていない`);

  // 2. 特殊キーバーを開き、ソフトキーボードが下から出た状態にする
  await page.evaluate("window.test.toggleKeyboard()");
  await new Promise((r) => setTimeout(r, 100)); // ResizeObserverの通知を待つ
  const visible = height - OS_KEYBOARD[name];
  await page.evaluate(`window.test.setVisibleHeight(${visible})`);
  await new Promise((r) => setTimeout(r, 100));
  const open = await page.evaluate("JSON.stringify(window.test.measure())").then(JSON.parse);

  ok(open.panel, `${name}: 特殊キーバーが出ていない`);
  near(open.viewer.h, visible, 1, `${name}: ビューアがキーボードの下に潜っている`);
  near(open.panel.bottom, visible, 1, `${name}: バーがキーボードに隠れている`);
  ok(
    open.stage.h > 40,
    `${name}: 映像の領域が潰れている`,
    `stage=${open.stage.h.toFixed(0)}px`
  );
  ok(!open.micShown, `${name}: 狭い映像の上にマイクボタンが残っている`);

  // 映像が見えている範囲に残っているか (真っ黒にならないこと)
  const shownTop = Math.max(open.content.y, 0);
  const shownBottom = Math.min(open.content.y + open.content.h, open.stage.h);
  ok(
    shownBottom - shownTop > 40,
    `${name}: キーボードを出すと映像が見えなくなる`,
    `見えている高さ ${(shownBottom - shownTop).toFixed(0)}px`
  );

  // 見た目の大きさは変えない (収め直して字が読めなくならないこと)
  near(open.content.w, closed.content.w, 1, `${name}: キーボードで映像の大きさが変わった`);
  if (open.content.h <= open.stage.h + 1) {
    // まだ収まる場合 (縦持ち)。余白が減って上に寄るだけで、全部見えている。
    ok(
      open.content.y >= -1 && open.content.y + open.content.h <= open.stage.h + 1,
      `${name}: 収まる大きさなのに映像がはみ出している`
    );
  } else {
    // 収まらない場合 (横持ち)。下からせり上がって隠しただけの見え方にする。
    near(open.content.y, closed.content.y, 1, `${name}: キーボードで映像が飛んだ`);
    ok(open.transform !== "none", `${name}: はみ出しているのに動かす余地が無い`);
  }

  // 3. 閉じたら元通り
  await page.evaluate("window.test.toggleKeyboard()");
  await new Promise((r) => setTimeout(r, 100));
  await page.evaluate(`window.test.setVisibleHeight(${height})`);
  await new Promise((r) => setTimeout(r, 100));
  const back = await page.evaluate("JSON.stringify(window.test.measure())").then(JSON.parse);
  ok(back.transform === "none", `${name}: 閉じても拡大が残る`, back.transform);
  near(back.content.h, closed.content.h, 1, `${name}: 閉じても元の大きさに戻らない`);
  ok(back.micShown, `${name}: 閉じてもマイクボタンが戻らない`);

  return { closed, open };
}

// ---- 実行 ------------------------------------------------------------------
const exe = findChrome();
if (!exe) {
  console.log("Chromeが見つからないのでレイアウト検証はスキップします (CHROME_PATH で指定可)");
  process.exit(0);
}

// 実物のソースをそのまま束ねる
await build({
  entryPoints: [join(here, "page.ts")],
  bundle: true,
  format: "iife",
  outfile: join(here, "page.js"),
  logLevel: "silent",
});
writeFileSync(
  join(here, "page.html"),
  `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="../src/styles.css">
<div id="app"></div><script src="./page.js"></script>`
);

const page = await openBrowser(exe);
try {
  const portrait = await run(page, "縦持ち", 390, 844);
  const landscape = await run(page, "横持ち", 844, 390);

  // 横持ちでは特殊キーが1段に収まること (2段だと映像に残る高さが半分になる)
  ok(
    landscape.open.barHeight < landscape.open.keyHeight * 1.5,
    "横持ち: 特殊キーが1段に収まっていない",
    `バー ${landscape.open.barHeight}px / キー ${landscape.open.keyHeight}px`
  );
  console.log(
    `縦持ち: パネル ${(portrait.open.viewer.h - portrait.open.stage.h).toFixed(0)}px / ` +
      `映像に残る高さ ${portrait.open.stage.h.toFixed(0)}px`
  );
  console.log(
    `横持ち: パネル ${(landscape.open.viewer.h - landscape.open.stage.h).toFixed(0)}px / ` +
      `映像に残る高さ ${landscape.open.stage.h.toFixed(0)}px`
  );
} finally {
  page.close();
}

if (failures.length) {
  console.error(`\n✘ レイアウト検証 ${failures.length}件の失敗 (${checks}項目)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\n✓ レイアウト検証 ${checks}項目すべて通過`);

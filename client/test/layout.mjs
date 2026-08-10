// スマホでの見え方の検証。実物のCSSと部品を本物のブラウザに載せ、
// 画面内キーボードを出した状態のレイアウトを測って確かめる。
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
  near(closed.box.h, height, 1, `${name}: 映像の領域が画面の高さと合っていない`);
  ok(
    closed.transform === "none",
    `${name}: 等倍なのにtransformが付いている`,
    // 端末によっては映像が合成レイヤーへ移って何も描かれなくなる
    closed.transform
  );
  ok(closed.micShown, `${name}: マイクボタンが出ていない`);
  ok(closed.content.h > 0 && closed.content.w > 0, `${name}: 映像が表示されていない`);

  // 自動再生が止められたときの再生ボタン。ふだんは出ていないこと。
  ok(!closed.gateShown, `${name}: 再生ボタンが最初から出ている`);
  await page.evaluate("window.test.showPlayGate(true)");
  // 映像の中央では操作面より手前で受ける (止まった映像へタップを送らせない)
  ok(
    (await page.evaluate(`window.test.topIdAt(${width / 2}, ${height / 2})`)) === "playgate",
    `${name}: 再生ボタンが操作面の裏に隠れている`
  );
  // 出ているあいだも切断ボタンは押せること (HUDはこれより手前)
  const exitId = await page.evaluate(`(() => {
    const r = document.getElementById("exit").getBoundingClientRect();
    return window.test.topIdAt(r.x + r.width / 2, r.y + r.height / 2);
  })()`);
  ok(exitId === "exit", `${name}: 再生ボタンが切断ボタンを覆っている`, exitId);
  await page.evaluate("window.test.showPlayGate(false)");

  // 2. 画面内キーボードを開いた状態にする
  await page.evaluate("window.test.toggleKeyboard()");
  await new Promise((r) => setTimeout(r, 100)); // ResizeObserverの通知を待つ
  // OSキーボードは自動表示しない。画面内パネルだけが下端を使う。
  const visible = height;
  await page.evaluate(`window.test.setVisibleHeight(${visible})`);
  await new Promise((r) => setTimeout(r, 100));
  const open = await page.evaluate("JSON.stringify(window.test.measure())").then(JSON.parse);

  ok(open.panel, `${name}: キーボードが出ていない`);
  near(open.viewer.h, visible - open.panel.h, 1, `${name}: ビューアがキーボードの下に潜っている`);
  near(open.panel.bottom, visible, 1, `${name}: キーボードが画面の下にはみ出している`);
  ok(open.box.h > 40, `${name}: 映像の領域が潰れている`, `${open.box.h.toFixed(0)}px`);
  near(open.box.h, visible - open.panel.h, 1, `${name}: 映像の領域がキーボードのぶん詰められていない`);
  ok(!open.micShown, `${name}: 狭い映像の上にマイクボタンが残っている`);
  // 映像の上の🎤が引っ込むぶん、キーボード側の🎤で喋れること
  ok(open.kbdMic, `${name}: キーボードに🎤キーが無い`);
  ok(
    open.kbdMic && open.kbdMic.w >= 34 && open.kbdMic.h >= 30,
    `${name}: 🎤キーが押しっぱなしにしづらい大きさ`,
    open.kbdMic && `${open.kbdMic.w.toFixed(0)}x${open.kbdMic.h.toFixed(0)}px`
  );

  // キーが指で押せる大きさか (細すぎると隣を押す)
  ok(
    open.minKey && open.minKey.w >= 30,
    `${name}: 細すぎるキーがある`,
    open.minKey && `${open.minKey.label} が ${open.minKey.w.toFixed(0)}px`
  );
  // 段の中に空きマスが無いこと (以前は方向キーの手前に穴が空いていた)
  ok(
    open.rowGaps.every((g) => Math.abs(g) <= 2),
    `${name}: 段に空きマスが残っている`,
    `余り ${open.rowGaps.join(",")}px`
  );

  // 数字・記号面へ切り替えても、高さと操作段の位置が動かないこと
  await page.evaluate("window.test.toggleLayer()");
  await new Promise((r) => setTimeout(r, 50));
  const num = await page.evaluate("JSON.stringify(window.test.measure())").then(JSON.parse);
  ok(
    (await page.evaluate("window.test.layerKeyLabel()")) === "ABC",
    `${name}: 123を押しても面が変わらない`
  );
  near(num.panel.h, open.panel.h, 1, `${name}: 面を切り替えると高さが変わる`);
  ok(
    num.minKey && num.minKey.w >= 24,
    `${name}: 数字・記号面に細すぎるキーがある`,
    num.minKey && `${num.minKey.label} が ${num.minKey.w.toFixed(0)}px`
  );
  ok(
    num.rowGaps.every((g) => Math.abs(g) <= 2),
    `${name}: 数字・記号面の段に空きマスが残っている`,
    `余り ${num.rowGaps.join(",")}px`
  );
  await page.evaluate("window.test.toggleLayer()"); // 文字面へ戻す
  await new Promise((r) => setTimeout(r, 50));

  // 修飾キーは押した時点で降り、次の1打のあとに離れる (Ctrl+C が1打ずつで打てる)
  await page.evaluate("window.test.takeSent()");
  await page.evaluate("window.test.pressKey('Ctrl')");
  await page.evaluate("window.test.pressKey('c')");
  const combo = await page.evaluate("JSON.stringify(window.test.takeSent())").then(JSON.parse);
  ok(
    JSON.stringify(combo) ===
      JSON.stringify([
        { t: "key", code: "ControlLeft", down: true },
        { t: "key", code: "KeyC", down: true },
        { t: "key", code: "KeyC", down: false },
        { t: "key", code: "ControlLeft", down: false },
      ]),
    `${name}: Ctrl+C の打鍵が組み合わせになっていない`,
    JSON.stringify(combo)
  );

  // Shiftを押したら手元のラベルも大文字になる (送る前に効いているか分かる)
  const lower = await page.evaluate("window.test.letterLabels()");
  await page.evaluate("window.test.pressKey('⇧')");
  const upper = await page.evaluate("window.test.letterLabels()");
  ok(upper === lower.toUpperCase() && upper !== lower, `${name}: Shiftでラベルが大文字にならない`);
  await page.evaluate("window.test.pressKey('A')"); // 大文字になっているので'A'
  ok(
    (await page.evaluate("window.test.letterLabels()")) === lower,
    `${name}: 1打したのにShiftのラベルが戻らない`
  );
  await page.evaluate("window.test.takeSent()");

  // 🎤は押下の扱いをVoiceInputに任せる。ここで打鍵も送ると二重に反応する。
  await page.evaluate("window.test.pressKey('🎤')");
  const micSent = await page.evaluate("JSON.stringify(window.test.takeSent())").then(JSON.parse);
  ok(micSent.length === 0, `${name}: 🎤キーが打鍵も送っている`, JSON.stringify(micSent));

  // 連射中に別の指で違うキーを叩いても、押しっぱなしの側は連射を続けること
  // (タイマーを1組で使い回していると、ここで止まっていた)
  await page.evaluate("window.test.keyDown('↓')");
  await page.evaluate("window.test.pressKey('⌫')"); // 2本目の指でタップ
  await new Promise((r) => setTimeout(r, 600)); // 連射開始(400ms)+数回ぶん
  await page.evaluate("window.test.keyUp('↓')");
  const held = await page.evaluate("JSON.stringify(window.test.takeSent())").then(JSON.parse);
  const downs = held.filter((m) => m.code === "ArrowDown" && m.down).length;
  ok(downs > 1, `${name}: 別のキーを叩くと押しっぱなしの連射が止まる`, `↓ が ${downs} 回だけ`);
  // 離したら止まること (離した後に増えていないか見る)
  await new Promise((r) => setTimeout(r, 200));
  const after = await page.evaluate("JSON.stringify(window.test.takeSent())").then(JSON.parse);
  ok(after.length === 0, `${name}: 離しても連射が止まらない`, JSON.stringify(after).slice(0, 80));

  // 映像が見えている範囲に残っているか (真っ黒にならないこと)
  const shownTop = Math.max(open.content.y, 0);
  const shownBottom = Math.min(open.content.y + open.content.h, open.box.h);
  ok(
    shownBottom - shownTop > 40,
    `${name}: キーボードを出すと映像が見えなくなる`,
    `見えている高さ ${(shownBottom - shownTop).toFixed(0)}px`
  );

  // 残った領域を余白なく使っていること。収め直すと、16:9のデスクトップは
  // スマホの隙間の中で上下(または左右)が真っ黒になり、字も読めなくなる。
  ok(
    open.content.w >= open.box.w * 0.95 && open.content.h >= open.box.h * 0.95,
    `${name}: キーボードを出すと余白ばかりになる`,
    `映像 ${open.content.w.toFixed(0)}x${open.content.h.toFixed(0)} / ` +
      `領域 ${open.box.w.toFixed(0)}x${open.box.h.toFixed(0)}`
  );
  // はみ出したぶんは指で動かせること (動かせないと見たいところを出せない)
  ok(open.transform !== "none", `${name}: 埋めたのに動かす余地が無い`);
  ok(
    open.content.w > open.box.w + 1 || open.content.h > open.box.h + 1,
    `${name}: はみ出しが無い`
  );

  // 3. 閉じたら元通り
  await page.evaluate("window.test.toggleKeyboard()");
  await new Promise((r) => setTimeout(r, 100));
  await page.evaluate(`window.test.setVisibleHeight(${height})`);
  await new Promise((r) => setTimeout(r, 100));
  const back = await page.evaluate("JSON.stringify(window.test.measure())").then(JSON.parse);
  ok(back.transform === "none", `${name}: 閉じても拡大が残る`, back.transform);
  near(back.content.h, closed.content.h, 1, `${name}: 閉じても全体表示に戻らない`);
  near(back.content.w, closed.content.w, 1, `${name}: 閉じても全体表示に戻らない`);
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

  // 縦持ちは 文字3段 + 操作2段 の5段
  ok(portrait.open.rowTops === 5, "縦持ち: 段数が5段ではない", `${portrait.open.rowTops}段`);

  // 横持ちでは操作段2つが横に並んで1段になること
  // (縦に積むと映像に残る高さがさらに1段ぶん減る)
  ok(
    landscape.open.opsHeight < landscape.open.keyHeight * 1.5,
    "横持ち: 操作段が1段に収まっていない",
    `操作段 ${landscape.open.opsHeight}px / キー ${landscape.open.keyHeight}px`
  );
  ok(landscape.open.rowTops === 4, "横持ち: 段数が4段ではない", `${landscape.open.rowTops}段`);
  console.log(
    `縦持ち: パネル ${portrait.open.panel.h.toFixed(0)}px / ` +
      `映像に残る高さ ${portrait.open.box.h.toFixed(0)}px`
  );
  console.log(
    `横持ち: パネル ${landscape.open.panel.h.toFixed(0)}px / ` +
      `映像に残る高さ ${landscape.open.box.h.toFixed(0)}px`
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

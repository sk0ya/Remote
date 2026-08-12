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

// 埋めた映像が表示領域を覆いきっているか。以前は動かせる範囲を表示領域の端で
// 決めていたので、16:9を縦長の画面に収めたときの余白のぶんだけ行き過ぎて、
// 埋めているはずなのに下に黒い帯が出ていた。
function covers(m) {
  return (
    m.content.x <= 1 &&
    m.content.y <= 1 &&
    m.content.x + m.content.w >= m.box.w - 1 &&
    m.content.y + m.content.h >= m.box.h - 1
  );
}

function coverage(m) {
  return (
    `映像 ${m.content.x.toFixed(0)},${m.content.y.toFixed(0)} ` +
    `${m.content.w.toFixed(0)}x${m.content.h.toFixed(0)} / ` +
    `領域 ${m.box.w.toFixed(0)}x${m.box.h.toFixed(0)}`
  );
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
  const focus = { x: 0.5, y: 0.8 };
  await page.evaluate(`window.test.tapScreen(${focus.x}, ${focus.y})`);
  await page.evaluate("window.test.openText()");
  const textOpen = await page.evaluate("JSON.stringify(window.test.measure())").then(JSON.parse);
  ok(textOpen.textEntry, `${name}: 標準キーボード用の入力欄が開かない`);
  await page.evaluate("window.test.sendText('日本語😀')");
  const textSent = await page.evaluate("JSON.stringify(window.test.takeSent())").then(JSON.parse);
  ok(
    JSON.stringify(textSent) === JSON.stringify([{ t: "txt", s: "日本語😀" }]),
    `${name}: 標準キーボードの文字列がPCへ送られない`,
    JSON.stringify(textSent)
  );
  const osOccluded = Math.round(height * 0.35);
  await page.evaluate(`window.test.setVisibleHeight(${height - osOccluded})`);
  await new Promise((r) => setTimeout(r, 100));
  const osOpen = await page.evaluate("JSON.stringify(window.test.measure())").then(JSON.parse);
  ok(osOpen.textEntry, `${name}: OSキーボード表示中に入力欄が消えている`);
  near(osOpen.viewer.h, osOpen.textEntry.y, 1, `${name}: OS入力欄が映像の上に重なっている`);
  near(osOpen.textEntry.bottom, height - osOccluded, 1, `${name}: OS入力欄がOSキーボード直上にない`);
  // キーボード・マウスパネルと同じトレイに収まっていること (端が揃う)
  near(osOpen.textEntry.x, 0, 1, `${name}: OS入力欄の左端が他のパネルと揃っていない`);
  near(osOpen.textEntry.w, width, 1, `${name}: OS入力欄の幅が他のパネルと揃っていない`);
  ok(!osOpen.micShown, `${name}: OSキーボード表示中にマイクが残っている`);
  const osFocused = await page.evaluate(
    `window.test.transformedScreenPoint(${focus.x}, ${focus.y})`
  );
  near(osFocused.x, osOpen.box.w / 2, 3, `${name}: OS表示時のフォーカス横位置がずれている`);
  ok(osFocused.y >= 0 && osFocused.y <= osOpen.box.h, `${name}: OS表示時のフォーカスが映像外にある`);
  await page.evaluate("window.test.closeText()");
  await page.evaluate(`window.test.setVisibleHeight(${height})`);
  await new Promise((r) => setTimeout(r, 100));

  // ピンチで拡大して動かしたあと、指の下にあるものの位置がそのままホストへ
  // 送られること。以前は動かしたぶんだけずれ、「拡大していなかったらそこに
  // 何があったか」の場所がクリックされていた (拡大するほど大きく外れる)。
  // 変換後の座標が絡むのでjsdomでは再現できず、ここで実物を触って測る。
  await page.evaluate("window.test.takeDcSent()"); // ここまでの操作を捨てる
  await page.evaluate(`window.test.pinch(${width / 2}, ${height / 2}, 100, 250)`);
  const zoomScale = await page.evaluate("window.test.videoScale()");
  ok(zoomScale > 1.5, `${name}: ピンチで拡大できない`, `${zoomScale.toFixed(2)}倍`);
  // 2本指の操作そのものはクリックにしないこと。2本指の処理は1本目を離した
  // 時点で終わるので、残った指を離したぶんが1本指タップとして拾われていた
  // (ピンチのたびに、指を離した場所が勝手にクリックされる)。
  const pinched = await page.evaluate("JSON.stringify(window.test.takeDcSent())").then(JSON.parse);
  ok(
    !pinched.some((m) => m.t === "dn" || m.t === "up"),
    `${name}: ピンチが勝手にクリックを送る`,
    JSON.stringify(pinched)
  );
  for (const p of [
    { x: 0.5, y: 0.5 },
    { x: 0.44, y: 0.56 },
    { x: 0.57, y: 0.47 },
  ]) {
    await page.evaluate(`window.test.tapScreen(${p.x}, ${p.y})`);
    const msgs = await page.evaluate("JSON.stringify(window.test.takeDcSent())").then(JSON.parse);
    const mv = msgs.find((m) => m.t === "mv");
    ok(mv, `${name}: 拡大中のタップがホストへ届かない`, JSON.stringify(msgs));
    if (mv) {
      // 1/1000単位で比べる (見えている位置と送った位置の差)
      near(mv.x * 1000, p.x * 1000, 5, `${name}: 拡大中のタップの横位置がずれる`);
      near(mv.y * 1000, p.y * 1000, 5, `${name}: 拡大中のタップの縦位置がずれる`);
    }
  }
  // つまみ縮めて全体表示へ戻す (これ以降は等倍が前提)
  await page.evaluate(`window.test.pinch(${width / 2}, ${height / 2}, 250, 60)`);
  const unpinched = await page
    .evaluate("JSON.stringify(window.test.takeDcSent())")
    .then(JSON.parse);
  ok(
    !unpinched.some((m) => m.t === "dn" || m.t === "up"),
    `${name}: 縮めるだけでクリックが飛ぶ`,
    JSON.stringify(unpinched)
  );
  const unzoomed = await page.evaluate("JSON.stringify(window.test.measure())").then(JSON.parse);
  ok(unzoomed.transform === "none", `${name}: 縮めても拡大が残る`, unzoomed.transform);

  // 2本指を動かさずに離せば右クリック。誤クリックを止めたせいでこちらまで
  // 消えていないこと (2本指タップは右クリックの唯一の出し方)。
  await page.evaluate(`window.test.pinch(${width / 2}, ${height / 2}, 100, 100)`);
  const twoTap = await page.evaluate("JSON.stringify(window.test.takeDcSent())").then(JSON.parse);
  ok(
    JSON.stringify(twoTap.filter((m) => m.t !== "mv")) ===
      JSON.stringify([
        { t: "dn", b: 2 },
        { t: "up", b: 2 },
      ]),
    `${name}: 2本指タップが右クリックにならない`,
    JSON.stringify(twoTap)
  );

  // 画面下側の入力欄をタップしてからキーボードを開く。中央固定ではなく、
  // このフォーカス位置が残りの表示領域へ移動することを検証する。
  await page.evaluate(`window.test.tapScreen(${focus.x}, ${focus.y})`);
  await page.evaluate("window.test.showPlayGate(true)");
  // 映像の中央では操作面より手前で受ける (止まった映像へタップを送らせない)
  ok(
    (await page.evaluate(`window.test.topIdAt(${width / 2}, ${height / 2})`)) === "playgate",
    `${name}: 再生ボタンが操作面の裏に隠れている`
  );
  // 出ているあいだもHUDのボタンは押せること (HUDはこれより手前)
  const hudId = await page.evaluate(`(() => {
    const r = document.getElementById("kbd-toggle").getBoundingClientRect();
    return window.test.topIdAt(r.x + r.width / 2, r.y + r.height / 2);
  })()`);
  ok(hudId === "kbd-toggle", `${name}: 再生ボタンがHUDのボタンを覆っている`, hudId);
  await page.evaluate("window.test.showPlayGate(false)");

  // 2. 画面内キーボードを開いた状態にする
  await page.evaluate("window.test.toggleKeyboard()");
  await new Promise((r) => setTimeout(r, 100)); // ResizeObserverの通知を待つ
  // OSキーボードは自動表示しない。画面内パネルだけが下端を使う。
  const visible = height;
  await page.evaluate(`window.test.setVisibleHeight(${visible})`);
  await new Promise((r) => setTimeout(r, 100));
  const open = await page.evaluate("JSON.stringify(window.test.measure())").then(JSON.parse);

  const focused = await page.evaluate(
    `window.test.transformedScreenPoint(${focus.x}, ${focus.y})`
  );
  near(
    focused.x,
    open.box.w / 2,
    3,
    `${name}: フォーカス箇所の横位置が表示領域に来ていない`
  );
  ok(
    focused.y >= 0 && focused.y <= open.box.h,
    `${name}: フォーカス箇所が表示領域にScrollIntoViewされていない`,
    JSON.stringify({ focused, box: open.box, transform: open.transform })
  );

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
  // 埋めた映像が領域を覆いきっていること (端に黒い帯を残さない)
  ok(covers(open), `${name}: キーボードを出すと映像の端に黒い帯が残る`, coverage(open));
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

  // 4. マウス操作パネル。タッチでは長押し・2本指に当てるしかなかった操作を、
  //    外しようのないボタンにして出す。
  await page.evaluate("window.test.toggleMouse()");
  await new Promise((r) => setTimeout(r, 100));
  const mouse = await page.evaluate("JSON.stringify(window.test.measure())").then(JSON.parse);
  const parts = await page.evaluate("JSON.stringify(window.test.mouseParts())").then(JSON.parse);
  ok(mouse.panel, `${name}: マウスパネルが出ていない`);
  ok(mouse.box.h > 40, `${name}: マウスパネルで映像の領域が潰れている`, `${mouse.box.h}px`);
  // キーボードと同じ枠に収まっていること。高さや見え方が中身で変わると、
  // 切り替えるたびに映像が伸び縮みして、見ている場所を見失う。
  near(mouse.panel.h, open.panel.h, 1, `${name}: マウスパネルとキーボードで高さが違う`);
  near(mouse.panel.x, open.panel.x, 1, `${name}: パネルの左端が揃っていない`);
  near(mouse.panel.w, open.panel.w, 1, `${name}: パネルの幅が揃っていない`);
  near(mouse.box.h, open.box.h, 1, `${name}: パネルを替えると映像の領域が変わる`);
  near(mouse.content.h, open.content.h, 1, `${name}: パネルを替えると映像の大きさが変わる`);
  near(mouse.content.y, open.content.y, 1, `${name}: パネルを替えると映像の位置が動く`);
  // キーボードと同じく、残った領域を余白なく使うこと
  ok(
    mouse.content.w >= mouse.box.w * 0.95 && mouse.content.h >= mouse.box.h * 0.95,
    `${name}: マウスパネルを出すと余白ばかりになる`,
    coverage(mouse)
  );
  ok(covers(mouse), `${name}: マウスパネルを出すと映像の端に黒い帯が残る`, coverage(mouse));

  // 開いた時点で、手元のカーソル位置をPC側へ言い切って合わせること。
  // ずれたまま相対で動かし始めると、最初のひとなぞりでカーソルが飛ぶ。
  await page.evaluate("window.test.toggleMouse()"); // いったん閉じる
  await new Promise((r) => setTimeout(r, 60));
  await page.evaluate("window.test.tapScreen(0.7, 0.3)"); // ここをクリックしておく
  await page.evaluate("window.test.takeDcSent()");
  await page.evaluate("window.test.toggleMouse()"); // もう一度開く
  await new Promise((r) => setTimeout(r, 60));
  const synced = (
    await page.evaluate("JSON.stringify(window.test.takeDcSent())").then(JSON.parse)
  ).find((m) => m.t === "mv");
  ok(
    synced && Math.abs(synced.x - 0.7) < 0.02 && Math.abs(synced.y - 0.3) < 0.02,
    `${name}: パネルを開いてもカーソル位置を合わせ直さない`,
    JSON.stringify(synced)
  );

  for (const p of Object.keys(parts)) {
    ok(parts[p], `${name}: マウスパネルの ${p} が無い`);
  }
  const rightOf = (a, b) => a.x >= b.x + b.w - 1; // aがbの右にある
  const below = (a, b) => a.y >= b.y + b.h - 1;
  // なぞる面と押すキーは場所で分ける。混ざると、なぞるつもりが押してしまう。
  ok(rightOf(parts.keys, parts.pad), `${name}: なぞる面と押すキーが分かれていない`);
  ok(
    rightOf(parts.right, parts.left) && below(parts.hold, parts.left),
    `${name}: 左・右・つまむの並びが崩れている`
  );
  ok(rightOf(parts.dbl, parts.hold), `${name}: ダブルがつまみの右に無い`);
  // 一番よく押すものが一番大きいこと
  ok(
    parts.left.w > parts.right.w,
    `${name}: 左が右より大きくない`,
    `${parts.left.w.toFixed(0)}px / ${parts.right.w.toFixed(0)}px`
  );
  // 指で押せる大きさが揃っていること (小さいキーを混ぜて場所を稼がない)
  ok(
    parts.minKey && parts.minKey.w >= 60 && parts.minKey.h >= 36,
    `${name}: 指で押せない大きさのキーがある`,
    parts.minKey &&
      `${parts.minKey.label} が ${parts.minKey.w.toFixed(0)}x${parts.minKey.h.toFixed(0)}px`
  );
  // なぞる面は指を滑らせるので、キー1つより広く取る
  ok(
    parts.pad.w >= 80 && parts.pad.h >= 70,
    `${name}: なぞる面が狭い`,
    `${parts.pad.w.toFixed(0)}x${parts.pad.h.toFixed(0)}px`
  );
  // 映像の上に浮かぶ🎤はパネルを出すと引っ込むので、こちらに代わりが要る
  // (無いとパネルを出しているあいだ喋る手段が無くなる)
  ok(below(parts.pad, parts.mic), `${name}: 🎤がなぞる面の上に無い`);
  ok(
    parts.mic.h >= 44 && parts.mic.w >= 60,
    `${name}: マウスパネルの🎤が押しっぱなしにしづらい大きさ`,
    `${parts.mic.w.toFixed(0)}x${parts.mic.h.toFixed(0)}px`
  );
  // 🎤の押下はVoiceInputが持つ。ここで操作まで送ると二重に反応する。
  await page.evaluate("window.test.takeDcSent()");
  await page.evaluate('window.test.pressKey("🎤")');
  const padMic = await page.evaluate("JSON.stringify(window.test.takeDcSent())").then(JSON.parse);
  ok(padMic.length === 0, `${name}: マウスパネルの🎤が操作を送っている`, JSON.stringify(padMic));

  // 出しているあいだ、映像をなぞってもカーソルが動くだけでクリックにならない。
  // 押す場所を決められないと、右クリックもつまみも狙って出せない。
  await page.evaluate("window.test.takeDcSent()");
  await page.evaluate("window.test.dragScreen({x:0.3,y:0.3},{x:0.6,y:0.6})");
  await new Promise((r) => setTimeout(r, 100));
  const traced = await page.evaluate("JSON.stringify(window.test.takeDcSent())").then(JSON.parse);
  ok(
    traced.some((m) => m.t === "mv"),
    `${name}: パネル表示中に映像をなぞってもカーソルが動かない`
  );
  ok(
    !traced.some((m) => m.t === "dn" || m.t === "up"),
    `${name}: パネル表示中に映像へ触れるとクリックになる`,
    JSON.stringify(traced)
  );

  // 粗い移動と細かい移動を1本の指で使い分けられること。
  // 1920pxのデスクトップを390pxの幅に縮めて映しているので、指の位置をそのまま
  // カーソルにすると1pxの指の動きが5px飛び、小さいボタンは狙えない。
  const lastMove = (msgs) => msgs.filter((m) => m.t === "mv").at(-1);
  await page.evaluate("window.test.takeDcSent()");
  // 埋めているあいだデスクトップは一部しか映っていないので、押す場所は
  // ホスト画面の座標ではなく、実際に見えている画面の側で指定する。
  const touched = await page
    .evaluate("JSON.stringify(window.test.tapVisible(0.35, 0.4))")
    .then(JSON.parse);
  await new Promise((r) => setTimeout(r, 60));
  const jumped = lastMove(
    await page.evaluate("JSON.stringify(window.test.takeDcSent())").then(JSON.parse)
  );
  ok(jumped, `${name}: パネル表示中のタップがホストへ届かない`);
  if (jumped) {
    // 送った座標が、押したところに見えていたものと同じか (逆から確かめる)
    const shown = await page.evaluate(
      `window.test.transformedScreenPoint(${jumped.x}, ${jumped.y})`
    );
    near(shown.x, touched.x, 2, `${name}: パネル表示中のタップでその位置へ飛ばない`);
    near(shown.y, touched.y, 2, `${name}: パネル表示中のタップでその位置へ飛ばない`);
  }

  // なぞったときは指の位置へ飛ばず、動かしたぶんだけ今の位置から動く。
  // 同じところを2回なぞって見分ける — 指の位置へ飛んでいるなら2回とも同じ座標に
  // 出るが、トラックボールなら2回目はそのぶんさらに進む。
  const rub = async () => {
    await page.evaluate("window.test.dragScreen({x:0.8,y:0.8},{x:0.9,y:0.9})");
    await new Promise((r) => setTimeout(r, 60));
    return lastMove(
      await page.evaluate("JSON.stringify(window.test.takeDcSent())").then(JSON.parse)
    );
  };
  const nudged = await rub();
  const nudgedAgain = await rub();
  ok(
    nudged && nudgedAgain && nudged.x !== jumped.x && nudgedAgain.x - nudged.x > 0.01,
    `${name}: なぞるとトラックボールにならず指の位置へ飛ぶ`,
    JSON.stringify({ jumped, nudged, nudgedAgain })
  );

  // 拡大して切り取っているあいだ、トラックボールで大きく動かしても
  // カーソルは見えている範囲に残ること (映像の方がずれて追う)。
  // 映っていない範囲へ出ると、PC側では動いているのにこちらの画面では何も
  // 起きていないように見えて、カーソルの行方が分からなくなる。
  for (let i = 0; i < 6; i++) {
    await page.evaluate("window.test.dragScreen({x:0.4,y:0.4},{x:0.6,y:0.6})");
  }
  await new Promise((r) => setTimeout(r, 60));
  const far = lastMove(
    await page.evaluate("JSON.stringify(window.test.takeDcSent())").then(JSON.parse)
  );
  ok(far, `${name}: なぞってもカーソルが動かない`);
  if (far) {
    const at = await page.evaluate(`window.test.transformedScreenPoint(${far.x}, ${far.y})`);
    // 端まで動かすと、映像の端そのものが表示領域の端に来る (1pxは丸めの幅)
    ok(
      at.x >= -1 && at.x <= mouse.box.w + 1 && at.y >= -1 && at.y <= mouse.box.h + 1,
      `${name}: なぞるとカーソルが映っていない範囲へ出る`,
      JSON.stringify({ cursor: far, at, box: mouse.box })
    );
  }

  // なぞる面。矢印ボタンだと1回1ノッチで、長い文書は連射待ちになる。
  const totalWheel = (msgs, axis) =>
    msgs.filter((m) => m.t === "wh").reduce((n, m) => n + (m[axis] ?? 0), 0);
  await page.evaluate("window.test.takeDcSent()");
  await page.evaluate("window.test.rubScroll(0, 60)"); // 指を下へ60px = 上スクロール
  const rubbedUp = await page.evaluate("JSON.stringify(window.test.takeDcSent())").then(JSON.parse);
  ok(
    totalWheel(rubbedUp, "dy") >= 4,
    `${name}: 面をなぞってもスクロールしない`,
    JSON.stringify(rubbedUp)
  );
  // 縦になぞったぶんに横が混ざらないこと (行がじりじり横へ流れる)
  ok(
    totalWheel(rubbedUp, "dx") === 0,
    `${name}: 縦になぞると横スクロールが混ざる`,
    JSON.stringify(rubbedUp)
  );

  await page.evaluate("window.test.rubScroll(0, -60)"); // 指を上へ = 下スクロール
  ok(
    totalWheel(
      await page.evaluate("JSON.stringify(window.test.takeDcSent())").then(JSON.parse),
      "dy"
    ) < 0,
    `${name}: 逆になぞっても逆向きにスクロールしない`
  );

  // 横も同じ面でなぞれること (専用のボタンを並べずに済ませている)
  await page.evaluate("window.test.rubScroll(60, 0)");
  const rubbedSide = await page
    .evaluate("JSON.stringify(window.test.takeDcSent())")
    .then(JSON.parse);
  ok(
    totalWheel(rubbedSide, "dx") !== 0,
    `${name}: 面を横になぞっても横スクロールしない`,
    JSON.stringify(rubbedSide)
  );
  ok(
    totalWheel(rubbedSide, "dy") === 0,
    `${name}: 横になぞると縦スクロールが混ざる`,
    JSON.stringify(rubbedSide)
  );
  // なぞっているあいだに中クリックが出ないこと
  // (Windowsではタブが開いたり自動スクロールに入ってしまう)
  ok(
    !rubbedSide.some((m) => m.t === "dn"),
    `${name}: なぞると中クリックが出る`,
    JSON.stringify(rubbedSide)
  );

  // なぞらずに離したときだけ中クリック (ホイールを押すのと同じ)。
  // 中クリックのためだけのボタンを並べずに済ませている。
  await page.evaluate("window.test.rubScroll(0, 0)");
  const midTap = await page.evaluate("JSON.stringify(window.test.takeDcSent())").then(JSON.parse);
  ok(
    JSON.stringify(midTap) ===
      JSON.stringify([
        { t: "dn", b: 1 },
        { t: "up", b: 1 },
      ]),
    `${name}: 面を押しても中クリックにならない`,
    JSON.stringify(midTap)
  );

  // 1ノッチに届かない短いなぞりは、回りもしないし中クリックにもならないこと。
  // ここで中クリックが出るとWindowsが自動スクロールに入り、以後カーソルを
  // 動かすたびに画面が流れて「位置がずれた」ように見える。
  await page.evaluate("window.test.rubScroll(0, 10)");
  const shortRub = await page.evaluate("JSON.stringify(window.test.takeDcSent())").then(JSON.parse);
  ok(
    shortRub.length === 0,
    `${name}: 1ノッチに満たないなぞりで中クリックが出る`,
    JSON.stringify(shortRub)
  );

  // 右クリックはボタン1つで出る (2本指タップの判定に頼らない)
  await page.evaluate('window.test.pressKey("右")');
  const rightClick = await page.evaluate("JSON.stringify(window.test.takeDcSent())").then(JSON.parse);
  ok(
    JSON.stringify(rightClick) ===
      JSON.stringify([
        { t: "dn", b: 2 },
        { t: "up", b: 2 },
      ]),
    `${name}: 右ボタンが右クリックを送らない`,
    JSON.stringify(rightClick)
  );

  // つまむ → なぞる → はなす。押しっぱなしのまま運べること。
  await page.evaluate('window.test.pressKey("つまむ")');
  const grabbed = await page.evaluate("JSON.stringify(window.test.takeDcSent())").then(JSON.parse);
  ok(
    JSON.stringify(grabbed) === JSON.stringify([{ t: "dn", b: 0 }]),
    `${name}: つまんでも左ボタンが押されない`,
    JSON.stringify(grabbed)
  );
  ok(
    (await page.evaluate("window.test.holdKeyLabel()")) === "はなす",
    `${name}: 掴んでいることがキートップに出ない`
  );
  await page.evaluate("window.test.dragScreen({x:0.6,y:0.6},{x:0.3,y:0.3})");
  await new Promise((r) => setTimeout(r, 100));
  const carried = await page.evaluate("JSON.stringify(window.test.takeDcSent())").then(JSON.parse);
  ok(
    carried.some((m) => m.t === "mv") && !carried.some((m) => m.t === "up"),
    `${name}: つまんだまま運べない`,
    JSON.stringify(carried)
  );

  // 掴んだままパネルを閉じたら離すこと。残すとPC側は左ボタンを押しっぱなしになり、
  // 以後の操作が全部ドラッグになって、画面を見ても原因が分からない。
  await page.evaluate("window.test.toggleMouse()");
  await new Promise((r) => setTimeout(r, 100));
  const released = await page.evaluate("JSON.stringify(window.test.takeDcSent())").then(JSON.parse);
  ok(
    released.some((m) => m.t === "up" && !m.b),
    `${name}: 掴んだままパネルを閉じると左ボタンが戻らない`,
    JSON.stringify(released)
  );
  const afterMouse = await page.evaluate("JSON.stringify(window.test.measure())").then(JSON.parse);
  near(afterMouse.content.h, closed.content.h, 1, `${name}: パネルを閉じても全体表示に戻らない`);

  // 閉じたら映像のタップはまたクリックに戻る
  await page.evaluate("window.test.takeDcSent()");
  await page.evaluate("window.test.tapScreen(0.5, 0.5)");
  const tapped = await page.evaluate("JSON.stringify(window.test.takeDcSent())").then(JSON.parse);
  ok(
    tapped.some((m) => m.t === "dn"),
    `${name}: パネルを閉じてもタップがクリックに戻らない`,
    JSON.stringify(tapped)
  );

  // 5. 下端のパネルを行き来しても映像が動かないこと。
  //
  //    ここまでの検証は、いったん全部閉じてから次を開いていた。実際に押される
  //    ボタンは「今出ているものを閉じて、次を開く」で、閉じた通知と開いた通知は
  //    別々に届く。0が先に届いたぶんをそのまま反映すると、一瞬だけ下端に何も
  //    無い状態になり、映像は全体表示へ戻ってから埋め直される — 見た目には
  //    出ない一瞬でも、そのあいだに拡大も位置も作り直されるので、切り替えるたびに
  //    映像が動いていた。閉じてから開く経路そのものを通して測る。
  //
  //    OSキーボードだけはトレイの高さが違う (下にキーボードが控えているので
  //    入力欄1行ぶんしか置けない)。領域が変わっても、映像の大きさと位置は
  //    変えずに切り取る量だけを変えること。
  const osHidden = Math.round(height * 0.35);
  const openOs = async () => {
    await page.evaluate("window.test.openText()"); // 入力欄が先に出て、
    await new Promise((r) => setTimeout(r, 60));
    await page.evaluate(`window.test.setVisibleHeight(${height - osHidden})`); // 少し遅れて上がる
    await new Promise((r) => setTimeout(r, 120));
  };
  const closeOs = async (open) => {
    await page.evaluate(`window.test.${open}()`); // 実物のボタンと同じく先に入力欄を閉じ、
    await new Promise((r) => setTimeout(r, 60));
    await page.evaluate(`window.test.setVisibleHeight(${height})`); // キーボードは少し遅れて下がる
    await new Promise((r) => setTimeout(r, 120));
  };
  const settle = () => new Promise((r) => setTimeout(r, 120));

  await page.evaluate("window.test.toggleKeyboard()");
  await settle();
  // 開いた直後の位置のままだと、置き直されても同じ絵になってしまって差が出ない。
  // 実際に使うときと同じく、少しつまんで見たいところを出してから測る。
  await page.evaluate(`window.test.pinch(${width / 2}, ${height / 3}, 200, 260)`);
  await settle();
  const first = await page.evaluate("JSON.stringify(window.test.measure())").then(JSON.parse);
  ok(
    first.content.h > open.content.h + 1,
    `${name}: つまんでも拡大できていない`,
    `${first.content.h.toFixed(0)}px / ${open.content.h.toFixed(0)}px`
  );
  const steps = [];
  const step = async (label, act) => {
    await act();
    steps.push([label, await page.evaluate("JSON.stringify(window.test.measure())").then(JSON.parse)]);
  };
  await step("マウスパネルへ", async () => {
    await page.evaluate("window.test.toggleMouse()");
    await settle();
  });
  await step("キーボードへ戻す", async () => {
    await page.evaluate("window.test.toggleKeyboard()");
    await settle();
  });
  await step("OSキーボードへ", openOs);
  await step("OSキーボードからマウスパネルへ", () => closeOs("toggleMouse"));
  await step("キーボードへ戻す", async () => {
    await page.evaluate("window.test.toggleKeyboard()");
    await settle();
  });
  for (const [label, m] of steps) {
    near(m.content.w, first.content.w, 1, `${name}: ${label} で映像の大きさが変わる`);
    near(m.content.h, first.content.h, 1, `${name}: ${label} で映像の大きさが変わる`);
    near(m.content.x, first.content.x, 1, `${name}: ${label} で映像が横に動く`);
    near(m.content.y, first.content.y, 1, `${name}: ${label} で映像が縦に動く`);
    // 動かさないために黒い帯を出していないこと (埋めるのは元からの約束)
    ok(covers(m), `${name}: ${label} で映像の端に黒い帯が残る`, coverage(m));
  }
  // OSキーボードのときだけは領域そのものが狭い。同じ映像のまま、下を切り取る量が
  // 増えるだけ、という形になっていること (映像が動かないのが領域が同じだから、では困る)
  const onOs = steps[2][1];
  ok(
    onOs.box.h < first.box.h - 10,
    `${name}: OSキーボードで映像の領域が狭くなっていない`,
    `${onOs.box.h.toFixed(0)}px / ${first.box.h.toFixed(0)}px`
  );
  await page.evaluate("window.test.toggleKeyboard()"); // 後片付け
  await settle();

  return { closed, open, mouse };
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
  for (const [name, r] of [
    ["縦持ち", portrait],
    ["横持ち", landscape],
  ]) {
    console.log(
      `${name}: キーボード ${r.open.panel.h.toFixed(0)}px (映像 ${r.open.box.h.toFixed(0)}px) / ` +
        `マウス ${r.mouse.panel.h.toFixed(0)}px (映像 ${r.mouse.box.h.toFixed(0)}px)`
    );
  }
} finally {
  page.close();
}

if (failures.length) {
  console.error(`\n✘ レイアウト検証 ${failures.length}件の失敗 (${checks}項目)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\n✓ レイアウト検証 ${checks}項目すべて通過`);

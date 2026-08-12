// レイアウト検証用のページ。実物のマークアップ・CSS・部品をそのまま組み立て、
// スマホのソフトキーボードが出た状態を作れるようにして test/layout.mjs から測る。
//
// 本物と違うのは2点だけ:
//   - visualViewport は読み取り専用で偽装できないので、同じ形の物を渡す
//     (キーボードで見える高さが変わる、という入力そのものを差し替える)。
//   - 映像はWebRTCの代わりにcanvasのストリーム。videoWidth/Heightが入るので
//     レターボックスの計算は実物と同じ経路を通る。
import { VIEWER_HTML } from "../src/viewer";
import { VirtualKeyboard } from "../src/keyboard";
import { MousePad } from "../src/mouse";
import { InputController } from "../src/input";
import { TextInput } from "../src/text";
import { attachScreenLayout } from "../src/screen";

const CONTENT = { w: 1920, h: 1080 };

class FakeViewport extends EventTarget {
  height = window.innerHeight;
  offsetTop = 0;
}

const app = document.getElementById("app")!;
app.innerHTML = VIEWER_HTML;
const video = document.getElementById("screen") as HTMLVideoElement;
const surface = document.getElementById("surface")!;
const vroot = document.getElementById("vroot")!;
// CDPから合成したPointerEventには実在するポインターが無く、Chromeの
// setPointerCapture()が例外になるため、レイアウトテストでは捕捉だけ無効化する。
surface.setPointerCapture = () => {};

// canvasを映像源にして、実物と同じく videoWidth/videoHeight が入った状態にする
const canvas = document.createElement("canvas");
canvas.width = CONTENT.w;
canvas.height = CONTENT.h;
const ctx = canvas.getContext("2d")!;
ctx.fillStyle = "#1d2b44";
ctx.fillRect(0, 0, CONTENT.w, CONTENT.h);
ctx.fillStyle = "#ffd479";
ctx.fillRect(0, 0, CONTENT.w, 40); // 上端の目印
ctx.fillRect(0, CONTENT.h - 40, CONTENT.w, 40); // 下端の目印
video.srcObject = canvas.captureStream(5);
void video.play().catch(() => {});

// 音声対応端末と同じ状態にする (キーボードを開いたら退くかを見るため)
(document.getElementById("mic") as HTMLElement).style.display = "";

// ホストへ実際に飛ぶ操作メッセージ (タップ位置の検証に使う)。
// キーボード側の sent とは経路が違うので分けて溜める。
const dcSent: object[] = [];
const dc = {
  readyState: "open",
  bufferedAmount: 0,
  send(data: unknown) {
    if (typeof data === "string") dcSent.push(JSON.parse(data));
  },
} as unknown as RTCDataChannel;
const controller = new InputController(video, surface, dc);
const vv = new FakeViewport();
const screen = attachScreenLayout(
  vroot,
  (occluded) => controller.relayout(occluded),
  vv as unknown as VisualViewport
);
const sent: object[] = [];
// 実機と同じく🎤キーを載せた状態で測る (音声対応端末を想定)
const kbd = new VirtualKeyboard(
  vroot,
  (m) => sent.push(m),
  (h) => screen.setWebKeyboardHeight(h),
  true
);
// マウス操作パネル。キーボードの後ろに置く (実物と同じ並び順)。
// 実機と同じく🎤キーを載せた状態で測る (音声対応端末を想定)。
const mouse = new MousePad(
  vroot,
  (m) => controller.send(m), // 実物と同じくOutbox経由でホストへ出す
  (h) => screen.setMousePadHeight(h),
  (open) => controller.setCursorOnly(open),
  true
);
const textToggle = document.getElementById("text-toggle") as HTMLButtonElement;
const textEntry = document.getElementById("text-entry") as HTMLFormElement;
const textField = document.getElementById("text-field") as HTMLInputElement;
const textClose = document.getElementById("text-close") as HTMLButtonElement;
const text = new TextInput(
  textToggle,
  textEntry,
  textField,
  textClose,
  (m) => sent.push(m),
  () => kbd.close(),
  (h) => screen.setTextInputHeight(h)
);
textToggle.style.display = "";
screen.apply(); // 実物も接続時にここまでやる

function findKey(label: string): Element {
  const btn = [...document.querySelectorAll(".kbd-key, .mouse-key")].find(
    (el) => el.textContent === label && (el as HTMLElement).offsetParent
  );
  if (!btn) throw new Error(`キーが見つからない: ${label}`);
  return btn;
}

function fire(btn: Element, type: string): void {
  btn.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true }));
}

function screenPoint(x: number, y: number): { x: number; y: number } {
  const r = video.getBoundingClientRect();
  const s = Math.min(r.width / video.videoWidth, r.height / video.videoHeight);
  return {
    x: r.left + (r.width - video.videoWidth * s) / 2 + video.videoWidth * s * x,
    y: r.top + (r.height - video.videoHeight * s) / 2 + video.videoHeight * s * y,
  };
}

function tapAt(p: { x: number; y: number }): void {
  const init = {
    bubbles: true,
    cancelable: true,
    pointerId: 42,
    pointerType: "touch",
    clientX: p.x,
    clientY: p.y,
  };
  surface.dispatchEvent(new PointerEvent("pointerdown", init));
  surface.dispatchEvent(new PointerEvent("pointerup", init));
}

function transformedScreenPoint(x: number, y: number): { x: number; y: number } {
  const w = video.clientWidth;
  const h = video.clientHeight;
  const s = Math.min(w / video.videoWidth, h / video.videoHeight);
  const p = {
    x: (w - video.videoWidth * s) / 2 + video.videoWidth * s * x,
    y: (h - video.videoHeight * s) / 2 + video.videoHeight * s * y,
  };
  const m = new DOMMatrix(getComputedStyle(video).transform);
  return { x: m.a * p.x + m.e, y: m.d * p.y + m.f };
}

// 要素の矩形 (transform適用後)
function rect(el: Element | null) {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom };
}

// 映像そのものが映っている矩形。object-fit:contain の余白を除いた中身。
function contentRect() {
  const r = video.getBoundingClientRect();
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) return null;
  const s = Math.min(r.width / vw, r.height / vh);
  const w = vw * s;
  const h = vh * s;
  return { x: r.left + (r.width - w) / 2, y: r.top + (r.height - h) / 2, w, h };
}

Object.assign(window, {
  test: {
    ready: () => video.videoWidth > 0,
    // ソフトキーボードで見える高さが縮んだ状態を作る
    setVisibleHeight(h: number) {
      vv.height = h;
      vv.dispatchEvent(new Event("resize"));
    },
    toggleKeyboard() {
      mouse.close();
      kbd.toggle();
    },
    toggleMouse() {
      kbd.close();
      mouse.toggle();
    },
    // 映像を1本指でなぞる (パネル表示中にカーソルだけ動くことの検証に使う)
    dragScreen(from: { x: number; y: number }, to: { x: number; y: number }) {
      const a = screenPoint(from.x, from.y);
      const b = screenPoint(to.x, to.y);
      const init = (x: number, y: number) => ({
        bubbles: true,
        cancelable: true,
        pointerId: 43,
        pointerType: "touch",
        clientX: x,
        clientY: y,
      });
      surface.dispatchEvent(new PointerEvent("pointerdown", init(a.x, a.y)));
      for (let i = 1; i <= 4; i++) {
        const t = i / 4;
        surface.dispatchEvent(
          new PointerEvent("pointermove", init(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t))
        );
      }
      surface.dispatchEvent(new PointerEvent("pointerup", init(b.x, b.y)));
    },
    openText() {
      textToggle.click();
    },
    sendText(value: string) {
      textField.value = value;
      textEntry.requestSubmit();
    },
    closeText() {
      text.close();
    },
    // 数字・記号面へ切り替える (押されたときと同じ経路を通す)
    toggleLayer() {
      document
        .querySelector(".kbd-layer-key")
        ?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    },
    // 出ている面のラベル。面を切り替えたことの確認に使う。
    layerKeyLabel: () => document.querySelector(".kbd-layer-key")?.textContent ?? "",
    // つまみキーのラベル。掴んだままかどうかが手元で分かることの確認に使う。
    holdKeyLabel: () => document.querySelector(".mouse-hold")?.textContent ?? "",
    // スクロール面を (dx,dy) だけなぞる。0,0 ならなぞらずに離す (=中クリック)。
    // 1ノッチに満たない距離も渡せる (回らないのに中クリックが出ないことの検証)。
    rubScroll(dx: number, dy: number) {
      const pad = document.querySelector(".mouse-scroll") as HTMLElement;
      pad.setPointerCapture = () => {}; // 合成イベントには実在するポインターが無い
      const r = pad.getBoundingClientRect();
      const init = (x: number, y: number) => ({
        bubbles: true,
        cancelable: true,
        pointerId: 44,
        pointerType: "touch",
        clientX: x,
        clientY: y,
      });
      const x0 = r.x + r.width / 2;
      const y0 = r.y + r.height / 2;
      pad.dispatchEvent(new PointerEvent("pointerdown", init(x0, y0)));
      for (let i = 1; i <= 8; i++) {
        const t = i / 8;
        pad.dispatchEvent(new PointerEvent("pointermove", init(x0 + dx * t, y0 + dy * t)));
      }
      pad.dispatchEvent(new PointerEvent("pointerup", init(x0 + dx, y0 + dy)));
    },
    // マウスパネルの各部の位置と大きさ。
    mouseParts() {
      const at = (sel: string) => rect(document.querySelector(sel));
      const keys = [...document.querySelectorAll(".mouse-key")].filter(
        (el) => (el as HTMLElement).offsetParent
      ) as HTMLElement[];
      const byLabel = (label: string) =>
        rect(keys.find((el) => el.textContent === label) ?? null);
      return {
        body: at(".mousepad:not(.hidden) .mousepad-body"),
        pad: at(".mouse-scroll"),
        keys: at(".mouse-keys"),
        mic: at(".mouse-mic"),
        left: byLabel("左"),
        right: byLabel("右"),
        hold: at(".mouse-hold"),
        dbl: byLabel("ダブル"),
        // いちばん小さいキーと、その名前 (指で押せない大きさが混ざっていないか)
        minKey: keys.length
          ? keys
              .map((el) => {
                const r = el.getBoundingClientRect();
                return { w: r.width, h: r.height, label: el.textContent ?? "" };
              })
              .reduce((a, b) => (Math.min(a.w, a.h) <= Math.min(b.w, b.h) ? a : b))
          : null,
      };
    },
    // ラベルでキーを押す (実物と同じ pointerdown の経路を通す)。
    // 押した時点でラベルが変わる(Shiftの大文字化)ので、要素は先に1回だけ引く。
    pressKey(label: string) {
      const btn = findKey(label);
      fire(btn, "pointerdown");
      fire(btn, "pointerup");
    },
    tapScreen(x: number, y: number) {
      const p = screenPoint(x, y);
      tapAt(p);
    },
    // 見えている範囲の (fx,fy) の位置を押して、押した画面座標を返す。
    // 拡大・切り取り表示ではホスト画面のどこが映っているかが倍率とパンで
    // 変わるので、ホスト側の座標では「実際に押せる場所」を指定できない。
    tapVisible(fx: number, fy: number) {
      const p = { x: video.clientWidth * fx, y: video.clientHeight * fy };
      tapAt(p);
      return p;
    },
    // 2本指のピンチ。(cx,cy)を中心に、指の間隔を from → to へ変える。
    pinch(cx: number, cy: number, from: number, to: number) {
      const touch = (id: number, x: number, y: number) => ({
        bubbles: true,
        cancelable: true,
        pointerId: id,
        pointerType: "touch",
        clientX: x,
        clientY: y,
      });
      const at = (type: string, id: number, d: number, side: number) =>
        surface.dispatchEvent(new PointerEvent(type, touch(id, cx + (side * d) / 2, cy)));
      at("pointerdown", 1, from, -1);
      at("pointerdown", 2, from, 1);
      // 途中を数回に分けて動かす (実際の指と同じく少しずつ広がる)
      for (let i = 1; i <= 4; i++) {
        const d = from + ((to - from) * i) / 4;
        at("pointermove", 1, d, -1);
        at("pointermove", 2, d, 1);
      }
      at("pointerup", 1, to, -1);
      at("pointerup", 2, to, 1);
    },
    // 映像の拡大率 (ピンチが効いたかの確認に使う)
    videoScale: () => new DOMMatrix(getComputedStyle(video).transform).a,
    transformedScreenPoint,
    // 押しっぱなし・離すを別々に起こす (連射の検証に使う)
    keyDown: (label: string) => fire(findKey(label), "pointerdown"),
    keyUp: (label: string) => fire(findKey(label), "pointerup"),
    // 文字キーのラベル (Shiftで大文字になることの確認に使う)
    letterLabels: () =>
      [...document.querySelectorAll(".kbd-layer:not([hidden]) .kbd-key")]
        .map((el) => el.textContent)
        .join(""),
    takeSent() {
      return sent.splice(0, sent.length);
    },
    // ホストへ飛んだ操作メッセージ (mv/dn/up など)
    takeDcSent() {
      return dcSent.splice(0, dcSent.length);
    },
    // 自動再生が止められた状態を作る
    showPlayGate(on: boolean) {
      (document.getElementById("playgate") as HTMLElement).hidden = !on;
    },
    // その座標でいちばん手前にある要素のid (重なり順の確認に使う)
    topIdAt(x: number, y: number) {
      return document.elementFromPoint(x, y)?.id ?? "";
    },
    measure() {
      const ops = document.querySelector(".kbd-ops") as HTMLElement | null;
      const key = document.querySelector(".kbd-key") as HTMLElement | null;
      // 出ている面の分だけ (隠れている面は幅0で混ざるので除く)
      const keys = [...document.querySelectorAll(".kbd-key")].filter(
        (el) => (el as HTMLElement).offsetParent
      ) as HTMLElement[];
      const rows = [...document.querySelectorAll(".kbd-row")].filter(
        (el) => (el as HTMLElement).offsetParent
      ) as HTMLElement[];
      return {
        visibleHeight: vv.height,
        viewer: rect(vroot),
        box: { w: video.clientWidth, h: video.clientHeight },
        panel: rect(document.querySelector(".kbd:not(.hidden)")),
        video: rect(video),
        content: contentRect(),
        transform: getComputedStyle(video).transform,
        opsHeight: ops ? ops.offsetHeight : 0,
        keyHeight: key ? key.offsetHeight : 0,
        // 一番細いキーと、その名前 (押せない幅になっていないかを見る)
        minKey: keys.length
          ? keys
              .map((el) => ({ w: el.getBoundingClientRect().width, label: el.textContent ?? "" }))
              .reduce((a, b) => (a.w <= b.w ? a : b))
          : null,
        // 段が重なっていないか (段の上端の種類を数える)
        rowTops: [...new Set(rows.map((el) => Math.round(el.getBoundingClientRect().top)))].length,
        // 段の中に穴が空いていないか。段の幅とキーの合計が合うかで見る。
        rowGaps: rows.map((el) => {
          const r = el.getBoundingClientRect();
          const gap = parseFloat(getComputedStyle(el).columnGap) || 0;
          const cells = [...el.children].map((c) => c.getBoundingClientRect());
          const used = cells.reduce((n, c) => n + c.width, 0);
          return Math.round(r.width - used - (cells.length - 1) * gap);
        }),
        micShown: !!(document.querySelector(".mic") as HTMLElement | null)?.offsetParent,
        kbdMic: rect(document.querySelector(".kbd-mic")),
        textEntry: rect(document.querySelector(".text-entry:not([hidden])")),
        gateShown: !!(document.getElementById("playgate") as HTMLElement).offsetParent,
      };
    },
  },
});

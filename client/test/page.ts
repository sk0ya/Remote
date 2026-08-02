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
import { InputController } from "../src/input";
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

const dc = { readyState: "open", bufferedAmount: 0, send() {} } as unknown as RTCDataChannel;
const controller = new InputController(video, surface, dc);
const vv = new FakeViewport();
const screen = attachScreenLayout(
  vroot,
  (occluded) => controller.relayout(occluded),
  vv as unknown as VisualViewport
);
const kbd = new VirtualKeyboard(vroot, () => {}, (h) => screen.setKeyboardHeight(h));
screen.apply(); // 実物も接続時にここまでやる

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
      kbd.toggle();
    },
    measure() {
      const bar = document.querySelector(".kbd-bar");
      const btn = bar?.querySelector("button");
      return {
        visibleHeight: vv.height,
        viewer: rect(vroot),
        box: { w: video.clientWidth, h: video.clientHeight },
        panel: rect(document.querySelector(".kbd:not(.hidden)")),
        video: rect(video),
        content: contentRect(),
        transform: getComputedStyle(video).transform,
        barHeight: bar ? (bar as HTMLElement).offsetHeight : 0,
        keyHeight: btn ? (btn as HTMLElement).offsetHeight : 0,
        micShown: !!(document.querySelector(".mic") as HTMLElement | null)?.offsetParent,
      };
    },
  },
});

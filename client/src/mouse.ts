// マウス操作パネル: 押せば必ずその操作になるボタンを、キーボードと同じように
// 画面へ出す。
//
// なぜ要るか:
//   タッチだけだと、右クリックは「2本指タップ」、ドラッグは「長押ししてから
//   動かす」に当てるしかない。どちらも判定に落ちれば普通の左クリックになるので、
//   狙った操作が出るかどうかが指の速さと角度の運になってしまう。
//   出したボタンを押すぶんには外しようがない。
//
// 置き方:
//   ┌──────────┐ ┌──────────┬────────┐
//   │          │ │    左    │   右   │
//   │  スクロール  │ ├──────────┼────────┤
//   │  (なぞる面) │ │  つまむ   │  ダブル │
//   └──────────┘ └──────────┴────────┘
//
//   スクロールは矢印ボタンではなく「なぞる面」にしてある。1回1ノッチの
//   ボタンだと長い文書は連射待ちになるし、押す物と回す物が同じ形で並ぶと
//   どれが何なのか見て分からない。面はなぞる物、角の丸い四角は押す物、と
//   形で分ける。面をなぞらずに離したときだけ中クリック (本物のホイールを
//   押すのと同じ) なので、中クリックのためのボタンは要らない。
//
// 分担:
//   映像 = カーソルを動かすところ / パネル = 押す・つまむ・回す
//   パネルを出しているあいだ、映像へのタッチはカーソル移動だけになる
//   (InputController.setCursorOnly)。タップした瞬間にクリックまで起きると、
//   「押す前に狙った場所へカーソルを置く」ができないため。

type Send = (msg: object) => void;

export interface MouseKey {
  label: string;
  click?: { b: 0 | 1 | 2; times?: number }; // 0=左 1=中 2=右
  hold?: boolean; // 左ボタンの押しっぱなしトグル (つまんで運ぶ)
}

// つまみキーのラベル。押すと「はなす」に変わり、いま掴んでいることが手元で分かる
// (掴めたかはPC側の画面を見るまで分からないので、状態は手元にも出す)。
export const HOLD_LABEL = { off: "つまむ", on: "はなす" } as const;

export const MOUSE_KEYS = {
  left: { label: "左", click: { b: 0 } },
  right: { label: "右", click: { b: 2 } },
  hold: { label: HOLD_LABEL.off, hold: true },
  double: { label: "ダブル", click: { b: 0, times: 2 } },
  // なぞらずに離したとき = ホイールを押したとき。面が受け持つのでキーは無い。
  middle: { label: "中", click: { b: 1 } },
} as const satisfies Record<string, MouseKey>;

// 画面に出す順 (grid の流し込み順と同じ)
const KEY_ORDER = [MOUSE_KEYS.left, MOUSE_KEYS.right, MOUSE_KEYS.hold, MOUSE_KEYS.double];

// スクロール面の効き。12pxごとに1ノッチなら、面(約116px)を1回なぞって
// 約10ノッチ = 30行。指を離さずになぞり続ければいくらでも送れる。
export const SCROLL_PX_PER_NOTCH = 12;

// 指の移動量(px) → ノッチ数。
//
// 向きは映像の2本指スクロールと揃える —「中身を指で押しやる」側。指を下へ
// 動かせば中身も下がる(＝上へスクロール)、指を右へ動かせば中身も右へ動く。
// 本物のホイールの向き(回した側へ送る)にすると、同じアプリの中で映像となぞる
// 向きが逆になり、どちらを触っているかで手が迷う。
// 「なぞった」と見なす距離(px)。
//
// 1ノッチ送ったかどうかで判定してはいけない。11pxなぞって離すと1ノッチにも
// 届かないので「なぞっていない」= ホイールを押した、と見なされ、回りもしないのに
// 中クリックが出る。Windowsではそれが自動スクロールの開始になり、以後カーソルを
// 動かすたびに画面が流れて「スクロールしたあと位置がずれる」という壊れ方をする。
export const TAP_SLOP = 8;

export function isRub(dx: number, dy: number): boolean {
  return Math.hypot(dx, dy) > TAP_SLOP;
}

export function scrollNotches(dx: number, dy: number): { dx: number; dy: number } {
  // `|| 0` は -0 を作らないため。JSONでは0になるので実害は無いが、
  // 0と食い違う値を残すと比較で引っかかる。
  const notch = (px: number): number => Math.trunc(px / SCROLL_PX_PER_NOTCH) || 0;
  return { dx: notch(-dx), dy: notch(dy) };
}

export class MousePad {
  private root: HTMLElement;
  private holdKey: HTMLButtonElement | null = null;
  // 押しっぱなしで喋るキー。押下の扱いは持たず、VoiceInput に渡して使ってもらう。
  private mic: HTMLButtonElement | null = null;
  private holding = false;
  private observer: ResizeObserver;

  constructor(
    container: HTMLElement,
    private send: Send,
    // パネルの高さが変わったことの通知 (映像の表示領域をそのぶん詰めてもらう)。
    // 開閉だけでなく、画面の回転でも高さは変わる。
    private onLayout: (height: number) => void = () => {},
    // 出ている / 引っ込めた。映像へのタッチの扱いを切り替えてもらう。
    private onOpenChange: (open: boolean) => void = () => {},
    // 音声入力に対応しているか。対応していなければ🎤キーを置かない。
    withMic = false
  ) {
    this.root = document.createElement("div");
    this.root.className = "kbd mousepad hidden";
    this.root.appendChild(this.build(withMic));
    container.appendChild(this.root);

    // 高さは開閉だけでなく回転でも変わるので、実測を購読する
    // (隠すと display:none で 0 になり、そのまま「パネルなし」として伝わる)。
    this.observer = new ResizeObserver(() => this.onLayout(this.root.offsetHeight));
    this.observer.observe(this.root);
  }

  private build(withMic: boolean): HTMLElement {
    const body = document.createElement("div");
    body.className = "mousepad-body";

    // 左の列は上から 🎤 / なぞる面。トレイの高さはキーボードに合わせてあるので、
    // なぞる面の上には余白が残る。押しっぱなしで喋るキーはそこへ置く —
    // 映像の上に浮かぶ🎤はパネルを出すと引っ込むので、代わりが要る。
    // 押下・離しの扱いは VoiceInput が持つので、ここではボタンを作るだけ。
    const left = document.createElement("div");
    left.className = "mouse-left";
    if (withMic) {
      const mic = document.createElement("button");
      mic.type = "button";
      mic.className = "mouse-key mouse-mic";
      mic.textContent = "🎤";
      this.mic = mic;
      left.appendChild(mic);
    }

    const pad = document.createElement("div");
    pad.className = "mouse-scroll";
    pad.innerHTML = `<span class="mouse-scroll-mark" aria-hidden="true"></span>
      <span class="mouse-scroll-label">スクロール</span>`;
    this.attachScroll(pad);
    left.appendChild(pad);
    body.appendChild(left);

    const keys = document.createElement("div");
    keys.className = "mouse-keys";
    for (const k of KEY_ORDER) keys.appendChild(this.makeKey(k));
    body.appendChild(keys);
    return body;
  }

  private makeKey(k: MouseKey): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "mouse-key";
    if (k === MOUSE_KEYS.left) btn.classList.add("mouse-primary");
    if (k.hold) {
      btn.classList.add("mouse-hold");
      this.holdKey = btn;
    }
    btn.textContent = k.label;
    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault(); // フォーカスを奪わない
      if (k.hold) this.toggleHold();
      else this.fire(k);
    });
    return btn;
  }

  // なぞる面。縦にも横にも回せる。
  //
  // 向きは最初に1ノッチ出た側へ固定する。固定しないと、縦になぞるたびに
  // 指のぶれぶんの横スクロールが混ざって、行がじりじり横へ流れる。
  // 面の上には押す物を置いていないので、押したぶんが混ざる心配はない。
  private attachScroll(pad: HTMLElement): void {
    // x,y はノッチを送るたびに指へ寄せていく基準点。moved は指が動いたかどうかで、
    // こちらは寄せないので、送ったノッチ数とは関係なく総移動量で判断できる。
    let drag: { id: number; x: number; y: number; moved: boolean; axis: "x" | "y" | null } | null =
      null;

    pad.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false, axis: null };
      pad.setPointerCapture(e.pointerId);
      pad.classList.add("rubbing");
    });
    pad.addEventListener("pointermove", (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      const dx = e.clientX - drag.x;
      const dy = e.clientY - drag.y;
      if (isRub(dx, dy)) drag.moved = true;
      const n = scrollNotches(dx, dy);
      drag.axis ??= n.dy !== 0 ? "y" : n.dx !== 0 ? "x" : null;
      if (!drag.axis) return;
      const sent = drag.axis === "y" ? { dy: n.dy } : { dx: n.dx };
      if (!(sent.dx || sent.dy)) return;
      this.send({ t: "wh", ...sent });
      // 送ったぶんだけ基準を指へ寄せる (端数は次のイベントへ持ち越す)
      drag.x -= n.dx * SCROLL_PX_PER_NOTCH;
      drag.y += n.dy * SCROLL_PX_PER_NOTCH;
    });
    for (const ev of ["pointerup", "pointercancel", "lostpointercapture"]) {
      pad.addEventListener(ev, () => {
        // なぞらずに離した = ホイールを押した。中クリックのためだけの
        // ボタンを並べずに済む (使う頻度のわりに場所を取る)。
        if (drag && !drag.moved && ev === "pointerup") this.fire(MOUSE_KEYS.middle);
        drag = null;
        pad.classList.remove("rubbing");
      });
    }
  }

  private fire(k: MouseKey): void {
    if (!k.click) return;
    // つまんだまま別のボタンを押されると、押しっぱなしの左ボタンと混ざって
    // 何が起きたのか追えなくなる。先に離してから押す。
    this.releaseHold();
    for (let i = 0; i < (k.click.times ?? 1); i++) {
      this.send({ t: "dn", b: k.click.b });
      this.send({ t: "up", b: k.click.b });
    }
  }

  // 左ボタンを押したままにする / 離す。掴んだあとは映像をなぞって運ぶ。
  private toggleHold(): void {
    if (this.holding) {
      this.releaseHold();
      return;
    }
    this.holding = true;
    this.send({ t: "dn", b: 0 });
    this.setHoldLabel();
    navigator.vibrate?.(20);
  }

  // 掴んだままにして良い場面は無いので、閉じるときも片付けるときもここを通す。
  // 残すとPC側は左ボタンを押しっぱなしのままになり、以後の操作が全部
  // ドラッグとして解釈されてしまう (画面を見ても原因が分からない)。
  private releaseHold(): void {
    if (!this.holding) return;
    this.holding = false;
    this.send({ t: "up", b: 0 });
    this.setHoldLabel();
  }

  private setHoldLabel(): void {
    if (!this.holdKey) return;
    this.holdKey.textContent = this.holding ? HOLD_LABEL.on : HOLD_LABEL.off;
    this.holdKey.classList.toggle("active", this.holding);
  }

  // 押しっぱなしで喋るキー。押下の扱いを持たないので、VoiceInput に繋いでもらう。
  micButton(): HTMLButtonElement | null {
    return this.mic;
  }

  get open(): boolean {
    return !this.root.classList.contains("hidden");
  }

  // 掴んだままにしない。タブを閉じられるときなど、パネルはそのままで
  // 押しっぱなしだけを解きたい場面のために外へ出してある。
  release(): void {
    this.releaseHold();
  }

  close(): void {
    if (this.open) this.toggle();
  }

  toggle(): void {
    const hidden = this.root.classList.toggle("hidden");
    if (hidden) {
      this.releaseHold();
    }
    this.onOpenChange(!hidden);
  }

  // 再接続のたびに作り直されるので、古い方のDOMとタイマーは片付ける。
  dispose(): void {
    this.releaseHold();
    this.observer.disconnect();
    this.root.remove();
    this.onLayout(0); // 詰めていたぶんを戻す
    this.onOpenChange(false);
  }
}

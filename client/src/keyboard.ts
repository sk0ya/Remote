// 画面内キーボード: 文字入力欄もOSのキーボードも使わず、押したキーをそのまま
// PCへ送る。
//
// レイアウトの考え方:
//   - 文字(ABC)と数字・記号(123)を面で分ける。1画面に詰め込まないぶん1キーを
//     太くでき、段数が減って映像に残る高さも増える。
//   - 修飾キー・矢印・Esc/Del/Home/End は「操作段」に置く。面を切り替えても
//     位置が動かないので、Ctrl+C も候補の選択も面の往復なしで打てる。
//   - 幅は段ごとの比 (w) をデータに持たせ、CSSのnth-childでは当てない。
//     キーを足し引きしても他の段が崩れない。

type Send = (msg: object) => void;

export interface Key {
  label: string;
  code: string;
  mod?: boolean; // 押しっぱなしになる修飾キー (次の1打で外れる)
  repeat?: boolean; // 押しっぱなしで連射する
  w?: number; // 段の中での幅の比 (既定1)
  layer?: boolean; // 面の切り替え。PCへは何も送らない
  mic?: boolean; // 押しっぱなしで喋る。押下の扱いは VoiceInput に任せる
}

const letters = (s: string): Key[] =>
  [...s].map((c) => ({ label: c, code: `Key${c.toUpperCase()}` }));

// Enterは文字面・数字面のどちらでも2段目の右端。面を切り替えても指の行き先が
// 変わらない。幅は少しだけ広げる — これ以上取ると同じ段の文字キーが細くなる。
const ENTER: Key = { label: "⏎", code: "Enter", w: 1.4 };

// 文字面。段ごとの合計幅がわずかに違うので、実機と同じように段がずれて見える。
export const ABC_ROWS: Key[][] = [
  letters("qwertyuiop"), // 10
  [...letters("asdfghjkl"), ENTER], // 10.4
  [
    ...letters("zxcvbnm"),
    { label: ",", code: "Comma" },
    { label: ".", code: "Period" },
    { label: "/", code: "Slash" },
  ], // 10
];

// 数字・記号面。記号はJISとUSで位置が変わるものがあるが、ここで送るのは
// スキャンコードなので、PC側の配列どおりの文字が入る (ラベルはUS表記)。
export const NUM_ROWS: Key[][] = [
  [..."1234567890"].map((c) => ({ label: c, code: `Digit${c}` })), // 10
  [
    { label: "`", code: "Backquote" },
    { label: "-", code: "Minus" },
    { label: "=", code: "Equal" },
    { label: "[", code: "BracketLeft" },
    { label: "]", code: "BracketRight" },
    { label: "\\", code: "Backslash" },
    { label: ";", code: "Semicolon" },
    { label: "'", code: "Quote" },
    ENTER,
  ], // 9.4
  Array.from({ length: 12 }, (_, i) => ({ label: `F${i + 1}`, code: `F${i + 1}` })), // 12
];

// 押しっぱなしで喋るキー。キーボードを出しているあいだは映像の上の🎤ボタンを
// 引っ込めるので(狭くなった映像を隠すため)、こちらが代わりを務める。
// 対応していないブラウザでは段から取り除く。display:noneで隠すと、段の幅の比は
// キーの数ぶん組んであるので最後に空きマスが残ってしまう。
export const MIC_KEY: Key = { label: "🎤", code: "", mic: true, w: 1.3 };

// 操作段。どちらの面でも同じものが同じ位置に出る。
// 矢印は候補選択とスクロールで一番使うので、この段でいちばん幅を取る。
export const OP_ROWS: Key[][] = [
  [
    MIC_KEY,
    { label: "Esc", code: "Escape" },
    { label: "Tab", code: "Tab" },
    { label: "Win", code: "MetaLeft", mod: true },
    { label: "Home", code: "Home" },
    { label: "End", code: "End" },
    { label: "PgUp", code: "PageUp", repeat: true },
    { label: "PgDn", code: "PageDown", repeat: true },
    { label: "Del", code: "Delete", repeat: true },
    { label: "⌫", code: "Backspace", repeat: true, w: 1.5 },
  ], // 10.8 (🎤なしなら9.5)
  [
    { label: "123", code: "", layer: true },
    { label: "⇧", code: "ShiftLeft", mod: true },
    { label: "Ctrl", code: "ControlLeft", mod: true },
    { label: "Alt", code: "AltLeft", mod: true },
    { label: "␣", code: "Space", repeat: true, w: 1.8 },
    { label: "←", code: "ArrowLeft", repeat: true, w: 1.15 },
    { label: "↓", code: "ArrowDown", repeat: true, w: 1.15 },
    { label: "↑", code: "ArrowUp", repeat: true, w: 1.15 },
    { label: "→", code: "ArrowRight", repeat: true, w: 1.15 },
  ], // 10.4
];

// 押しっぱなしにできるキーは操作段の定義から拾う (二重管理にしない)
export const MODIFIERS: string[] = OP_ROWS.flat()
  .filter((k) => k.mod)
  .map((k) => k.code);

// 段の合計幅。横並びにしたときに、段をまたいでキーの幅を揃えるのに使う。
export const rowUnits = (keys: Key[]): number => keys.reduce((n, k) => n + (k.w ?? 1), 0);

const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 60;

type Layer = "abc" | "num";

export class VirtualKeyboard {
  private root: HTMLElement;
  private boards: Record<Layer, HTMLElement>;
  private layer: Layer = "abc";
  private layerButton: HTMLButtonElement | null = null;
  // 押しっぱなしで喋るキー。押下の扱いは持たず、VoiceInput に渡して使ってもらう。
  private mic: HTMLButtonElement | null = null;
  private letterButtons: HTMLButtonElement[] = [];
  private sticky = new Set<string>();
  private stickyButtons = new Map<string, HTMLButtonElement>();
  // 連射のタイマーはキーごとに持つ。1組を使い回すと、↓を押しながら別の指で
  // ⌫を叩いたときに、離していない↓の連射まで止まってしまう。
  private repeats = new Map<HTMLButtonElement, { delay: number; interval: number }>();
  private observer: ResizeObserver;

  constructor(
    container: HTMLElement,
    private send: Send,
    // パネルの高さが変わったことの通知 (映像の表示領域をそのぶん詰めてもらう)。
    // 開閉だけでなく、画面の回転でも高さは変わる。
    private onLayout: (height: number) => void = () => {},
    // 音声入力に対応しているか。対応していなければ🎤キーを置かない。
    withMic = false
  ) {
    this.root = document.createElement("div");
    this.root.className = "kbd hidden";

    this.boards = {
      abc: this.makeBoard(ABC_ROWS),
      num: this.makeBoard(NUM_ROWS),
    };
    this.root.appendChild(this.boards.abc);
    this.root.appendChild(this.boards.num);

    // 操作段は面の外に置く。切り替えで作り直さないので位置も状態も動かない。
    const ops = document.createElement("div");
    ops.className = "kbd-ops";
    for (const keys of OP_ROWS) {
      const shown = withMic ? keys : keys.filter((k) => !k.mic);
      const row = this.makeRow(shown);
      // 横持ちでは操作段を横に並べる。合計幅の比で分けると、段をまたいでも
      // キーの幅が揃う (CSSだけでは段の中身の量が分からない)。
      row.style.flexGrow = String(rowUnits(shown));
      ops.appendChild(row);
    }
    this.root.appendChild(ops);

    container.appendChild(this.root);
    this.setLayer("abc");

    // 高さは自前の開閉だけでなく回転や折り返しでも変わるので、実測を購読する。
    // (隠すと display:none で 0 になり、そのまま「パネルなし」として伝わる)
    this.observer = new ResizeObserver(() => this.onLayout(this.root.offsetHeight));
    this.observer.observe(this.root);
  }

  private makeBoard(rows: Key[][]): HTMLElement {
    const board = document.createElement("div");
    board.className = "kbd-layer";
    for (const keys of rows) board.appendChild(this.makeRow(keys));
    return board;
  }

  private makeRow(keys: Key[]): HTMLElement {
    const row = document.createElement("div");
    row.className = "kbd-row";
    row.style.gridTemplateColumns = keys.map((k) => `${k.w ?? 1}fr`).join(" ");
    for (const k of keys) row.appendChild(this.makeKey(k));
    return row;
  }

  private makeKey(k: Key): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "kbd-key";
    // 「PgUp」のような長いラベルは幅に入りきらない。文字を落として省略させない。
    // 絵文字は1文字でもUTF-16では2つぶんなので、文字数はコードポイントで数える。
    const len = [...k.label].length;
    if (len >= 3) btn.classList.add("len3");
    else if (len === 2) btn.classList.add("len2");
    if (k.layer) {
      btn.classList.add("kbd-layer-key");
      this.layerButton = btn;
    }
    btn.textContent = k.label;

    // 🎤は押しっぱなしで喋るキーで、押下・離しの扱いは VoiceInput が持つ。
    // ここでハンドラを付けると二重に反応するので、ボタンを渡すだけにする。
    if (k.mic) {
      btn.classList.add("kbd-mic");
      this.mic = btn;
      return btn;
    }

    btn.addEventListener("pointerdown", (e) => {
      e.preventDefault(); // フォーカスを奪わない
      if (k.layer) this.setLayer(this.layer === "abc" ? "num" : "abc");
      else if (k.mod) this.toggleModifier(k.code, btn);
      else this.pressKey(k, btn);
    });
    if (k.repeat) {
      for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
        btn.addEventListener(ev, () => this.stopRepeat(btn));
      }
    }
    if (k.mod) this.stickyButtons.set(k.code, btn);
    if (/^Key[A-Z]$/.test(k.code)) this.letterButtons.push(btn);
    return btn;
  }

  // 面の切り替えでは修飾キーを外さない。Ctrl を押してから F5 を出す、が通る。
  private setLayer(layer: Layer): void {
    this.layer = layer;
    this.boards.abc.hidden = layer !== "abc";
    this.boards.num.hidden = layer !== "num";
    if (this.layerButton) this.layerButton.textContent = layer === "abc" ? "123" : "ABC";
  }

  private pressKey(k: Key, btn: HTMLButtonElement): void {
    this.tapKey(k.code);
    if (!k.repeat) return;
    this.stopRepeat(btn); // 同じキーの押し直し
    const t = { delay: 0, interval: 0 };
    t.delay = window.setTimeout(() => {
      t.interval = window.setInterval(() => this.tapKey(k.code), REPEAT_INTERVAL_MS);
    }, REPEAT_DELAY_MS);
    this.repeats.set(btn, t);
  }

  // btnを渡すとそのキーだけ、省くと全部止める(閉じるとき・片付けるとき)。
  private stopRepeat(btn?: HTMLButtonElement): void {
    const clear = (t: { delay: number; interval: number }): void => {
      clearTimeout(t.delay);
      clearInterval(t.interval);
    };
    if (btn) {
      const t = this.repeats.get(btn);
      if (t) {
        clear(t);
        this.repeats.delete(btn);
      }
      return;
    }
    for (const t of this.repeats.values()) clear(t);
    this.repeats.clear();
  }

  private tapKey(code: string): void {
    this.send({ t: "key", code, down: true });
    this.send({ t: "key", code, down: false });
    this.releaseSticky();
  }

  private toggleModifier(code: string, btn: HTMLButtonElement): void {
    if (this.sticky.has(code)) {
      this.sticky.delete(code);
      this.send({ t: "key", code, down: false });
      btn.classList.remove("active");
    } else {
      this.sticky.add(code);
      this.send({ t: "key", code, down: true });
      btn.classList.add("active");
    }
    this.applyShiftLabels();
  }

  // 修飾キー押下中に通常キーを送ったら修飾を解除する
  private releaseSticky(): void {
    for (const code of MODIFIERS) {
      if (this.sticky.has(code)) {
        this.sticky.delete(code);
        this.send({ t: "key", code, down: false });
        this.stickyButtons.get(code)?.classList.remove("active");
      }
    }
    this.applyShiftLabels();
  }

  // Shiftが効いているかは、押した結果が出るPC側の画面を見るまで分からない。
  // 手元のラベルを大文字に変えて、送る前に分かるようにする。
  private applyShiftLabels(): void {
    const upper = this.sticky.has("ShiftLeft");
    for (const btn of this.letterButtons) {
      const label = btn.textContent ?? "";
      btn.textContent = upper ? label.toUpperCase() : label.toLowerCase();
    }
  }

  // 押しっぱなしで喋るキー。押下の扱いを持たないので、VoiceInput に繋いでもらう。
  micButton(): HTMLButtonElement | null {
    return this.mic;
  }

  toggle(): void {
    const hidden = this.root.classList.toggle("hidden");
    if (hidden) {
      this.releaseSticky();
      this.stopRepeat();
      this.setLayer("abc"); // 次に開いたときは文字面から
    }
  }

  // 再接続のたびに作り直されるので、古い方のDOMとタイマーは片付ける。
  dispose(): void {
    this.stopRepeat();
    this.observer.disconnect();
    this.root.remove();
    this.onLayout(0); // 詰めていたぶんを戻す
  }
}

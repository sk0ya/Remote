// 仮想キーボード: 非表示inputでスマホの入力を受けてホストへ送り、
// 特殊キーバーで修飾キー・編集キー・IMEキーを送る。
//
// 変換をどちらでやるかを2モードで切り替える:
//   スマホ変換 … スマホのIMEで確定した文字列を txt (Unicode直接入力) で送る。
//                打鍵がPCに届かないので、PCの予測変換・学習・単語登録は効かない。
//   PC変換     … 打鍵をスキャンコードのまま送り、PC側のIMEに変換させる。
//                候補ウィンドウはPCの画面に出るので、映像を見ながら変換できる。
//                スマホ側のIMEは邪魔になるので inputmode でASCII配列にする。

import { loadPcIme, savePcIme } from "./config";

type Send = (msg: object) => void;

const MODIFIERS = ["ControlLeft", "AltLeft", "ShiftLeft", "MetaLeft"] as const;

export interface Stroke {
  code: string;
  shift: boolean;
}

// 記号はキーボード配列で位置が変わる。ここに置くのはJISでもUSでも同じ位置の
// ものだけで、@ や " のようにずれるものは打鍵にせずUnicode入力に逃がす。
const PUNCT: Record<string, string> = {
  " ": "Space",
  "-": "Minus",
  ",": "Comma",
  ".": "Period",
  "/": "Slash",
  ";": "Semicolon",
};

// 1文字を打鍵に落とす。打鍵で表せない文字はnull。
export function charStroke(ch: string): Stroke | null {
  if (ch >= "a" && ch <= "z") return { code: `Key${ch.toUpperCase()}`, shift: false };
  if (ch >= "A" && ch <= "Z") return { code: `Key${ch}`, shift: true };
  if (ch >= "0" && ch <= "9") return { code: `Digit${ch}`, shift: false };
  const code = PUNCT[ch];
  return code ? { code, shift: false } : null;
}

function tap(code: string): object[] {
  return [
    { t: "key", code, down: true },
    { t: "key", code, down: false },
  ];
}

// 文字列をPCへの打鍵メッセージ列にする。
// 打鍵にできない文字(かな・絵文字・配列依存の記号)は続くぶんをまとめて txt で送る。
export function textMessages(s: string): object[] {
  const out: object[] = [];
  let raw = "";
  const flushRaw = (): void => {
    if (raw) {
      out.push({ t: "txt", s: raw });
      raw = "";
    }
  };
  for (const ch of s) {
    const st = charStroke(ch);
    if (!st) {
      raw += ch;
      continue;
    }
    flushRaw();
    if (st.shift) {
      out.push(
        { t: "key", code: "ShiftLeft", down: true },
        ...tap(st.code),
        { t: "key", code: "ShiftLeft", down: false }
      );
    } else {
      out.push(...tap(st.code));
    }
  }
  flushRaw();
  return out;
}

// 打ち間違いの取り消しで大量のBackspaceが飛ばないよう上限を設ける。
// (入力欄を全選択して消した、といった操作でPC側の別の文字まで消さないため)
const MAX_BACKSPACE = 32;

// 入力欄の変化をPCへの打鍵に直す。共通の先頭はそのまま、消えたぶんはBackspaceにする。
// 途中にカーソルを戻して編集した場合は先頭一致がそこで切れるので、
// 「そこから後ろを打ち直す」ぶんの打鍵になる。PC側の見た目とは合う。
export function editMessages(prev: string, next: string): object[] {
  let i = 0;
  while (i < prev.length && i < next.length && prev[i] === next[i]) i++;
  const back = Math.min(prev.length - i, MAX_BACKSPACE);
  const out: object[] = [];
  for (let n = 0; n < back; n++) out.push(...tap("Backspace"));
  return out.concat(textMessages(next.slice(i)));
}

interface BarKey {
  label: string;
  code: string;
  mod?: boolean;
  repeat?: boolean; // 押しっぱなしで連射する
}

// 特殊キー。修飾キー・編集キー・IMEキー・方向キーの順。
//
// 以前は2段に分けていたが、段はそれぞれ独立に折り返すので、横持ちでも必ず
// 2段ぶんの高さを取っていた。ソフトキーボードを出したときに映像へ残る高さは
// わずかしかないので、1本の列にして端末の幅なりに折り返させる
// (横持ちなら1段に収まり、そのぶん映像が見える)。
// PC変換では 空白=変換、方向キー=候補・文節の選択に使う。
const KEYS: BarKey[] = [
  { label: "Esc", code: "Escape" },
  { label: "Tab", code: "Tab" },
  { label: "Ctrl", code: "ControlLeft", mod: true },
  { label: "Alt", code: "AltLeft", mod: true },
  { label: "Shift", code: "ShiftLeft", mod: true },
  { label: "Win", code: "MetaLeft", mod: true },
  { label: "⌫", code: "Backspace", repeat: true },
  { label: "Del", code: "Delete", repeat: true },
  { label: "⏎", code: "Enter" },
  { label: "半/全", code: "Backquote" },
  { label: "無変換", code: "NonConvert" },
  { label: "変換", code: "Convert" },
  { label: "␣", code: "Space", repeat: true },
  { label: "←", code: "ArrowLeft", repeat: true },
  { label: "↑", code: "ArrowUp", repeat: true },
  { label: "↓", code: "ArrowDown", repeat: true },
  { label: "→", code: "ArrowRight", repeat: true },
];

const REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 60;

export class VirtualKeyboard {
  private root: HTMLElement;
  private field: HTMLInputElement;
  private modeBtn: HTMLButtonElement;
  private sticky = new Set<string>();
  private stickyButtons = new Map<string, HTMLButtonElement>();
  private pcIme = loadPcIme();
  // PC変換のとき、入力欄の直前の内容。ここからの差分を打鍵にする。
  private echo = "";
  private repeatDelay = 0;
  private repeatTimer = 0;
  private observer: ResizeObserver;

  constructor(
    container: HTMLElement,
    private send: Send,
    // バーの高さが変わったことの通知 (映像の表示領域をそのぶん詰めてもらう)。
    // 開閉だけでなく、折り返しの増減や画面の回転でも高さは変わる。
    private onLayout: (height: number) => void = () => {}
  ) {
    this.root = document.createElement("div");
    this.root.className = "kbd hidden";
    this.root.appendChild(this.makeBar(KEYS));

    const row = document.createElement("div");
    row.className = "kbd-row";

    this.modeBtn = document.createElement("button");
    this.modeBtn.className = "kbd-mode";
    this.modeBtn.addEventListener("pointerdown", (e) => {
      e.preventDefault(); // フォーカスを奪わない
      this.setPcIme(!this.pcIme);
    });
    row.appendChild(this.modeBtn);

    this.field = document.createElement("input");
    this.field.className = "kbd-field";
    this.field.type = "text";
    this.field.autocomplete = "off";
    this.field.autocapitalize = "off";
    (this.field as HTMLInputElement & { spellcheck: boolean }).spellcheck = false;

    // IME確定文字・直接入力をまとめて送る
    this.field.addEventListener("input", (e) => {
      if ((e as InputEvent).isComposing) return; // スマホIMEの変換中は確定まで待つ
      this.flushField();
    });
    this.field.addEventListener("compositionend", () => this.flushField());
    this.field.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      // 入力欄が空だと消す文字がなくinputイベントが来ないので、ここで拾う
      if (e.key === "Backspace" && this.field.value === "") {
        this.tapKey("Backspace");
      } else if (e.key === "Enter") {
        e.preventDefault();
        this.flushField();
        this.tapKey("Enter");
      }
    });
    row.appendChild(this.field);
    this.root.appendChild(row);
    container.appendChild(this.root);

    // 高さは自前の開閉だけでなく折り返しの増減でも変わるので、実測を購読する。
    // (隠すと display:none で 0 になり、そのまま「バーなし」として伝わる)
    this.observer = new ResizeObserver(() => this.onLayout(this.root.offsetHeight));
    this.observer.observe(this.root);

    this.applyMode();
  }

  private makeBar(keys: BarKey[]): HTMLElement {
    const bar = document.createElement("div");
    bar.className = "kbd-bar";
    for (const k of keys) {
      const btn = document.createElement("button");
      btn.textContent = k.label;
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault(); // フォーカスを奪わない
        if (k.mod) {
          this.toggleModifier(k.code, btn);
        } else {
          this.pressKey(k);
        }
      });
      if (k.repeat) {
        for (const ev of ["pointerup", "pointercancel", "pointerleave"]) {
          btn.addEventListener(ev, () => this.stopRepeat());
        }
      }
      if (k.mod) this.stickyButtons.set(k.code, btn);
      bar.appendChild(btn);
    }
    return bar;
  }

  private pressKey(k: BarKey): void {
    this.tapKey(k.code);
    if (!k.repeat) return;
    this.stopRepeat();
    this.repeatDelay = window.setTimeout(() => {
      this.repeatTimer = window.setInterval(() => this.tapKey(k.code), REPEAT_INTERVAL_MS);
    }, REPEAT_DELAY_MS);
  }

  private stopRepeat(): void {
    clearTimeout(this.repeatDelay);
    clearInterval(this.repeatTimer);
    this.repeatDelay = 0;
    this.repeatTimer = 0;
  }

  private flushField(): void {
    if (this.pcIme) {
      const text = this.field.value;
      for (const msg of editMessages(this.echo, text)) this.send(msg);
      this.echo = text;
      this.releaseSticky();
      return;
    }
    const text = this.field.value;
    if (text) {
      this.send({ t: "txt", s: text });
      this.field.value = "";
    }
    this.releaseSticky();
  }

  private tapKey(code: string): void {
    this.flushField(); // 未送信の文字を追い越さない
    this.send({ t: "key", code, down: true });
    this.send({ t: "key", code, down: false });
    this.releaseSticky();
    // 変換・確定・カーソル移動のあとはPC側の状態が入力欄と食い違う。
    // 差分の基準を捨てて、ここから打ち直しとして扱う。
    this.clearEcho();
  }

  private clearEcho(): void {
    this.field.value = "";
    this.echo = "";
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
  }

  // 修飾キー押下中に通常キー/テキストを送ったら修飾を解除する
  private releaseSticky(): void {
    for (const code of MODIFIERS) {
      if (this.sticky.has(code)) {
        this.sticky.delete(code);
        this.send({ t: "key", code, down: false });
        this.stickyButtons.get(code)?.classList.remove("active");
      }
    }
  }

  private setPcIme(on: boolean): void {
    this.pcIme = on;
    savePcIme(on);
    this.applyMode();
    // inputmodeの変更はフォーカスし直さないとソフトキーボードに反映されない
    if (document.activeElement === this.field) {
      this.field.blur();
      this.field.focus();
    }
  }

  private applyMode(): void {
    this.clearEcho();
    this.modeBtn.textContent = this.pcIme ? "PC変換" : "スマホ変換";
    this.modeBtn.classList.toggle("active", this.pcIme);
    // email指定でスマホ側は日本語変換のないASCII配列になり、ローマ字がそのままPCへ届く。
    // url にすると iOS ではスペースキーが "." と "/" に置き換わり、変換キーが押せなくなる。
    this.field.inputMode = this.pcIme ? "email" : "text";
    // 説明文はモードボタンと重複するうえ、ソフトキーボードで残った僅かな高さを
    // 説明のために使うことになる。何を打つ欄かだけ短く出す。
    this.field.placeholder = this.pcIme ? "ローマ字" : "入力";
  }

  toggle(): void {
    const hidden = this.root.classList.toggle("hidden");
    if (!hidden) {
      this.field.focus();
    } else {
      this.field.blur();
      this.releaseSticky();
      this.clearEcho();
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

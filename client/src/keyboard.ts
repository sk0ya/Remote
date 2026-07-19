// 仮想キーボード: 非表示inputでスマホのIME入力を受けてテキスト送信し、
// 特殊キーバーで修飾キー・編集キーを送る。

type Send = (msg: object) => void;

const MODIFIERS = ["ControlLeft", "AltLeft", "ShiftLeft", "MetaLeft"] as const;

const BAR_KEYS: Array<{ label: string; code: string; mod?: boolean }> = [
  { label: "Esc", code: "Escape" },
  { label: "Tab", code: "Tab" },
  { label: "Ctrl", code: "ControlLeft", mod: true },
  { label: "Alt", code: "AltLeft", mod: true },
  { label: "Shift", code: "ShiftLeft", mod: true },
  { label: "Win", code: "MetaLeft", mod: true },
  { label: "↑", code: "ArrowUp" },
  { label: "↓", code: "ArrowDown" },
  { label: "←", code: "ArrowLeft" },
  { label: "→", code: "ArrowRight" },
  { label: "Del", code: "Delete" },
  { label: "⏎", code: "Enter" },
];

export class VirtualKeyboard {
  private root: HTMLElement;
  private field: HTMLInputElement;
  private sticky = new Set<string>();
  private stickyButtons = new Map<string, HTMLButtonElement>();

  constructor(
    container: HTMLElement,
    private send: Send
  ) {
    this.root = document.createElement("div");
    this.root.className = "kbd hidden";

    const bar = document.createElement("div");
    bar.className = "kbd-bar";
    for (const k of BAR_KEYS) {
      const btn = document.createElement("button");
      btn.textContent = k.label;
      btn.addEventListener("pointerdown", (e) => {
        e.preventDefault(); // フォーカスを奪わない
        if (k.mod) {
          this.toggleModifier(k.code, btn);
        } else {
          this.tapKey(k.code);
        }
      });
      if (k.mod) this.stickyButtons.set(k.code, btn);
      bar.appendChild(btn);
    }
    this.root.appendChild(bar);

    this.field = document.createElement("input");
    this.field.className = "kbd-field";
    this.field.type = "text";
    this.field.placeholder = "ここに入力するとPCへ送信";
    this.field.autocomplete = "off";
    this.field.autocapitalize = "off";
    (this.field as HTMLInputElement & { spellcheck: boolean }).spellcheck = false;

    // IME確定文字・直接入力をまとめて送る
    this.field.addEventListener("input", (e) => {
      if ((e as InputEvent).isComposing) return; // IME変換中は確定まで待つ
      this.flushField();
    });
    this.field.addEventListener("compositionend", () => this.flushField());
    this.field.addEventListener("keydown", (e) => {
      if (e.isComposing) return;
      if (e.key === "Backspace" && this.field.value === "") {
        this.tapKey("Backspace");
      } else if (e.key === "Enter") {
        e.preventDefault();
        this.flushField();
        this.tapKey("Enter");
      }
    });
    this.root.appendChild(this.field);
    container.appendChild(this.root);
  }

  private flushField(): void {
    const text = this.field.value;
    if (text) {
      this.send({ t: "txt", s: text });
      this.field.value = "";
    }
    this.releaseSticky();
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

  toggle(): void {
    const hidden = this.root.classList.toggle("hidden");
    if (!hidden) {
      this.field.focus();
    } else {
      this.field.blur();
      this.releaseSticky();
    }
  }
}

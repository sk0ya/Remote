// スマホ標準キーボードから確定した文字列をホストへ送る。
//
// 画面内キーボードはキーコードをそのまま送るため、日本語変換や絵文字の
// 入力には向かない。こちらは入力欄を使って端末のIMEに任せ、送信時に
// Unicode文字列としてホストへ渡す。

type Send = (msg: object) => void;

export class TextInput {
  private open = false;
  private disposed = false;

  constructor(
    private toggleButton: HTMLButtonElement,
    private form: HTMLFormElement,
    private input: HTMLInputElement,
    private closeButton: HTMLButtonElement,
    private send: Send,
    private onOpen: () => void = () => {}
  ) {
    toggleButton.onclick = this.toggle;
    form.onsubmit = this.submit;
    closeButton.onclick = this.close;
  }

  private toggle = (): void => {
    if (this.open) this.close();
    else this.show();
  };

  private show(): void {
    if (this.disposed) return;
    this.onOpen();
    this.open = true;
    this.form.hidden = false;
    this.toggleButton.classList.add("active");
    // ボタンのクリック処理の中でfocusするので、iOSでも標準キーボードが開く。
    this.input.focus({ preventScroll: true });
  }

  private submit = (e: SubmitEvent): void => {
    e.preventDefault();
    if (this.disposed) return;
    // 空文字は送らないが、スペースだけの入力は意図した入力なのでそのまま送る。
    if (this.input.value.length === 0) return;
    this.send({ t: "txt", s: this.input.value });
    this.input.value = "";
    // 連続して入力できるよう、送信後も入力欄は閉じない。
    this.input.focus({ preventScroll: true });
  };

  close = (): void => {
    if (!this.open) return;
    this.open = false;
    this.form.hidden = true;
    this.toggleButton.classList.remove("active");
    this.input.blur();
  };

  dispose(): void {
    this.disposed = true;
    this.toggleButton.onclick = null;
    this.form.onsubmit = null;
    this.closeButton.onclick = null;
    this.close();
  }
}

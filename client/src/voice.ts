// 音声入力: 🎤を押している間だけマイクを録音し、離したら音声データをホストへ送る。
// 認識はホスト側 (sherpa-onnx + ReazonSpeech) が行い、結果は {t:"voice"} で返ってくる。
//
// ブラウザの音声認識API (webkitSpeechRecognition) は使わない。あれはSafari/Chrome以外では
// 動かない(Vivaldi等のChromium派生はGoogleのAPIキーを持たない、iOSのサードパーティ
// ブラウザには公開されない)ため、録音だけブラウザにやらせてPCで認識する。

// DataChannelの1メッセージあたりの分割サイズ。実装依存の上限(256KB前後)に対し十分小さく取る。
const CHUNK = 16 * 1024;
// 送信キューがこれを超えたら少し待つ (詰め込みすぎでDataChannelを閉じさせないため)
const BUFFER_LIMIT = 512 * 1024;
// 誤タップと区別する最短の録音時間
const MIN_MS = 250;
// 最後に使ってからこの時間が経ったらマイクを解放する (録音インジケータを消すため)
const IDLE_RELEASE_MS = 60_000;

export function voiceSupported(): boolean {
  return typeof MediaRecorder !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
}

// ブラウザによって録れるコンテナが違う (Chrome系:webm/opus, iOS Safari:mp4)。
// どれで録れてもホスト側はffmpegに判定させるので、対応しているものを選べばよい。
function pickMimeType(): string | undefined {
  for (const t of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(t)) return t;
  }
  return undefined; // ブラウザ既定に任せる
}

type Send = (msg: object) => void;
type SendBinary = (data: ArrayBuffer) => void;
type Status = (text: string, error?: boolean) => void;

export class VoiceInput {
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private chunks: BlobPart[] = [];
  private pressed = false;
  private startedAt = 0;
  private idleTimer = 0;

  constructor(
    private btn: HTMLButtonElement,
    private send: Send,
    private sendBinary: SendBinary,
    private buffered: () => number,
    private onStatus: Status
  ) {
    // 再接続で作り直されるため、addEventListenerではなくプロパティ代入で重複登録を防ぐ
    btn.onpointerdown = (e) => {
      e.preventDefault(); // 長押しの選択・スクロールを抑止
      btn.setPointerCapture(e.pointerId); // 指がボタン外へずれてもpointerupを受け取る
      void this.press();
    };
    btn.onpointerup = () => this.release();
    btn.onpointercancel = () => this.release(true);
  }

  private async press(): Promise<void> {
    if (this.pressed) return;
    this.pressed = true;
    this.btn.classList.add("active");
    clearTimeout(this.idleTimer);

    try {
      await this.ensureStream();
    } catch (e) {
      this.pressed = false;
      this.btn.classList.remove("active");
      this.onStatus(micError(e), true);
      return;
    }
    // マイク取得を待つ間に指が離れていたら録音しない
    if (!this.pressed || !this.stream) return;

    this.chunks = [];
    const mimeType = pickMimeType();
    const rec = new MediaRecorder(this.stream, mimeType ? { mimeType } : undefined);
    rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    rec.onstop = () => {
      const blob = new Blob(this.chunks, { type: rec.mimeType });
      this.chunks = [];
      void this.upload(blob);
    };
    rec.start();
    this.rec = rec;
    this.startedAt = Date.now();
    this.onStatus("🎤 録音中…");
  }

  private release(cancel = false): void {
    if (!this.pressed) return;
    this.pressed = false;
    this.btn.classList.remove("active");
    this.idleTimer = window.setTimeout(() => this.releaseMic(), IDLE_RELEASE_MS);

    const rec = this.rec;
    this.rec = null;
    if (!rec || rec.state === "inactive") {
      this.onStatus("");
      return;
    }
    if (cancel || Date.now() - this.startedAt < MIN_MS) {
      // 短すぎる/中断: 録音は止めるが送らない
      rec.onstop = null;
      rec.stop();
      this.chunks = [];
      this.onStatus("");
      return;
    }
    rec.stop(); // onstop で送信へ
    this.onStatus("認識中…");
  }

  private async ensureStream(): Promise<void> {
    if (this.stream?.active) return;
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  }

  // 音声を「開始通知 + 分割バイナリ」でホストへ送る。
  private async upload(blob: Blob): Promise<void> {
    const buf = await blob.arrayBuffer();
    if (buf.byteLength === 0) {
      this.onStatus("");
      return;
    }
    this.send({ t: "aud", len: buf.byteLength, mime: blob.type });
    for (let off = 0; off < buf.byteLength; off += CHUNK) {
      while (this.buffered() > BUFFER_LIMIT) {
        await new Promise((r) => setTimeout(r, 20));
      }
      this.sendBinary(buf.slice(off, Math.min(off + CHUNK, buf.byteLength)));
    }
    // この後はホストからの {t:"voice"} 通知が結果を表示する
  }

  private releaseMic(): void {
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  dispose(): void {
    this.btn.onpointerdown = null;
    this.btn.onpointerup = null;
    this.btn.onpointercancel = null;
    clearTimeout(this.idleTimer);
    if (this.rec && this.rec.state !== "inactive") {
      this.rec.onstop = null;
      this.rec.stop();
    }
    this.rec = null;
    this.pressed = false;
    this.releaseMic();
  }
}

function micError(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return "マイクの使用が許可されていません";
  }
  if (name === "NotFoundError") return "マイクが見つかりません";
  return `マイクを開けません: ${name || String(e)}`;
}

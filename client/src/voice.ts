// 音声入力: 🎤ボタンを押している間だけブラウザのWeb Speech APIで認識し、
// 確定テキストをホストへ送る ({t:"voice"})。
// コマンド照合はホスト側 (internal/voice) が持つので、こちらは認識に徹する。
//
// 押しっぱなし方式なのは、iOS Safariが無音タイムアウトで勝手に終了し
// 自動再startが不安定なため。押している間=1発話、離した時点で確定にすると挙動が読める。

interface SRAlternative {
  transcript: string;
}
interface SRResult {
  0: SRAlternative;
  isFinal: boolean;
}
interface SREvent {
  resultIndex: number;
  results: { length: number; [i: number]: SRResult };
}
interface SR {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((e: SREvent) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
}
type SRCtor = new () => SR;

function ctor(): SRCtor | null {
  const w = window as unknown as { SpeechRecognition?: SRCtor; webkitSpeechRecognition?: SRCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function voiceSupported(): boolean {
  return ctor() !== null;
}

const ERRORS: Record<string, string> = {
  "not-allowed": "マイクの使用が許可されていません",
  "service-not-allowed": "マイクの使用が許可されていません",
  network: "音声認識サーバーに接続できません",
  "audio-capture": "マイクが使えません",
};

export class VoiceInput {
  private rec: SR | null = null;
  private active = false;
  private finalText = "";

  constructor(
    private btn: HTMLButtonElement,
    private send: (msg: object) => void,
    private onStatus: (text: string, error?: boolean) => void
  ) {
    // 再接続で作り直されるため、addEventListenerではなくプロパティ代入で重複登録を防ぐ
    btn.onpointerdown = (e) => {
      e.preventDefault(); // 長押しの選択・スクロールを抑止
      btn.setPointerCapture(e.pointerId); // 指がボタン外へずれてもpointerupを受け取る
      this.start();
    };
    btn.onpointerup = () => this.stop();
    btn.onpointercancel = () => this.cancel();
  }

  private start(): void {
    if (this.active) return;
    const C = ctor();
    if (!C) return;
    const rec = new C();
    rec.lang = "ja-JP";
    rec.continuous = false;
    rec.interimResults = true;
    this.finalText = "";

    rec.onresult = (e) => {
      let interim = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) this.finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      this.onStatus(`🎤 ${this.finalText}${interim}`);
    };
    rec.onerror = (e) => {
      if (e.error === "no-speech" || e.error === "aborted") {
        this.finalText = "";
        this.onStatus("");
        return;
      }
      this.finalText = "";
      this.onStatus(ERRORS[e.error] ?? `音声認識エラー: ${e.error}`, true);
    };
    rec.onend = () => {
      this.active = false;
      this.rec = null;
      this.btn.classList.remove("active");
      this.flush();
    };

    try {
      rec.start();
    } catch {
      return; // 直前のセッションが終了しきっていない場合など
    }
    this.rec = rec;
    this.active = true;
    this.btn.classList.add("active");
    this.onStatus("🎤 …");
  }

  // 離した時点で確定。結果は onresult → onend の順に来るので flush は onend でやる
  private stop(): void {
    this.rec?.stop();
  }

  private cancel(): void {
    this.finalText = "";
    this.rec?.abort();
  }

  private flush(): void {
    const text = this.finalText.trim();
    this.finalText = "";
    if (!text) {
      this.onStatus("");
      return;
    }
    this.send({ t: "voice", s: text });
  }

  dispose(): void {
    this.btn.onpointerdown = null;
    this.btn.onpointerup = null;
    this.btn.onpointercancel = null;
    this.cancel();
  }
}

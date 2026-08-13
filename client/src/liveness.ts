// P2P経路が生きているかを、DataChannelの往復で確かめる。
//
// RTCPeerConnection の connectionState は信用できない。画面を消しているあいだに
// 経路が黙って死んでも、ブラウザがICEのconsent失効に気づくまで数十秒は
// "connected" のまま残る。そのあいだ再接続は始まらず、利用者は固まった映像を
// 見せられたまま待たされる。
//
// 映像フレームの到着では代用できない。ホストは画面が変化したときだけ
// フレームを送る (dup_frames=0) ので、静止した画面では何も届かないのが正常。
// 経路の生死とは無関係なので、こちらから聞いて返事を待つしかない。
export const PROBE_TIMEOUT_MS = 5_000;

export class PeerProbe {
  private timer = 0;

  constructor(
    private send: (msg: object) => void,
    private onDead: () => void,
    private timeoutMs = PROBE_TIMEOUT_MS
  ) {}

  // 生きているかを聞く。返事が無ければ onDead。
  // 既に聞いている最中なら二重には聞かない(答えは1つで足りる)。
  start(): void {
    if (this.timer) return;
    this.timer = window.setTimeout(() => {
      this.timer = 0;
      this.onDead();
    }, this.timeoutMs);
    this.send({ t: "ping" });
  }

  // ホストから何か届いた。pongに限らず、届いた時点で経路は生きている。
  noteAlive(): void {
    this.stop();
  }

  // 返事を待つのをやめる。非表示になったときや画面を畳むときに呼ぶ
  // (見ていない画面のために繋ぎ直しても、電池を使うだけで誰も見ない)。
  stop(): void {
    clearTimeout(this.timer);
    this.timer = 0;
  }
}

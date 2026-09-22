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
// 短い間隔で確認しつつ、通常の遅延と単発のパケット欠落を許容する。
export const PROBE_TIMEOUT_MS = 1_500;
export const PROBE_INTERVAL_MS = 500;
export const PROBE_MISSES_BEFORE_DEAD = 3;

export class PeerProbe {
  private timer = 0;
  private interval = 0;
  private missedProbes = 0;

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
      if (this.interval) {
        this.missedProbes++;
        if (this.missedProbes < PROBE_MISSES_BEFORE_DEAD) return;
      }
      this.stop();
      this.onDead();
    }, this.timeoutMs);
    this.send({ t: "ping" });
  }

  // 表示中の経路を継続的に監視する。start() は一度だけの確認としても
  // 使われるため、定期監視は別メソッドにして既存の呼び出しを壊さない。
  monitor(): void {
    if (this.interval) return;
    this.interval = window.setInterval(() => this.start(), PROBE_INTERVAL_MS);
    this.start();
  }

  // ホストから何か届いた。pongに限らず、届いた時点で経路は生きている。
  noteAlive(): void {
    clearTimeout(this.timer);
    this.timer = 0;
    this.missedProbes = 0;
  }

  // 返事を待つのをやめる。非表示になったときや画面を畳むときに呼ぶ
  // (見ていない画面のために繋ぎ直しても、電池を使うだけで誰も見ない)。
  stop(): void {
    clearTimeout(this.timer);
    this.timer = 0;
    clearInterval(this.interval);
    this.interval = 0;
    this.missedProbes = 0;
  }
}

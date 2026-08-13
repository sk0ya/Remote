// ICE候補は、相手が受け取れる状態になるまで手元に溜める。溜める理由は
// 送る側と受ける側で違うが、やることは同じ「ゲートが開くまで保持し、
// 開いたら集まった順に流す」なので1つにまとめてある。
//
// - 送る側: answerを送るまでに集まった候補を先に投げても、ホストはまだ
//   どの接続要求のものか結び付けられない (answer適用前のAddICECandidateは
//   受け付けられない)。
// - 受ける側: ホストはtrickleで候補を送ってくるので、offerの
//   setRemoteDescription が終わる前に届くことがある。remote description が
//   無いうちに addIceCandidate すると例外になる。
//
// どちらも固定時間で打ち切ってはいけない。モバイル回線でSTUNが遅いときに
// 候補0件のまま先へ進み、二度と繋がらなくなる。
export class CandidateGate {
  private queued: RTCIceCandidateInit[] = [];
  private opened = false;

  constructor(private flush: (candidate: RTCIceCandidateInit) => void) {}

  add(candidate: RTCIceCandidateInit): void {
    if (this.opened) this.flush(candidate);
    else this.queued.push(candidate);
  }

  open(): void {
    if (this.opened) return;
    this.opened = true;
    const queued = this.queued;
    this.queued = [];
    for (const candidate of queued) this.flush(candidate);
  }
}

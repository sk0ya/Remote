// answer適用前にAddICECandidateを送るとホスト側で受け付けられないため、
// それまでに集まった候補だけ保持し、answer送信直後に順序どおり流す。
export class IceCandidateRelay {
  private queued: RTCIceCandidateInit[] = [];
  private answerSent = false;

  constructor(private send: (candidate: RTCIceCandidateInit) => void) {}

  add(candidate: RTCIceCandidateInit): void {
    if (this.answerSent) this.send(candidate);
    else this.queued.push(candidate);
  }

  markAnswerSent(): void {
    if (this.answerSent) return;
    this.answerSent = true;
    const queued = this.queued;
    this.queued = [];
    for (const candidate of queued) this.send(candidate);
  }
}

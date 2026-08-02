// タッチ/マウス操作をホストへの入力メッセージに変換する。
//
// タッチ操作の割り当て:
//   1本指タップ       → 左クリック
//   1本指ドラッグ     → カーソル移動(ホバー)
//   長押し→ドラッグ   → 左ボタンドラッグ(ウィンドウ移動・範囲選択)
//   2本指タップ       → 右クリック
//   2本指スライド     → スクロール(ズーム中はパン)
//   ピンチ           → 表示ズーム
// マウス(開発用PC)はそのまま対応するボタン・ホイールを送る。

interface Pt {
  x: number;
  y: number;
}

// Outbox はホストへの操作メッセージをまとめて送る。
//
// 以前はpointermoveのたびに1個ずつDataChannelへ送っていた。最近のスマホは
// 120Hz以上でポインタイベントを出すので、ドラッグやスクロールのあいだ毎秒120個の
// 個別データグラムを作り、そのたびにJSON化・DTLS暗号化・無線送信が走っていた。
// 移動は「次の描画フレームまでに来たぶんの最後の1点」だけを送れば十分で、
// 見た目の追従は変わらないまま送信数が数分の1になる。
//
// 押下・離しなどの区切りは即時に送るが、その前に保留中の移動を必ず吐く
// (追い越すと、押した場所と違うところが押される)。
export class Outbox {
  private pending: Pt | null = null;
  private queued = false;
  private disposed = false;

  constructor(
    private raw: (msg: object) => void,
    private schedule: (cb: () => void) => void
  ) {}

  // 移動。次のフレームまでまとめられる。
  move(x: number, y: number): void {
    if (this.disposed) return;
    this.pending = { x, y };
    if (this.queued) return;
    this.queued = true;
    this.schedule(() => {
      this.queued = false;
      this.flush();
    });
  }

  // 即時に送る。保留中の移動があれば先に吐いて順序を保つ。
  send(msg: object): void {
    if (this.disposed) return;
    this.flush();
    this.raw(msg);
  }

  private flush(): void {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    this.raw({ t: "mv", x: p.x, y: p.y });
  }

  // 保留中の移動を捨てる。指を離したあとに飛ぶとカーソルがずれる。
  dispose(): void {
    this.disposed = true;
    this.pending = null;
  }
}

const TAP_MS = 250;
const LONG_PRESS_MS = 500;
const MOVE_THRESHOLD = 12; // px
const SCROLL_PX_PER_NOTCH = 40;

export class InputController {
  private pointers = new Map<number, Pt>();
  private downAt = 0;
  private startPt: Pt = { x: 0, y: 0 };
  private moved = false;
  private dragging = false;
  private longPressTimer = 0;
  private twoFingerStart: { mid: Pt; dist: number; time: number } | null = null;
  private twoFingerMoved = false;
  // 表示ズーム状態
  private scale = 1;
  private tx = 0;
  private ty = 0;

  private outbox: Outbox;

  constructor(
    private video: HTMLVideoElement,
    private surface: HTMLElement,
    private dc: RTCDataChannel
  ) {
    this.outbox = new Outbox(
      (msg) => this.sendNow(msg),
      (cb) => requestAnimationFrame(cb)
    );
    surface.addEventListener("pointerdown", this.onDown);
    surface.addEventListener("pointermove", this.onMove);
    surface.addEventListener("pointerup", this.onUp);
    surface.addEventListener("pointercancel", this.onUp);
    surface.addEventListener("wheel", this.onWheel, { passive: false });
    surface.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  // 区切りのある操作 (クリック・ホイール・音声など)。保留中の移動より後になる。
  send(msg: object): void {
    this.outbox.send(msg);
  }

  private sendNow(msg: object): void {
    if (this.dc.readyState === "open") this.dc.send(JSON.stringify(msg));
  }

  // 音声データ用。ホストは文字列メッセージ=操作、バイナリ=音声として扱う。
  sendBinary(data: ArrayBuffer): void {
    if (this.dc.readyState === "open") this.dc.send(data);
  }

  // 送信キューの詰まり具合 (音声を分割送信するときの待ち判断に使う)
  get buffered(): number {
    return this.dc.bufferedAmount;
  }

  // 画面座標 → ホスト画面の正規化座標(0..1)。映像の外ならnull。
  private toNorm(clientX: number, clientY: number): Pt | null {
    const r = this.video.getBoundingClientRect();
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!vw || !vh || r.width === 0) return null;
    const s = Math.min(r.width / vw, r.height / vh);
    const dw = vw * s;
    const dh = vh * s;
    const ox = r.left + (r.width - dw) / 2;
    const oy = r.top + (r.height - dh) / 2;
    const x = (clientX - ox) / dw;
    const y = (clientY - oy) / dh;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  // 移動は次の描画フレームまでまとめる (1イベント1パケットにしない)。
  private moveTo(clientX: number, clientY: number): void {
    const p = this.toNorm(clientX, clientY);
    if (p) this.outbox.move(p.x, p.y);
  }

  private applyTransform(): void {
    this.video.style.transformOrigin = "0 0";
    this.video.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
  }

  private onDown = (e: PointerEvent): void => {
    this.surface.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (e.pointerType === "mouse") {
      e.preventDefault();
      this.moveTo(e.clientX, e.clientY);
      this.send({ t: "dn", b: e.button === 2 ? 2 : e.button === 1 ? 1 : 0 });
      return;
    }

    if (this.pointers.size === 1) {
      this.downAt = performance.now();
      this.startPt = { x: e.clientX, y: e.clientY };
      this.moved = false;
      this.dragging = false;
      this.longPressTimer = window.setTimeout(() => {
        // 長押し: 左ボタンを押し込んでドラッグ開始
        this.dragging = true;
        this.moveTo(this.startPt.x, this.startPt.y);
        this.send({ t: "dn", b: 0 });
        navigator.vibrate?.(30);
      }, LONG_PRESS_MS);
    } else if (this.pointers.size === 2) {
      clearTimeout(this.longPressTimer);
      if (this.dragging) {
        this.send({ t: "up", b: 0 });
        this.dragging = false;
      }
      const [a, b] = [...this.pointers.values()];
      this.twoFingerStart = {
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
        dist: Math.hypot(a.x - b.x, a.y - b.y),
        time: performance.now(),
      };
      this.twoFingerMoved = false;
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) {
      if (e.pointerType === "mouse") this.moveTo(e.clientX, e.clientY);
      return;
    }
    const prev = this.pointers.get(e.pointerId)!;
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (e.pointerType === "mouse") {
      this.moveTo(e.clientX, e.clientY);
      return;
    }

    if (this.pointers.size === 1) {
      const dx = e.clientX - this.startPt.x;
      const dy = e.clientY - this.startPt.y;
      if (!this.moved && Math.hypot(dx, dy) > MOVE_THRESHOLD) {
        this.moved = true;
        if (!this.dragging) clearTimeout(this.longPressTimer);
      }
      if (this.moved || this.dragging) this.moveTo(e.clientX, e.clientY);
    } else if (this.pointers.size === 2 && this.twoFingerStart) {
      const [a, b] = [...this.pointers.values()];
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const distDelta = dist - this.twoFingerStart.dist;
      const midDy = mid.y - this.twoFingerStart.mid.y;
      const midDx = mid.x - this.twoFingerStart.mid.x;

      if (Math.hypot(midDx, midDy) > MOVE_THRESHOLD || Math.abs(distDelta) > MOVE_THRESHOLD) {
        this.twoFingerMoved = true;
      }

      if (Math.abs(distDelta) > 30 || this.scale > 1) {
        // ピンチズーム / ズーム中のパン
        const newScale = Math.min(4, Math.max(1, this.scale * (dist / this.twoFingerStart.dist)));
        const prevMid = this.twoFingerStart.mid;
        this.tx += mid.x - prevMid.x + (prevMid.x - this.tx) * (1 - newScale / this.scale);
        this.ty += mid.y - prevMid.y + (prevMid.y - this.ty) * (1 - newScale / this.scale);
        this.scale = newScale;
        if (this.scale === 1) {
          this.tx = 0;
          this.ty = 0;
        }
        this.applyTransform();
        this.twoFingerStart = { mid, dist, time: this.twoFingerStart.time };
      } else {
        // スクロール: 一定距離ごとに1ノッチ送る(指を下へ=上スクロールの自然方向)
        const notches = Math.trunc(midDy / SCROLL_PX_PER_NOTCH);
        if (notches !== 0) {
          this.send({ t: "wh", dy: notches });
          this.twoFingerStart = { ...this.twoFingerStart, mid };
        }
      }
    }
  };

  private onUp = (e: PointerEvent): void => {
    const had = this.pointers.delete(e.pointerId);
    if (!had) return;

    if (e.pointerType === "mouse") {
      this.send({ t: "up", b: e.button === 2 ? 2 : e.button === 1 ? 1 : 0 });
      return;
    }

    clearTimeout(this.longPressTimer);

    if (this.twoFingerStart && this.pointers.size <= 1) {
      // 2本指タップ → 右クリック
      if (!this.twoFingerMoved && performance.now() - this.twoFingerStart.time < TAP_MS) {
        const p = this.toNorm(this.twoFingerStart.mid.x, this.twoFingerStart.mid.y);
        if (p) {
          this.send({ t: "mv", x: p.x, y: p.y });
          this.send({ t: "dn", b: 2 });
          this.send({ t: "up", b: 2 });
        }
      }
      this.twoFingerStart = null;
      return;
    }

    if (this.dragging) {
      this.send({ t: "up", b: 0 });
      this.dragging = false;
      return;
    }

    // 1本指タップ → 左クリック
    if (!this.moved && performance.now() - this.downAt < TAP_MS) {
      const p = this.toNorm(e.clientX, e.clientY);
      if (p) {
        this.send({ t: "mv", x: p.x, y: p.y });
        this.send({ t: "dn", b: 0 });
        this.send({ t: "up", b: 0 });
      }
    }
  };

  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    this.send({ t: "wh", dy: -Math.sign(e.deltaY) });
  };

  // 再接続のたびに作り直されるので、古い方の購読は外す。
  // 残しておくと1回のポインタイベントで捨てるだけの処理が接続回数ぶん走る。
  dispose(): void {
    this.outbox.dispose();
    clearTimeout(this.longPressTimer);
    this.surface.removeEventListener("pointerdown", this.onDown);
    this.surface.removeEventListener("pointermove", this.onMove);
    this.surface.removeEventListener("pointerup", this.onUp);
    this.surface.removeEventListener("pointercancel", this.onUp);
    this.surface.removeEventListener("wheel", this.onWheel);
  }
}

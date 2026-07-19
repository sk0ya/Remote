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

  constructor(
    private video: HTMLVideoElement,
    private surface: HTMLElement,
    private dc: RTCDataChannel
  ) {
    surface.addEventListener("pointerdown", this.onDown);
    surface.addEventListener("pointermove", this.onMove);
    surface.addEventListener("pointerup", this.onUp);
    surface.addEventListener("pointercancel", this.onUp);
    surface.addEventListener("wheel", this.onWheel, { passive: false });
    surface.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  send(msg: object): void {
    if (this.dc.readyState === "open") this.dc.send(JSON.stringify(msg));
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

  private moveTo(clientX: number, clientY: number): void {
    const p = this.toNorm(clientX, clientY);
    if (p) this.send({ t: "mv", x: p.x, y: p.y });
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
}

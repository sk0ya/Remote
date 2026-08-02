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
const MAX_SCALE = 4;

export interface Box {
  w: number;
  h: number;
}

// 拡大時の移動量の上限。映像が表示領域からはみ出したぶんまでしか動かせない。
// 制限しないと画面外まで放り出せてしまい、真っ黒になって戻し方が分からなくなる。
export function clampPan(t: number, size: number, scale: number): number {
  return Math.min(0, Math.max(size * (1 - scale), t));
}

// object-fit:contain で表示領域に収まるときの倍率。
function fitScale(box: Box, content: Box): number {
  if (!(content.w > 0) || !(content.h > 0)) return 0;
  return Math.min(box.w / content.w, box.h / content.h);
}

// 表示領域の大きさが変わったときの拡大率と位置。
//
// スマホのソフトキーボードが出ると表示領域は半分近くまで狭くなる。そこへ映像を
// 収め直すと全体は見えるが字が読めなくなるので、映像は今の大きさのまま保ち、
// 狭くなったぶんは「はみ出した」状態にする。はみ出していれば2本指で動かせるので、
// 見たいところを覗く窓として使える。キーボードを閉じれば元の倍率に戻る。
//
// 位置は、映像が画面上で1ピクセルも動かないように決める。キーボードは下から
// せり上がって隠しただけ、という見え方になり、隠れたぶんは指で引き上げて見る。
//
// 横幅が変わったときは回転かウィンドウの変更で、表示できる範囲そのものが
// 変わっている。ここで見た目の大きさを保つと、縦持ちにしただけで拡大されて
// はみ出してしまうので、素直に等倍へ戻す。
export function refit(
  prev: Box,
  next: Box,
  content: Box,
  scale: number,
  tx: number,
  ty: number
): { scale: number; tx: number; ty: number } {
  if (!(next.w > 0) || !(next.h > 0)) return { scale, tx, ty };
  if (prev.w !== next.w) return { scale: 1, tx: 0, ty: 0 };
  const f0 = fitScale(prev, content);
  const f1 = fitScale(next, content);
  if (!(f0 > 0) || !(f1 > 0)) return { scale, tx, ty };
  const s = Math.min(MAX_SCALE, Math.max(1, (scale * f0) / f1));
  // 映像は表示領域の中央に置かれるので、中央のずれぶんだけ位置を戻すと
  // 画面上の見た目の位置が変わらない。
  const nx = tx + (scale * prev.w) / 2 - (s * next.w) / 2;
  const ny = ty + (scale * prev.h) / 2 - (s * next.h) / 2;
  return { scale: s, tx: clampPan(nx, next.w, s), ty: clampPan(ny, next.h, s) };
}

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

  // 直前の表示領域の大きさ。狭くなったときに映像の見え方を保つ基準にする。
  private box: Box;

  private outbox: Outbox;

  constructor(
    private video: HTMLVideoElement,
    private surface: HTMLElement,
    private dc: RTCDataChannel
  ) {
    this.box = this.videoBox();
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

  // transformの影響を受けない、レイアウト上の表示領域。
  private videoBox(): Box {
    return { w: this.video.clientWidth, h: this.video.clientHeight };
  }

  // 表示領域が変わった (キーボードの開閉・画面の回転)。
  // 映像の見た目の大きさを保ったまま、新しい領域に合わせ直す。
  relayout(): void {
    const next = this.videoBox();
    if (next.w === this.box.w && next.h === this.box.h) return;
    const prev = this.box;
    this.box = next;
    const content = { w: this.video.videoWidth, h: this.video.videoHeight };
    const r = refit(prev, next, content, this.scale, this.tx, this.ty);
    this.scale = r.scale;
    this.tx = r.tx;
    this.ty = r.ty;
    this.applyTransform();
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
        const newScale = Math.min(
          MAX_SCALE,
          Math.max(1, this.scale * (dist / this.twoFingerStart.dist))
        );
        const prevMid = this.twoFingerStart.mid;
        this.tx += mid.x - prevMid.x + (prevMid.x - this.tx) * (1 - newScale / this.scale);
        this.ty += mid.y - prevMid.y + (prevMid.y - this.ty) * (1 - newScale / this.scale);
        this.scale = newScale;
        // はみ出したぶんより先へは動かさない (画面外へ放り出して見失わない)
        this.tx = clampPan(this.tx, this.box.w, this.scale);
        this.ty = clampPan(this.ty, this.box.h, this.scale);
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

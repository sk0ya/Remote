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
//
// マウスパネル (mouse.ts) を出しているあいだは setCursorOnly(true) になり、
// 1本指はカーソルを動かすだけになる (押す・つまむ・回すはパネルのボタンが持つ)。
//   1本指タップ       → その位置へカーソルを飛ばす
//   1本指ドラッグ     → トラックボール。動かしたぶんだけ今の位置から動かす

export interface Pt {
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

// トラックボールの効き。指の移動量(画面px)を、そのままホスト画面のpxとして使う。
//
// 映像は1920pxのデスクトップを390pxの幅に縮めて映しているので、指の位置を
// そのままカーソルにすると1pxの指の動きが5px飛ぶ。閉じるボタンもメニューの
// 1項目も指の腹より小さく、そもそも狙えない。等倍で動かせば1px単位で置ける。
//
// ただし等倍のままだと画面の端から端まで5回なぞることになるので、速く払った
// ときだけ倍率を上げる (トラックパッドと同じ)。ゆっくり動かせば精密、
// 速く払えば大きく動く、が1本の指で両立する。
const GAIN_MIN = 1;
const GAIN_MAX = 3.5;
const GAIN_FULL_SPEED = 1.2; // px/ms。この速さで上限に届く

export function pointerGain(speed: number): number {
  if (!(speed > 0)) return GAIN_MIN;
  return Math.min(GAIN_MAX, GAIN_MIN + (GAIN_MAX - GAIN_MIN) * (speed / GAIN_FULL_SPEED));
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// トラックボールで動かし始めるときの「今どこに居るか」。
//
// 相対で動かす以上、手元の記憶とPC側の実際が一致していないと最初のひとなぞりで
// カーソルが飛ぶ。cursor はこちらが動かした結果そのものなので最優先。まだ一度も
// 動かしていないときは、直前に指を置いた場所(focus)を使う — 少なくとも画面の
// どのあたりを見ているかは合う。どちらも無ければ中央から始める。
export function resyncPoint(cursor: Pt | null, focus: Pt | null): Pt {
  return cursor ?? focus ?? { x: 0.5, y: 0.5 };
}

export interface Box {
  w: number;
  h: number;
}

export interface Transform {
  scale: number;
  tx: number;
  ty: number;
}

// getBoundingClientRect() が返す矩形のうち、ここで使うぶん。
export interface Rect {
  left: number;
  top: number;
  width: number;
  height: number;
}

// 画面座標 → 映像の中の正規化座標(0..1)。映像の外ならnull。
//
// rect は getBoundingClientRect() の値、つまり拡大・パンを適用したあとの矩形。
// scaleで割ればレイアウト上の大きさに戻り、パン量(tx,ty)はrect.left/topに
// すでに入っているので引き直してはいけない。以前はここでtxを引き戻していて、
// 「パンしていなかったらそこに何があったか」の座標をホストへ送っていた
// (ズームして動かしたあとにタップすると、その動かしたぶんだけずれる)。
export function toNorm(
  clientX: number,
  clientY: number,
  rect: Rect,
  content: Box,
  scale: number
): Pt | null {
  if (!(content.w > 0) || !(content.h > 0) || !(rect.width > 0) || !(scale > 0)) return null;
  // 変換前(レイアウト上)の大きさに戻してから object-fit:contain の中身を計算する
  const baseW = rect.width / scale;
  const baseH = rect.height / scale;
  const s = Math.min(baseW / content.w, baseH / content.h);
  const dw = content.w * s;
  const dh = content.h * s;
  const x = ((clientX - rect.left) / scale - (baseW - dw) / 2) / dw;
  const y = ((clientY - rect.top) / scale - (baseH - dh) / 2) / dh;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return { x, y };
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

// 表示領域に対する映像の置き方。
//
// ふだん(fill=false)は全体を収める。デスクトップ全体が見えていないと
// どこを触っているのか分からないので、これが基本。
//
// ソフトキーボードを出しているあいだ(fill=true)は、残った領域を埋める。
// 16:9のデスクトップをスマホの縦長の隙間に収め直すと、上下が真っ黒な余白に
// なったうえ字も読めない大きさになる。埋めてしまえば余白は消え、はみ出した
// ぶんは2本指で動かして見たいところを出せる。つまみ出せば(縮小すれば)
// いつでも全体表示に戻せるので、見失うこともない。
//
// キーボードを閉じれば全体表示へ戻る。
export function refit(box: Box, content: Box, fill: boolean, focus?: Pt): Transform {
  const contain = fitScale(box, content);
  if (!fill || !(contain > 0)) return { scale: 1, tx: 0, ty: 0 };
  // 領域を埋める倍率 (収める倍率との比が、そのまま拡大率になる)
  const cover = Math.max(box.w / content.w, box.h / content.h);
  const scale = Math.min(MAX_SCALE, Math.max(1, cover / contain));
  // はみ出したぶんはフォーカス位置を見せる。フォーカス位置が無いときは
  // 中央を見せる (端に寄せると必ず片側が切れて見えない)。
  const baseW = content.w * contain;
  const baseH = content.h * contain;
  const focusX = focus ? (box.w - baseW) / 2 + focus.x * baseW : box.w / 2;
  const focusY = focus ? (box.h - baseH) / 2 + focus.y * baseH : box.h / 2;
  return {
    scale,
    tx: clampPan(box.w / 2 - focusX * scale, box.w, scale),
    ty: clampPan(box.h / 2 - focusY * scale, box.h, scale),
  };
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
  // この操作のあいだに2本目の指が触れたか。
  // 2本指の処理は1本目を離した時点で終わるので、残った指を離したぶんが
  // 1本指タップとして拾われる。ピンチやスクロールのあとに、指を離した場所を
  // 勝手にクリックしてしまうので、指が1本に戻るまでタップとは見なさない。
  private multi = false;
  // 表示ズーム状態
  private scale = 1;
  private tx = 0;
  private ty = 0;
  // キーボードを開いたときに見せる、直前にタップしたリモート画面上の位置。
  private focus: Pt | null = null;

  // マウスパネルを出しているあいだ。映像へのタッチはカーソルを動かすだけにする。
  //
  // 押す・つまむはパネルのボタンが受け持つので、タップでクリックまで起きると
  // 「押す前に狙った場所へカーソルを置く」ができない (触れた瞬間に押してしまう)。
  // 長押しドラッグも同じ理由で止める — つまむのはパネル側の役目になる。
  //
  // 動かし方は2通りで、粗いのと細かいのを1本の指で使い分ける:
  //   タップ   → その位置へ飛ばす (遠くへ運ぶ。指1本ぶんの精度)
  //   なぞる   → トラックボール。指の動いたぶんだけ今の位置から動かす
  private cursorOnly = false;
  // トラックボールで動かすための、今のカーソル位置 (正規化座標)。
  // 相対で動かす以上、今どこに居るかを手元でも持っておく必要がある。
  private cursor: Pt | null = null;
  private lastMoveAt = 0;

  // 直前の表示領域の大きさ。変わっていなければ置き直す必要がない。
  private box: Box;
  // ソフトキーボードで領域が削られている (埋めて表示している) かどうか
  private filling = false;

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

  // マウスパネルの開閉に合わせて、映像へのタッチの扱いを切り替える。
  setCursorOnly(on: boolean): void {
    if (this.cursorOnly === on) return;
    this.cursorOnly = on;
    // 切り替えた時点で進行中だった長押しドラッグは畳む。
    // 残すとPC側は左ボタンを押しっぱなしのままになる。
    clearTimeout(this.longPressTimer);
    if (this.dragging) {
      this.send({ t: "up", b: 0 });
      this.dragging = false;
    }
    if (!on) return;

    // トラックボールは「今どこに居るか」からの相対で動かすので、手元の記憶と
    // PC側の実際がずれていると、最初のひとなぞりでカーソルが飛ぶ。ずれるのは
    // 手元がまだ何も知らないとき(開いてすぐスクロールだけした等)と、PCの
    // 実物のマウスが動かされたとき。開いた時点で一度こちらから言い切って
    // 合わせておく。ふだんは同じ座標を送り直すだけなので何も動かない。
    const p = resyncPoint(this.cursor, this.focus);
    this.cursor = p;
    this.send({ t: "mv", x: p.x, y: p.y });
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
    return toNorm(
      clientX,
      clientY,
      this.video.getBoundingClientRect(),
      { w: this.video.videoWidth, h: this.video.videoHeight },
      this.scale
    );
  }

  // 移動は次の描画フレームまでまとめる (1イベント1パケットにしない)。
  private moveTo(clientX: number, clientY: number): void {
    const p = this.toNorm(clientX, clientY);
    if (!p) return;
    this.cursor = p;
    this.outbox.move(p.x, p.y);
  }

  // トラックボール。指の動いたぶんだけ、今のカーソル位置から動かす。
  // dtMs は前のイベントからの経過。速く払ったときだけ倍率を上げるのに使う。
  private moveBy(dx: number, dy: number, dtMs: number): void {
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (!(vw > 0) || !(vh > 0)) return;
    const gain = pointerGain(Math.hypot(dx, dy) / Math.max(1, dtMs));
    // 画面の1px = ホスト画面の1px。x と y で割る数が違うのは、正規化座標が
    // 軸ごとに幅・高さで割った値だから (ホスト画面のpxで見れば同じ倍率)。
    const from = resyncPoint(this.cursor, this.focus);
    this.cursor = {
      x: clamp01(from.x + (dx * gain) / vw),
      y: clamp01(from.y + (dy * gain) / vh),
    };
    this.outbox.move(this.cursor.x, this.cursor.y);
  }

  // キーボード表示時に見せる位置を、クリックの完了を待たずに記録する。
  // pointerupがOSやブラウザに奪われても、入力を始めた場所は失わない。
  private rememberFocus(clientX: number, clientY: number): void {
    const p = this.toNorm(clientX, clientY);
    if (p) this.focus = p;
  }

  private applyTransform(): void {
    // 等倍のときはtransformを付けない。付けると映像が合成レイヤーに移り、
    // 端末によっては(親のクリップと組み合わさって)何も描かれなくなる。
    // 拡大していないあいだは、transformが無かった頃と同じ素の状態に戻す。
    if (this.scale === 1 && this.tx === 0 && this.ty === 0) {
      this.video.style.transform = "";
      return;
    }
    this.video.style.transformOrigin = "0 0";
    this.video.style.transform = `translate(${this.tx}px, ${this.ty}px) scale(${this.scale})`;
  }

  // transformの影響を受けない、レイアウト上の表示領域。
  private videoBox(): Box {
    return { w: this.video.clientWidth, h: this.video.clientHeight };
  }

  // 表示領域が変わった (キーボードの開閉・画面の回転)。
  // fill = ソフトキーボードで領域が削られている状態。
  //
  // ここで置き直すのは領域が変わったときだけ。ユーザーがつまんで動かした
  // 拡大・位置は、次に領域が変わるまでそのまま残る。
  relayout(fill: boolean): void {
    const next = this.videoBox();
    if (next.w === this.box.w && next.h === this.box.h && fill === this.filling) return;
    this.box = next;
    this.filling = fill;
    const content = { w: this.video.videoWidth, h: this.video.videoHeight };
    const r = refit(next, content, fill, this.focus ?? undefined);
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
      this.rememberFocus(e.clientX, e.clientY);
      this.moveTo(e.clientX, e.clientY);
      this.send({ t: "dn", b: e.button === 2 ? 2 : e.button === 1 ? 1 : 0 });
      return;
    }

    if (this.pointers.size === 1) {
      this.rememberFocus(e.clientX, e.clientY);
      this.downAt = performance.now();
      this.startPt = { x: e.clientX, y: e.clientY };
      this.moved = false;
      this.dragging = false;
      this.multi = false;
      if (this.cursorOnly) {
        // 触れただけでは動かさない。なぞればトラックボール、離すまで
        // 動かなければタップとして、離した時点でその位置へ飛ばす。
        this.lastMoveAt = this.downAt;
        return;
      }
      this.longPressTimer = window.setTimeout(() => {
        // 長押し: 左ボタンを押し込んでドラッグ開始
        this.dragging = true;
        this.moveTo(this.startPt.x, this.startPt.y);
        this.send({ t: "dn", b: 0 });
        navigator.vibrate?.(30);
      }, LONG_PRESS_MS);
    } else if (this.pointers.size === 2) {
      this.multi = true;
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

    if (this.pointers.size === 1 && this.cursorOnly) {
      const now = performance.now();
      this.moveBy(e.clientX - prev.x, e.clientY - prev.y, now - this.lastMoveAt);
      this.lastMoveAt = now;
      if (Math.hypot(e.clientX - this.startPt.x, e.clientY - this.startPt.y) > MOVE_THRESHOLD) {
        this.moved = true;
      }
    } else if (this.pointers.size === 1) {
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
          this.cursor = p; // 次のトラックボール操作はここから続ける
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

    // パネルを出しているあいだのタップ。押さずに、その位置へカーソルを飛ばす。
    // なぞって寄せるだけだと遠くへ運ぶのに何往復もかかるので、粗い移動はこちらが持つ。
    if (this.cursorOnly) {
      if (!this.multi && !this.moved) this.moveTo(e.clientX, e.clientY);
      return;
    }

    // 1本指タップ → 左クリック
    if (!this.multi && !this.moved && performance.now() - this.downAt < TAP_MS) {
      const p = this.toNorm(e.clientX, e.clientY);
      if (p) {
        this.focus = p;
        this.cursor = p; // 次にパネルを開いたとき、ここから相対で動かす
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

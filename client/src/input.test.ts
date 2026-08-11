import { describe, it, expect, vi } from "vitest";
import { Outbox, refit, clampPan, toNorm } from "./input";
import type { Box, Pt, Rect } from "./input";

// 送信を記録し、rAF相当のスケジュールを手動で進められるOutboxを作る。
function makeOutbox() {
  const sent: object[] = [];
  let pending: (() => void) | null = null;
  const box = new Outbox(
    (msg) => sent.push(msg),
    (cb) => {
      pending = cb;
    }
  );
  return {
    box,
    sent,
    // 次のフレームが来たことにする
    frame() {
      const cb = pending;
      pending = null;
      cb?.();
    },
    get scheduled() {
      return pending !== null;
    },
  };
}

describe("Outbox", () => {
  // 以前はpointermoveのたびに1個ずつDataChannelへ送っていた。最近のスマホは
  // 120Hz以上でイベントを出すので、ドラッグ中は毎秒120個の個別データグラムに
  // なり、そのたびに暗号化と無線送信が走っていた。
  it("1フレーム分の移動を1通にまとめ、最後の座標だけ送る", () => {
    const h = makeOutbox();
    h.box.move(0.1, 0.1);
    h.box.move(0.2, 0.2);
    h.box.move(0.3, 0.4);

    expect(h.sent).toEqual([]); // まだ1通も出ていない
    h.frame();
    expect(h.sent).toEqual([{ t: "mv", x: 0.3, y: 0.4 }]);
  });

  it("何度呼ばれてもフレームは1回しか予約しない", () => {
    const h = makeOutbox();
    const schedule = vi.fn();
    const box = new Outbox(() => {}, schedule);
    box.move(0.1, 0.1);
    box.move(0.2, 0.2);
    box.move(0.3, 0.3);
    expect(schedule).toHaveBeenCalledTimes(1);
  });

  // クリックが保留中の移動を追い越すと、押した場所と違うところが押される。
  it("ボタン操作は保留中の移動を先に吐いてから送る", () => {
    const h = makeOutbox();
    h.box.move(0.5, 0.6);
    h.box.send({ t: "dn", b: 0 });

    expect(h.sent).toEqual([
      { t: "mv", x: 0.5, y: 0.6 },
      { t: "dn", b: 0 },
    ]);
  });

  it("吐き出したあとにフレームが来ても二重に送らない", () => {
    const h = makeOutbox();
    h.box.move(0.5, 0.6);
    h.box.send({ t: "dn", b: 0 });
    h.frame();
    expect(h.sent).toHaveLength(2);
  });

  it("保留が無ければフレームが来ても何も送らない", () => {
    const h = makeOutbox();
    h.frame();
    expect(h.sent).toEqual([]);
  });

  it("フレームを跨いだ移動はあらためて予約される", () => {
    const h = makeOutbox();
    h.box.move(0.1, 0.1);
    h.frame();
    h.box.move(0.2, 0.2);
    expect(h.scheduled).toBe(true);
    h.frame();
    expect(h.sent).toEqual([
      { t: "mv", x: 0.1, y: 0.1 },
      { t: "mv", x: 0.2, y: 0.2 },
    ]);
  });

  // 指を離したあとに保留分が飛ぶと、離した先へカーソルが動いてしまう。
  it("破棄すると保留中の移動は送られない", () => {
    const h = makeOutbox();
    h.box.move(0.1, 0.1);
    h.box.dispose();
    h.frame();
    expect(h.sent).toEqual([]);
  });
});

// ソフトキーボードを出すと、映像を出せる範囲は画面の半分以下まで狭くなる。
// そこへ16:9のデスクトップを収め直すと、上下は真っ黒な余白、字は読めない
// 大きさになる。狭いあいだは余白を作らず埋め、はみ出したぶんは指で動かす。
const HD = { w: 1920, h: 1080 };

describe("refit", () => {
  // ふだんは全体表示。どこを触っているか分からなくなるので拡大しない。
  it("キーボードが無いときは全体を収める", () => {
    expect(refit({ w: 390, h: 844 }, HD, false)).toEqual({ scale: 1, tx: 0, ty: 0 });
    expect(refit({ w: 844, h: 390 }, HD, false)).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  // 縦持ち: 390x423 の隙間。収めると219pxの帯になって上下204pxが余白。
  // 埋めれば高さいっぱいに使え、横にはみ出したぶんを指で動かせる。
  it("縦持ちでキーボードを出すと、余白を作らず高さいっぱいに使う", () => {
    const r = refit({ w: 390, h: 423 }, HD, true);
    expect(r.scale).toBeCloseTo(1.929); // (423/1080) / (390/1920)
    expect(390 * r.scale).toBeGreaterThan(390); // 横にはみ出す = 動かせる
    // 映像の中身が領域の高さちょうどに広がる位置 (上下に余白が残らない)
    expect(r.ty).toBeCloseTo(-196.3, 1);
    expect(r.tx).toBeCloseTo(-181, 1); // 横は中央
  });

  // 横持ち: 844x117 の帯。埋めるには4倍を超えるので上限で止まる。
  it("横持ちでキーボードを出すと上限まで拡大する", () => {
    const r = refit({ w: 844, h: 117 }, HD, true);
    expect(r.scale).toBe(4);
  });

  // 拡大しすぎると全体が分からなくなるので上限を設けている。
  it("上限を超えて拡大しない", () => {
    expect(refit({ w: 390, h: 900 }, HD, true).scale).toBe(4);
  });

  // 映像がまだ届いていない (幅も高さも0) 段階では基準が無い。
  // ここで0除算の結果を書き込むと、映像が出た瞬間に真っ黒になる。
  it("映像の大きさが分からないうちは全体表示のままにする", () => {
    expect(refit({ w: 844, h: 200 }, { w: 0, h: 0 }, true)).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  // 収めるだけで足りる形 (映像と同じ縦横比) なら拡大しない。
  it("ぴったり収まる形なら拡大しない", () => {
    expect(refit({ w: 1920, h: 1080 }, HD, true)).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it("フォーカス位置を表示領域の中央へ移動する", () => {
    const r = refit({ w: 390, h: 423 }, HD, true, { x: 0.5, y: 0.8 });
    expect(r.scale).toBeCloseTo(1.929);
    // 中央のxはそのまま、下側のフォーカスに合わせて上へパンする。
    expect(r.tx).toBeCloseTo(-181, 1);
    expect(r.ty).toBeCloseTo(-323.2, 1);
  });

  it("端のフォーカスは映像の端を超えてパンしない", () => {
    const r = refit({ w: 390, h: 423 }, HD, true, { x: 0, y: 0 });
    expect(r.tx).toBe(0);
    expect(r.ty).toBe(0);
  });
});

// 指で触った場所を、ホスト画面のどこかへ翻訳する。ここがずれると、
// 見えている場所と違うところがクリックされる。
describe("toNorm", () => {
  // 縦持ちのスマホに16:9のデスクトップを収めた状態。
  // 横は390pxいっぱい、縦は219.375pxの帯で、上下に312.3125pxずつ余白が出る。
  const BOX = { w: 390, h: 844 };
  const LETTERBOX = 312.3125;

  // transformを適用したあとの矩形 (getBoundingClientRect()が返すもの)。
  // 映像はビューア全体を占めるので、レイアウト上の左上は0,0。
  function rectOf(t: { scale: number; tx: number; ty: number }): Rect {
    return { left: t.tx, top: t.ty, width: BOX.w * t.scale, height: BOX.h * t.scale };
  }

  // 正規化座標が実際に画面のどこに見えているか。toNormとは別の式で出す
  // (拡大しても余白との比は変わらないので、変換後の矩形だけで完結する)。
  function place(p: Pt, rect: Rect, content: Box): Pt {
    const s = Math.min(rect.width / content.w, rect.height / content.h);
    return {
      x: rect.left + (rect.width - content.w * s) / 2 + content.w * s * p.x,
      y: rect.top + (rect.height - content.h * s) / 2 + content.h * s * p.y,
    };
  }

  it("等倍では余白を除いた中身の位置を返す", () => {
    const r = rectOf({ scale: 1, tx: 0, ty: 0 });
    expect(toNorm(195, 422, r, HD, 1)).toEqual({ x: 0.5, y: 0.5 });
    expect(toNorm(0, LETTERBOX, r, HD, 1)).toEqual({ x: 0, y: 0 });
    expect(toNorm(390, 844 - LETTERBOX, r, HD, 1)).toEqual({ x: 1, y: 1 });
  });

  it("上下の余白を触っても映像の外として弾く", () => {
    const r = rectOf({ scale: 1, tx: 0, ty: 0 });
    expect(toNorm(195, LETTERBOX - 1, r, HD, 1)).toBeNull();
    expect(toNorm(195, 844 - LETTERBOX + 1, r, HD, 1)).toBeNull();
    expect(toNorm(-1, 422, r, HD, 1)).toBeNull();
    expect(toNorm(391, 422, r, HD, 1)).toBeNull();
  });

  // 以前はここでパン量を引き戻しており、「動かしていなかったら
  // そこに何があったか」を送っていた (下の例では0.5ではなく0.25)。
  it("ズームして動かしたあとも、指の下にあるものの位置を返す", () => {
    const t = { scale: 2, tx: -195, ty: -200 };
    const r = rectOf(t);
    // 中央(195,644)には、2倍に拡大して左へ195px動かした結果、映像の中央が来ている
    const p = toNorm(195, 644, r, HD, t.scale)!;
    expect(p.x).toBeCloseTo(0.5, 6);
    expect(p.y).toBeCloseTo(0.5, 6);
  });

  it("拡大して画面の外へ出た端は、そのまま映像の端として扱う", () => {
    const t = { scale: 2, tx: -195, ty: -200 };
    const r = rectOf(t);
    expect(toNorm(-195, 644, r, HD, t.scale)!.x).toBeCloseTo(0, 6); // 左端は画面外
    expect(toNorm(-196, 644, r, HD, t.scale)).toBeNull(); // その外は映像ではない
  });

  // どのズーム・位置でも「見えている場所」と「送る座標」が一致すること。
  it("見えている位置から逆算した座標が元に戻る", () => {
    const transforms = [
      { scale: 1, tx: 0, ty: 0 },
      { scale: 2, tx: -195, ty: -200 },
      { scale: 3.5, tx: -700, ty: -1200 },
      { scale: 1.929, tx: -181, ty: -196.3 }, // キーボードを開いて埋めた状態
    ];
    const points = [
      { x: 0.5, y: 0.5 },
      { x: 0.1, y: 0.9 },
      { x: 0.83, y: 0.27 },
    ];
    for (const t of transforms) {
      const r = rectOf(t);
      for (const want of points) {
        const screen = place(want, r, HD);
        const got = toNorm(screen.x, screen.y, r, HD, t.scale);
        expect(got, `scale=${t.scale} ${JSON.stringify(want)}`).not.toBeNull();
        expect(got!.x).toBeCloseTo(want.x, 6);
        expect(got!.y).toBeCloseTo(want.y, 6);
      }
    }
  });

  // 映像がまだ届いていない・領域が潰れている間は基準が無い。
  // 0除算の結果を座標として送るとカーソルが飛ぶ。
  it("基準が定まらないうちは何も返さない", () => {
    const r = rectOf({ scale: 1, tx: 0, ty: 0 });
    expect(toNorm(195, 422, r, { w: 0, h: 0 }, 1)).toBeNull();
    expect(toNorm(195, 422, { left: 0, top: 0, width: 0, height: 0 }, HD, 1)).toBeNull();
    expect(toNorm(195, 422, r, HD, 0)).toBeNull();
  });
});

// 際限なく動かせると映像を画面の外へ放り出せてしまい、真っ黒な画面から
// 戻す手段が無くなる。はみ出したぶんまでしか動かさない。
describe("clampPan", () => {
  it("はみ出した範囲を超えて動かさない", () => {
    expect(clampPan(-100, 800, 2)).toBe(-100); // はみ出しは800px
    expect(clampPan(-900, 800, 2)).toBe(-800); // 行き過ぎは端で止める
    expect(clampPan(50, 800, 2)).toBe(0); // 手前側も端で止める
  });

  it("等倍のときは動かせない", () => {
    expect(clampPan(-50, 800, 1)).toBe(0);
    expect(clampPan(50, 800, 1)).toBe(0);
  });
});

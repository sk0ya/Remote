import { describe, it, expect, vi } from "vitest";
import { Outbox, refit, clampPan } from "./input";

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

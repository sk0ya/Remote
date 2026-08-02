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
// そこへ収め直すと全体は見えるが字が読めない大きさになるので、映像は今の
// 見た目の大きさのまま残し、はみ出したぶんは2本指で動かして覗けるようにする。
const HD = { w: 1920, h: 1080 };

describe("refit", () => {
  // 縦持ちでは映像は横幅で決まっていて、上下は余白。狭くなっても表示の
  // 大きさは変わらないので、余白が減って中央に寄るだけでよい。
  it("縦持ちは余白が減るだけで倍率も位置も変えない", () => {
    expect(refit({ w: 390, h: 844 }, { w: 390, h: 400 }, HD, 1, 0, 0)).toEqual({
      scale: 1,
      tx: 0,
      ty: 0,
    });
  });

  // 横持ちは映像の高さが表示領域そのもの。収め直すと半分の大きさになるので、
  // 代わりに倍率を上げて見た目を保ち、下へはみ出させる。
  it("横持ちは見た目の大きさを保つぶんだけ拡大する", () => {
    const r = refit({ w: 844, h: 390 }, { w: 844, h: 200 }, HD, 1, 0, 0);
    expect(r.scale).toBeCloseTo(1.95); // 390/200
    expect(r.tx).toBeCloseTo(-400.9); // 横は中央のまま
    // 上端は動かない = キーボードが下から隠しただけの見え方になる
    expect(r.ty).toBeCloseTo(0);
  });

  // 回転や画面分割は表示できる範囲そのものが変わる。ここで見た目を保つと
  // 縦持ちにしただけで拡大されてしまうので、素直に収め直す。
  it("横幅が変わったら等倍に戻す", () => {
    expect(refit({ w: 844, h: 200 }, { w: 390, h: 844 }, HD, 1.95, -400.9, 0)).toEqual({
      scale: 1,
      tx: 0,
      ty: 0,
    });
  });

  // キーボードを閉じたら元の見え方に戻らないと、閉じるたびに拡大が残る。
  it("元の大きさに戻せば倍率も位置も元通りになる", () => {
    const open = refit({ w: 844, h: 390 }, { w: 844, h: 200 }, HD, 1, 0, 0);
    const closed = refit({ w: 844, h: 200 }, { w: 844, h: 390 }, HD, open.scale, open.tx, open.ty);
    expect(closed).toEqual({ scale: 1, tx: 0, ty: 0 });
  });

  it("拡大したまま狭くしても上限は超えない", () => {
    const r = refit({ w: 844, h: 390 }, { w: 844, h: 200 }, HD, 3, -422, -195);
    expect(r.scale).toBe(4); // 3 * 1.95 は上限で頭打ち
  });

  it("大きさが変わらなければ何もしない", () => {
    expect(refit({ w: 800, h: 400 }, { w: 800, h: 400 }, HD, 2, -800, -400)).toEqual({
      scale: 2,
      tx: -800,
      ty: -400,
    });
  });

  // 映像がまだ届いていない (幅も高さも0) 段階では基準が無い。
  // ここで0除算の結果を書き込むと、映像が出た瞬間に真っ黒になる。
  it("映像の大きさが分からないうちは触らない", () => {
    expect(refit({ w: 844, h: 390 }, { w: 844, h: 200 }, { w: 0, h: 0 }, 1, 0, 0)).toEqual({
      scale: 1,
      tx: 0,
      ty: 0,
    });
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

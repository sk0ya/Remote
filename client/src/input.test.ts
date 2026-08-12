import { describe, it, expect, vi } from "vitest";
import { Outbox, refit, clampPan, panToShow, toNorm, pointerGain, resyncPoint } from "./input";
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

  // 縦持ちで埋めると、はみ出すのは横だけ (デスクトップの高さは全部映っている)。
  // 縦にも動かすと映像の下端が画面の内側へ入り、黒い帯が出るだけになる。
  it("フォーカス位置を、動かせる向きだけ表示領域の中央へ寄せる", () => {
    const r = refit({ w: 390, h: 423 }, HD, true, { x: 0.4, y: 0.8 });
    expect(r.tx).toBeCloseTo(-105.8, 1); // 左寄りのフォーカスが中央へ来る
    expect(r.ty).toBeCloseTo(-196.3, 1); // 縦は動かしようがない
  });

  it("端のフォーカスでも映像の端を超えてパンしない", () => {
    const r = refit({ w: 390, h: 423 }, HD, true, { x: 0, y: 0 });
    expect(r.tx).toBe(0);
    expect(r.ty).toBeCloseTo(-196.3, 1);
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

  // 16:9のデスクトップを縦長の画面に収めると上下に余白ができる。表示領域の端で
  // 止めると余白のぶんだけ行き過ぎ、埋めているのに黒い帯が出る。
  // (400pxの領域に、上下100pxの余白を置いて200pxの映像がある状態)
  it("余白ではなく映像の端で止める", () => {
    const image = { off: 100, len: 200 };
    expect(clampPan(-600, 400, 3, image)).toBe(-500); // 奥は映像の下端まで
    expect(clampPan(0, 400, 3, image)).toBe(-300); // 手前は映像の上端まで
    expect(clampPan(-400, 400, 3, image)).toBe(-400); // その間はそのまま
  });

  it("拡大しても収まりきる向きは中央に置く", () => {
    // 300pxに広げても400pxの領域には収まる = 動かす余地が無い
    expect(clampPan(-999, 400, 1.5, { off: 100, len: 200 })).toBe(-100);
  });
});

// 埋めているあいだ映っているのはデスクトップの一部だけなので、トラックボールで
// 動かしたカーソルはすぐ切り取りの外へ出る。出た先は見えず、PC側では動いて
// いるのにこちらでは何も起きていないように見えるので、映像の方をずらして追う。
// (領域800px・2倍 = 中身1600px。動かせる範囲は -800〜0)
describe("panToShow", () => {
  it("見えているうちは動かさない", () => {
    expect(panToShow(0, 100, 800, 2, 64)).toBe(0); // 画面上200px
    expect(panToShow(-200, 200, 800, 2, 64)).toBe(-200); // 画面上200px
  });

  it("端に寄ったら、余白を残すところまで追う", () => {
    expect(panToShow(0, 400, 800, 2, 64)).toBe(-64); // 奥へ出る手前で止める
    expect(panToShow(-400, 150, 800, 2, 64)).toBe(-236); // 手前側も同じ
  });

  it("映像の端まで来たらそこで止まる", () => {
    // 余白を残そうとしても、その先には映像が無い (黒い帯を出す方が困る)
    expect(panToShow(0, 780, 800, 2, 64)).toBe(-800);
    expect(panToShow(-400, 10, 800, 2, 64)).toBe(0);
  });

  it("等倍のときは動かさない", () => {
    expect(panToShow(0, 100, 800, 1, 64)).toBe(0);
  });

  // 狭い領域で余白を取りすぎると、寄せ先が左右の端で食い合って動きが暴れる。
  it("余白は領域の1/3までにする", () => {
    expect(panToShow(0, 60, 120, 2, 64)).toBe(-40); // 余白は64pxではなく40px
  });
});

// 映像は1920pxのデスクトップを390pxの幅に縮めて映しているので、指の位置を
// そのままカーソルにすると1pxの指の動きが5px飛ぶ。トラックボールは等倍から
// 始めて、速く払ったときだけ倍率を上げる。
describe("pointerGain", () => {
  it("ゆっくり動かすと等倍 (1px単位で置ける)", () => {
    expect(pointerGain(0)).toBe(1);
    expect(pointerGain(0.01)).toBeLessThan(1.1);
  });

  it("速く払うほど大きく動くが、上限で頭打ちになる", () => {
    const slow = pointerGain(0.2);
    const fast = pointerGain(0.8);
    expect(fast).toBeGreaterThan(slow);
    expect(pointerGain(100)).toBe(3.5);
    expect(pointerGain(1e6)).toBe(3.5); // 端末の取りこぼしで飛んだ値でも暴れない
  });

  // 経過時間が0や負(タイマーの分解能)でも、そこだけ極端に飛ばさない。
  it("速さが取れないときは等倍にする", () => {
    expect(pointerGain(NaN)).toBe(1);
    expect(pointerGain(-1)).toBe(1);
  });
});

// トラックボールは「今どこに居るか」からの相対で動かす。手元の記憶とPC側の
// 実際がずれていると、最初のひとなぞりでカーソルが飛ぶ。
describe("resyncPoint", () => {
  const cursor = { x: 0.2, y: 0.8 };
  const focus = { x: 0.7, y: 0.3 };

  // cursor はこちらが動かした結果そのものなので、PC側の実際と一致している。
  it("動かした結果を最優先で使う", () => {
    expect(resyncPoint(cursor, focus)).toEqual(cursor);
    expect(resyncPoint(cursor, null)).toEqual(cursor);
  });

  // 開いてすぐスクロールだけした等、まだ一度も動かしていない場合。
  // 直前に指を置いた場所なら、少なくとも見ているあたりには合う。
  it("まだ動かしていなければ直前に指を置いた場所から始める", () => {
    expect(resyncPoint(null, focus)).toEqual(focus);
  });

  it("手がかりが無ければ中央から始める", () => {
    expect(resyncPoint(null, null)).toEqual({ x: 0.5, y: 0.5 });
  });
});

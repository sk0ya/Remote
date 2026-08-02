import { describe, it, expect, vi } from "vitest";
import { Outbox } from "./input";

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

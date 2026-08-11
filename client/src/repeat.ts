// 押しっぱなしでの連射。画面内キーボードの矢印・⌫と、マウスパネルのスクロールで
// 同じものを使う。
//
// タイマーはキー(ボタン)ごとに持つ。1組を使い回すと、↓を押しながら別の指で
// ⌫を叩いたときに、まだ離していない↓の連射まで止まってしまう。

export const REPEAT_DELAY_MS = 400;
export const REPEAT_INTERVAL_MS = 60;

interface Timers {
  delay: number;
  interval: number;
}

export class Repeater {
  private timers = new Map<object, Timers>();

  // key のボタンを押しっぱなしにしたときの連射を始める。
  // 1打目は呼び出し側が済ませておく (押した瞬間の反応を遅らせない)。
  start(key: object, fire: () => void): void {
    this.stop(key); // 同じキーの押し直し
    const t: Timers = { delay: 0, interval: 0 };
    t.delay = window.setTimeout(() => {
      t.interval = window.setInterval(fire, REPEAT_INTERVAL_MS);
    }, REPEAT_DELAY_MS);
    this.timers.set(key, t);
  }

  // key を渡すとそのキーだけ、省くと全部止める (閉じるとき・片付けるとき)。
  stop(key?: object): void {
    const clear = (t: Timers): void => {
      clearTimeout(t.delay);
      clearInterval(t.interval);
    };
    if (key) {
      const t = this.timers.get(key);
      if (t) {
        clear(t);
        this.timers.delete(key);
      }
      return;
    }
    for (const t of this.timers.values()) clear(t);
    this.timers.clear();
  }
}

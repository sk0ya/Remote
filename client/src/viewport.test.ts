import { describe, it, expect } from "vitest";
import { viewportPixels } from "./viewport";

// ホストはモニタの実解像度をそのまま送っていた。スマホのデコード電力はほぼ
// ピクセル数に比例するので、実際に表示できる大きさを伝えてそこまで落として
// もらう。CSSピクセルではなくデバイスピクセルで伝えないと、高精細な端末で
// 実際より小さい値を申告してぼやける。
describe("viewportPixels", () => {
  it("CSSピクセルにデバイス比を掛けた実ピクセルを返す", () => {
    expect(viewportPixels(390, 844, 3)).toEqual({ w: 1170, h: 2532 });
  });

  it("等倍の画面はそのまま", () => {
    expect(viewportPixels(1280, 720, 1)).toEqual({ w: 1280, h: 720 });
  });

  it("端数は整数に丸める", () => {
    expect(viewportPixels(412.5, 915.5, 2.625)).toEqual({ w: 1083, h: 2403 });
  });

  // 取得できない・壊れた値でホスト側の判断を狂わせない。
  it("値が取れないときは0を返して申告しない", () => {
    expect(viewportPixels(0, 0, 2)).toEqual({ w: 0, h: 0 });
    expect(viewportPixels(390, 844, 0)).toEqual({ w: 0, h: 0 });
    expect(viewportPixels(NaN, 844, 2)).toEqual({ w: 0, h: 0 });
  });

  // 上限そのものはホスト側で決める。ここで勝手に絞ると、PCブラウザから
  // 見たときに不必要にぼやける。
  it("大きい画面でも切り詰めない", () => {
    expect(viewportPixels(2560, 1440, 2)).toEqual({ w: 5120, h: 2880 });
  });
});

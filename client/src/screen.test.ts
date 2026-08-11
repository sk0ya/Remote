import { describe, it, expect } from "vitest";
import { shouldFill, type Occlusion } from "./screen";

const none: Occlusion = { occluded: 0, webKeyboard: 0, textInput: 0, mousePad: 0 };

// 「埋める」= 残った領域に合わせて拡大し、はみ出したぶんを切り取る表示。
// キーボードのためにある挙動で、下端を使うもの全部に効かせてはいけない。
describe("shouldFill", () => {
  it("何も出ていなければ全体表示のまま", () => {
    expect(shouldFill(none)).toBe(false);
  });

  // キーボードは画面の半分以上を持っていく。残った隙間に16:9のデスクトップを
  // 収め直すと上下が真っ黒な余白になり、字も読めない大きさになる。
  it("キーボードを出しているときは埋める", () => {
    expect(shouldFill({ ...none, webKeyboard: 250 })).toBe(true);
    expect(shouldFill({ ...none, occluded: 300 })).toBe(true); // OSキーボード
    expect(shouldFill({ ...none, textInput: 60 })).toBe(true);
  });

  // マウスパネルは130px前後しか取らない。ここで埋めると縦持ちでは3倍以上に
  // 拡大され、デスクトップの3割ほどしか映らなくなる。狙って押すために出す
  // パネルなのにカーソルが映っていない範囲へ出て、行方が分からなくなる。
  it("マウスパネルだけのときは埋めない", () => {
    expect(shouldFill({ ...none, mousePad: 136 })).toBe(false);
    expect(shouldFill({ ...none, mousePad: 999 })).toBe(false);
  });

  // OSキーボードの上にマウスパネルが載っている状態。埋める理由はキーボードの側。
  it("キーボードと同時に出ていれば埋める", () => {
    expect(shouldFill({ ...none, occluded: 300, mousePad: 136 })).toBe(true);
  });
});

import { describe, it, expect } from "vitest";
import { shouldFill, type Occlusion } from "./screen";

const none: Occlusion = { occluded: 0, webKeyboard: 0, textInput: 0, mousePad: 0 };

// 「埋める」= 残った領域に合わせて拡大し、はみ出したぶんを切り取る表示。
// 下端のトレイが出ているあいだの見せ方で、中身が何かでは変えない。
describe("shouldFill", () => {
  it("何も出ていなければ全体表示のまま", () => {
    expect(shouldFill(none)).toBe(false);
  });

  // トレイは画面の半分近くを持っていく。残った隙間に16:9のデスクトップを
  // 収め直すと上下が真っ黒な余白になり、字も読めない大きさになる。
  it("下端に何か出ていれば埋める", () => {
    expect(shouldFill({ ...none, webKeyboard: 250 })).toBe(true);
    expect(shouldFill({ ...none, occluded: 300 })).toBe(true); // OSキーボード
    expect(shouldFill({ ...none, textInput: 60 })).toBe(true);
  });

  // 中身で変えてはいけない。マウスパネルだけ全体表示にしていた頃は、
  // キーボードと行き来するたびに映像が拡大と全体表示を往復して、同じ場所を
  // 見ているつもりでも見え方ごと変わっていた。カーソルは映像の方が追う
  // (input.ts の followCursor) ので、切り取られていても見失わない。
  it("マウスパネルでも同じように埋める", () => {
    expect(shouldFill({ ...none, mousePad: 136 })).toBe(true);
  });

  // トレイの高さは中身によらず同じなので、どちらが出ていても結果は変わらない。
  it("同時に出ていても埋める", () => {
    expect(shouldFill({ ...none, occluded: 300, mousePad: 136 })).toBe(true);
    expect(shouldFill({ ...none, webKeyboard: 250, mousePad: 250 })).toBe(true);
  });
});

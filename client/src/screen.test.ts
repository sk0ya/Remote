import { describe, it, expect } from "vitest";
import { shouldFill, settling, type Occlusion } from "./screen";

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

// OSキーボードは、入力欄にフォーカスしてから上がりきるまで、閉じてから
// 下がりきるまでに間がある。そのあいだに見えている領域は途中の姿で、画面の
// 3分の1ほどがこれから削られる / これから返ってくる。ここに合わせて映像を
// 置き直すと、落ち着いた時点でもう一度置き直すことになり、切り替えるたびに
// 映像が一瞬伸びて戻る (上限まで拡大したところを通ると位置まで巻き添えになる)。
describe("settling", () => {
  it("入力欄だけ出ていて、キーボードがまだ来ていないあいだ", () => {
    expect(settling({ ...none, textInput: 54 })).toBe(true);
  });

  // 入力欄を閉じても、キーボードが下がりきるまでは同じだけ覆われたまま。
  // ここで画面内のパネルを開くと、両方に削られた狭い領域が一瞬だけできる。
  it("入力欄を閉じたのに、キーボードがまだ下がっていないあいだ", () => {
    expect(settling({ ...none, occluded: 300 })).toBe(true);
    expect(settling({ ...none, occluded: 300, mousePad: 250 })).toBe(true);
  });

  it("入力欄とキーボードが揃っていれば、そこが本物の領域", () => {
    expect(settling({ ...none, textInput: 54, occluded: 300 })).toBe(false);
  });

  // 画面内のパネルは出した瞬間がそのまま最終の高さ。待つ理由がない。
  it("画面内のキーボード・マウスパネルは待たない", () => {
    expect(settling({ ...none, webKeyboard: 250 })).toBe(false);
    expect(settling({ ...none, mousePad: 250 })).toBe(false);
    expect(settling(none)).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { charStroke, textMessages, editMessages } from "./keyboard";

// 打鍵にすると、PC側のIMEがローマ字を受け取って変換できる。
// Unicode直接入力 (txt) だとIMEを素通りするので予測変換が効かない。
describe("charStroke", () => {
  it("英数字を打鍵にする", () => {
    expect(charStroke("k")).toEqual({ code: "KeyK", shift: false });
    expect(charStroke("A")).toEqual({ code: "KeyA", shift: true });
    expect(charStroke("7")).toEqual({ code: "Digit7", shift: false });
  });

  it("JISとUSで位置が同じ記号だけ打鍵にする", () => {
    expect(charStroke("-")).toEqual({ code: "Minus", shift: false });
    expect(charStroke(",")).toEqual({ code: "Comma", shift: false });
    // @ はJISでは別の位置にある。打鍵で送ると違う文字が入るのでnull。
    expect(charStroke("@")).toBeNull();
    expect(charStroke("あ")).toBeNull();
  });
});

describe("textMessages", () => {
  it("小文字は押して離すだけ", () => {
    expect(textMessages("ai")).toEqual([
      { t: "key", code: "KeyA", down: true },
      { t: "key", code: "KeyA", down: false },
      { t: "key", code: "KeyI", down: true },
      { t: "key", code: "KeyI", down: false },
    ]);
  });

  it("大文字はShiftで挟む", () => {
    expect(textMessages("K")).toEqual([
      { t: "key", code: "ShiftLeft", down: true },
      { t: "key", code: "KeyK", down: true },
      { t: "key", code: "KeyK", down: false },
      { t: "key", code: "ShiftLeft", down: false },
    ]);
  });

  // 絵文字やスマホIMEで確定したかなは打鍵にできない。落とさずUnicodeで送る。
  it("打鍵にできない文字は続くぶんをまとめてtxtにする", () => {
    expect(textMessages("a@#b")).toEqual([
      { t: "key", code: "KeyA", down: true },
      { t: "key", code: "KeyA", down: false },
      { t: "txt", s: "@#" },
      { t: "key", code: "KeyB", down: true },
      { t: "key", code: "KeyB", down: false },
    ]);
  });
});

describe("editMessages", () => {
  it("増えたぶんだけ打鍵にする", () => {
    expect(editMessages("ka", "kan")).toEqual([
      { t: "key", code: "KeyN", down: true },
      { t: "key", code: "KeyN", down: false },
    ]);
  });

  it("消えたぶんはBackspaceにする", () => {
    expect(editMessages("kan", "ka")).toEqual([
      { t: "key", code: "Backspace", down: true },
      { t: "key", code: "Backspace", down: false },
    ]);
  });

  it("違う末尾に差し替えたら、消してから打ち直す", () => {
    expect(editMessages("kan", "kai")).toEqual([
      { t: "key", code: "Backspace", down: true },
      { t: "key", code: "Backspace", down: false },
      { t: "key", code: "KeyI", down: true },
      { t: "key", code: "KeyI", down: false },
    ]);
  });

  it("変化なしなら何も送らない", () => {
    expect(editMessages("kan", "kan")).toEqual([]);
  });

  // 全選択して消した、のような操作でPC側の関係ない文字まで消さないようにする。
  it("Backspaceは上限で頭打ちにする", () => {
    const back = editMessages("x".repeat(100), "").filter((m) => (m as { down: boolean }).down);
    expect(back).toHaveLength(32);
  });
});

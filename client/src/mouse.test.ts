import { describe, it, expect } from "vitest";
import {
  MOUSE_KEYS,
  HOLD_LABEL,
  scrollNotches,
  isRub,
  SCROLL_PX_PER_NOTCH,
  type MouseKey,
} from "./mouse";

const ALL: MouseKey[] = Object.values(MOUSE_KEYS);

describe("マウス操作パネルのキー", () => {
  it("どのキーもちょうど1つの役目を持つ", () => {
    for (const k of ALL) {
      const roles = [k.click, k.hold].filter(Boolean).length;
      expect(roles, `${k.label} の役目が ${roles} 個`).toBe(1);
    }
  });

  // ジェスチャで狙って出せなかった操作を出すためのパネルなので、これが欠けたら意味がない。
  it("右・中・ダブルクリックとつまみがある", () => {
    expect(MOUSE_KEYS.right.click).toEqual({ b: 2 });
    expect(MOUSE_KEYS.middle.click).toEqual({ b: 1 });
    expect(MOUSE_KEYS.double.click).toEqual({ b: 0, times: 2 });
    expect(ALL.filter((k) => k.hold).length).toBe(1);
  });

  // 掴んでいるかはPC側の画面を見るまで分からないので、キートップで見分ける。
  it("つまみキーのラベルは押す前後で変わる", () => {
    expect(HOLD_LABEL.on).not.toBe(HOLD_LABEL.off);
    expect(MOUSE_KEYS.hold.label).toBe(HOLD_LABEL.off);
  });
});

// 矢印ボタンだと1回1ノッチで、長い文書は連射待ちになる。面をなぞったぶんを送る。
describe("scrollNotches", () => {
  const N = SCROLL_PX_PER_NOTCH;

  // 向きは映像の2本指スクロールと揃える —「中身を指で押しやる」側。
  // 同じアプリの中で面と映像で逆に動くと、どちらを触っているかで手が迷う。
  it("指を下へなぞると上スクロール、右へなぞると左スクロール", () => {
    expect(scrollNotches(0, N * 3).dy).toBe(3); // 正のdy = ホイール前回し = 上へ
    expect(scrollNotches(0, -N * 3).dy).toBe(-3);
    expect(scrollNotches(N * 3, 0).dx).toBe(-3); // 正のdx = 右へスクロール
    expect(scrollNotches(-N * 3, 0).dx).toBe(3);
  });

  // 1ノッチに満たない指のぶれで送ると、触れただけで画面が動いてしまう。
  it("1ノッチに満たない動きでは送らない", () => {
    expect(scrollNotches(0, 0)).toEqual({ dx: 0, dy: 0 });
    expect(scrollNotches(N - 1, -(N - 1))).toEqual({ dx: 0, dy: 0 });
    expect(scrollNotches(-(N - 1), N - 1)).toEqual({ dx: 0, dy: 0 });
  });

  // 端数は切り捨てて呼び出し側が持ち越す。四捨五入すると、行きと帰りで
  // 同じ位置に戻らない (半ノッチずつ余分に送られる)。
  it("端数は切り捨てる", () => {
    expect(scrollNotches(0, N * 2 + N - 1).dy).toBe(2);
    expect(scrollNotches(-(N * 2 + N - 1), 0).dx).toBe(2);
  });
});

// 面を触ったのが「回した」のか「押した(中クリック)」のかの判定。
describe("isRub", () => {
  // これがこの判定を入れた理由。1ノッチ(12px)に届かない11pxのなぞりは、
  // 回りはしないが「押した」でもない。ここで中クリックを出すとWindowsが
  // 自動スクロールに入り、以後カーソルを動かすたびに画面が流れる。
  it("1ノッチに満たないなぞりも「なぞった」と見なす", () => {
    expect(scrollNotches(0, 11).dy).toBe(0); // 回らない
    expect(isRub(0, 11)).toBe(true); // それでも中クリックにはしない
  });

  it("指を置いて離しただけなら押したと見なす", () => {
    expect(isRub(0, 0)).toBe(false);
    expect(isRub(3, 3)).toBe(false); // 指のわずかなぶれ
  });

  it("斜めのなぞりも距離で見る", () => {
    expect(isRub(6, 6)).toBe(true); // 8.49px
    expect(isRub(5, 5)).toBe(false); // 7.07px
  });
});

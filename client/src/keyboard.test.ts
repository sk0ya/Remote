import { describe, it, expect } from "vitest";
import { ABC_ROWS, NUM_ROWS, OP_ROWS, MIC_KEY, MODIFIERS, rowUnits, type Key } from "./keyboard";

const LAYERS: Record<string, Key[][]> = { 文字面: ABC_ROWS, "数字・記号面": NUM_ROWS };
const ALL = [...ABC_ROWS, ...NUM_ROWS, ...OP_ROWS].flat();

describe("面の切り替え", () => {
  // 切り替えで高さが動くと、そのぶん映像の領域も伸び縮みして落ち着かない。
  it("どちらの面も同じ段数", () => {
    expect(NUM_ROWS.length).toBe(ABC_ROWS.length);
  });

  it("操作段はどちらの面にも属さない", () => {
    const layerCodes = new Set([...ABC_ROWS, ...NUM_ROWS].flat().map((k) => k.code));
    for (const k of OP_ROWS.flat()) {
      if (k.layer) continue;
      expect(layerCodes.has(k.code), `${k.label} が面の中にもある`).toBe(false);
    }
  });

  // Enterは面をまたいで同じところ(2段目の右端)に出す。
  it("Enterはどちらの面でも2段目の右端", () => {
    for (const [name, rows] of Object.entries(LAYERS)) {
      const row = rows[1];
      expect(row[row.length - 1].code, name).toBe("Enter");
    }
  });
});

describe("キーの重複", () => {
  it("同じキーを2か所に置かない", () => {
    for (const [name, rows] of Object.entries(LAYERS)) {
      const codes = [...rows.flat(), ...OP_ROWS.flat()].map((k) => k.code).filter(Boolean);
      expect(new Set(codes).size, `${name}に重複がある`).toBe(codes.length);
    }
  });
});

describe("キーの幅", () => {
  // 段の合計に対する比がそのまま画面上の幅になる。細すぎると隣を押す。
  // 幅390pxの端末で、文字キーが約33px・Fキーが約28pxになる線。
  it("細すぎるキーが無い", () => {
    for (const keys of [...ABC_ROWS, ...NUM_ROWS, ...OP_ROWS]) {
      const units = rowUnits(keys);
      for (const k of keys) {
        expect((k.w ?? 1) / units, `${k.label} が細い`).toBeGreaterThanOrEqual(1 / 12);
      }
    }
  });

  // 矢印は候補選択とスクロールで一番使うので、同じ段の修飾キーより広く取る。
  it("矢印は操作段でいちばん広い", () => {
    const ops = OP_ROWS[1];
    const arrow = ops.find((k) => k.code === "ArrowLeft")!;
    for (const k of ops) {
      if (k.code.startsWith("Arrow") || k.code === "Space") continue;
      expect(k.w ?? 1, `${k.label} が矢印より広い`).toBeLessThanOrEqual(arrow.w!);
    }
  });
});

describe("キーの役割", () => {
  it("押しっぱなしで動かしたいキーは連射できる", () => {
    const repeating = new Set(ALL.filter((k) => k.repeat).map((k) => k.code));
    for (const code of [
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Backspace",
      "Delete",
      "Space",
    ]) {
      expect(repeating.has(code), `${code} が連射できない`).toBe(true);
    }
  });

  // 修飾キーは押しっぱなしで残るので、離す側の一覧から漏れると押されたままになる。
  it("修飾キーはすべて解除の対象に入っている", () => {
    const mods = ALL.filter((k) => k.mod).map((k) => k.code);
    expect([...MODIFIERS].sort()).toEqual([...new Set(mods)].sort());
    expect(MODIFIERS).toContain("ShiftLeft");
    expect(MODIFIERS).toContain("ControlLeft");
    expect(MODIFIERS).toContain("AltLeft");
    expect(MODIFIERS).toContain("MetaLeft");
  });

  // 修飾キーと矢印は面を切り替えずに打てること (Ctrl+C も候補選択も文字面のまま)
  // 半角/全角 (Backquote) も、日本語を打つ途中で面を往復せずに切り替えたい。
  it("修飾キー・矢印・編集キーは操作段にある", () => {
    const ops = new Set(OP_ROWS.flat().map((k) => k.code));
    for (const code of [
      "ControlLeft",
      "AltLeft",
      "ShiftLeft",
      "MetaLeft",
      "Escape",
      "Tab",
      "Backspace",
      "Delete",
      "Backquote",
      "ArrowLeft",
      "ArrowRight",
      "ArrowUp",
      "ArrowDown",
      "Space",
    ]) {
      expect(ops.has(code), `${code} が操作段に無い`).toBe(true);
    }
  });

  it("面の切り替えキーは1つだけで、PCへ送るコードを持たない", () => {
    const layerKeys = ALL.filter((k) => k.layer);
    expect(layerKeys).toHaveLength(1);
    expect(layerKeys[0].code).toBe("");
  });

  it("F1からF12まで揃っている", () => {
    const codes = new Set(ALL.map((k) => k.code));
    for (let i = 1; i <= 12; i++) expect(codes.has(`F${i}`), `F${i} が無い`).toBe(true);
  });
});

// キーボードを出すと映像の上の🎤は引っ込むので、代わりが操作段に要る。
describe("音声入力のキー", () => {
  it("🎤は操作段に1つだけあり、PCへ送るコードを持たない", () => {
    const mics = ALL.filter((k) => k.mic);
    expect(mics).toEqual([MIC_KEY]);
    expect(MIC_KEY.code).toBe("");
    expect(OP_ROWS.flat()).toContain(MIC_KEY);
  });

  // 押しっぱなしにするキーなので、同じ段のキーより広く取る。
  it("🎤は同じ段の他のキーより狭くない", () => {
    const row = OP_ROWS.find((keys) => keys.includes(MIC_KEY))!;
    for (const k of row) {
      if (k === MIC_KEY || k.code === "Backspace") continue;
      expect(k.w ?? 1, `${k.label} が🎤より広い`).toBeLessThanOrEqual(MIC_KEY.w!);
    }
  });

  // 音声非対応のブラウザでは段から取り除く。隠すと段に空きマスが残るため。
  it("🎤を外しても段の幅の比が破綻しない", () => {
    const row = OP_ROWS.find((keys) => keys.includes(MIC_KEY))!;
    const without = row.filter((k) => !k.mic);
    expect(without).not.toContain(MIC_KEY);
    expect(rowUnits(without)).toBeCloseTo(rowUnits(row) - MIC_KEY.w!, 5);
    for (const k of without) {
      expect((k.w ?? 1) / rowUnits(without)).toBeGreaterThanOrEqual(1 / 12);
    }
  });
});

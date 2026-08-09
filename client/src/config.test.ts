import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPcIme, savePcIme } from "./config";

function storage(initial: string | null = null): Storage {
  let value = initial;
  return {
    getItem: vi.fn(() => value),
    setItem: vi.fn((_key: string, next: string) => {
      value = next;
    }),
    removeItem: vi.fn(),
    clear: vi.fn(),
    key: vi.fn(() => null),
    length: 0,
  };
}

describe("PC側IME設定", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("未設定ならPC変換を既定にする", () => {
    vi.stubGlobal("localStorage", storage());
    expect(loadPcIme()).toBe(true);
  });

  it("スマホ変換を選んだ状態を保持する", () => {
    vi.stubGlobal("localStorage", storage());
    savePcIme(false);
    expect(loadPcIme()).toBe(false);
  });
});

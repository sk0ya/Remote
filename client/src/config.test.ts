import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

describe("config", () => {
  it("テスト対象の設定モジュールを読み込める", async () => {
    const config = await import("./config");
    expect(config.loadHostId).toBeTypeOf("function");
    expect(config.signalUrl).toBeTypeOf("function");
  });
});

// 最低限のStorageの替え玉
function fakeStorage(): Storage {
  const map = new Map<string, string>();
  return {
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
    clear: () => map.clear(),
    key: (i) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  } as Storage;
}

describe("再接続チケットの保持", () => {
  beforeEach(() => {
    vi.stubGlobal("sessionStorage", fakeStorage());
    vi.stubGlobal("localStorage", fakeStorage());
  });
  afterEach(() => vi.unstubAllGlobals());

  // 読み込み直すたびに生体認証をやり直させないための保持。
  it("書いたチケットを読み戻せる", async () => {
    const { saveTicket, loadTicket } = await import("./config");
    expect(loadTicket()).toBeNull();
    saveTicket("t0ken");
    expect(loadTicket()).toBe("t0ken");
  });

  it("失効したチケットは消せる", async () => {
    const { saveTicket, loadTicket, clearTicket } = await import("./config");
    saveTicket("t0ken");
    clearTicket();
    expect(loadTicket()).toBeNull();
  });

  // localStorageに置くと端末に残り続け、パスキーで守っている意味が薄れる。
  // タブを閉じれば消えることが、メモリだけに置いていた頃からの約束。
  it("localStorageには書かない", async () => {
    const { saveTicket } = await import("./config");
    saveTicket("t0ken");
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(1);
  });

  // プライベートモードではストレージ操作自体が例外を投げることがある。
  // そこで落ちると接続そのものができなくなる (毎回パスキーで認証すれば済む話)。
  it("ストレージが使えなくても落ちない", async () => {
    const broken = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    vi.stubGlobal("sessionStorage", broken);
    const { saveTicket, loadTicket, clearTicket } = await import("./config");
    expect(() => saveTicket("t0ken")).not.toThrow();
    expect(() => clearTicket()).not.toThrow();
    expect(loadTicket()).toBeNull();
  });
});

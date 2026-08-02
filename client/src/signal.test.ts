import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SignalChannel, PING_MS } from "./signal";

// 最低限のWebSocketの替え玉。送られた文字列を記録する。
class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  get pings() {
    return this.sent.filter((s) => s === "ping").length;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("location", { protocol: "https:", hostname: "example.test" });
  // setInterval は呼ばれた時点の(=偽の)タイマーへ委譲させる
  vi.stubGlobal("window", {
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: number) => clearInterval(id),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function open() {
  const ch = new SignalChannel("ROOM", {});
  ch.connect();
  const ws = FakeSocket.last!;
  ws.onopen?.();
  return { ch, ws };
}

describe("SignalChannel の keepalive", () => {
  it("開いているあいだは一定間隔でpingを送る", () => {
    const { ws } = open();
    vi.advanceTimersByTime(PING_MS * 3);
    expect(ws.pings).toBe(3);
  });

  // モバイル回線では25秒ごとのpingがモデムをアイドル状態に落とさない。
  // 画面を見ていないあいだ繋ぎっぱなしで放置されるのが電池切れの典型例だった。
  it("非表示のあいだはpingを止める", () => {
    const { ch, ws } = open();
    vi.advanceTimersByTime(PING_MS);
    expect(ws.pings).toBe(1);

    ch.setActive(false);
    vi.advanceTimersByTime(PING_MS * 5);
    expect(ws.pings).toBe(1); // 1本も増えない
  });

  it("表示に戻ったらpingを再開する", () => {
    const { ch, ws } = open();
    ch.setActive(false);
    vi.advanceTimersByTime(PING_MS * 5);
    ch.setActive(true);
    vi.advanceTimersByTime(PING_MS * 2);
    expect(ws.pings).toBe(2);
  });

  it("閉じたらpingを止める", () => {
    const { ch, ws } = open();
    ch.close();
    vi.advanceTimersByTime(PING_MS * 5);
    expect(ws.pings).toBe(0);
  });

  // 非表示のまま復帰待ちのタイマーだけが回り続けると、止めた意味がなくなる。
  it("非表示中に開き直してもpingは止まったまま", () => {
    const { ch } = open();
    ch.setActive(false);
    ch.connect();
    const ws2 = FakeSocket.last!;
    ws2.onopen?.();
    vi.advanceTimersByTime(PING_MS * 5);
    expect(ws2.pings).toBe(0);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SignalChannel,
  PING_MS,
  PONG_MISSES_BEFORE_DEAD,
  PONG_TIMEOUT_MS,
} from "./signal";

// 最低限のWebSocketの替え玉。送られた文字列を記録する。
class FakeSocket {
  static last: FakeSocket | null = null;
  static readonly OPEN = 1;
  readyState = 1;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  // サーバー(Worker)は "ping" にだけ "pong" を自動応答する。
  // 経路が死んだ場合を作るときだけ false にする。
  autoPong = true;
  constructor(public url: string) {
    FakeSocket.last = this;
  }
  send(data: string) {
    this.sent.push(data);
    if (data === "ping" && this.autoPong) this.onmessage?.({ data: "pong" });
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
  // setInterval/setTimeout は呼ばれた時点の(=偽の)タイマーへ委譲させる
  vi.stubGlobal("window", {
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: number) => clearInterval(id),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function open(events = {}) {
  const ch = new SignalChannel("ROOM", events);
  ch.connect();
  const ws = FakeSocket.last!;
  ws.onopen?.();
  return { ch, ws };
}

// 応答が返らない経路を作る (NATに流れを落とされた状態)
const goSilent = (ws: FakeSocket) => {
  ws.autoPong = false;
};

describe("SignalChannel の keepalive", () => {
  it("開いているあいだは一定間隔でpingを送る", () => {
    const { ws } = open();
    vi.advanceTimersByTime(PING_MS * 3);
    expect(ws.pings).toBe(3);
  });

  // モバイル回線では短い間隔のpingがモデムをアイドル状態に落とさない。
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
    ch.setActive(true); // 復帰の確認で1本
    vi.advanceTimersByTime(PING_MS * 2);
    expect(ws.pings).toBe(3);
  });

  it("閉じたらpingを止める", () => {
    const { ch, ws } = open();
    ch.close();
    vi.advanceTimersByTime(PING_MS * 5);
    expect(ws.pings).toBe(0);
  });

  // 非表示のまま開き直してもタイマーだけが回り続けると、止めた意味がなくなる。
  it("非表示中に開き直してもpingは止まったまま", () => {
    const { ch } = open();
    ch.setActive(false);
    ch.connect();
    const ws2 = FakeSocket.last!;
    ws2.onopen?.();
    vi.advanceTimersByTime(PING_MS * 5);
    expect(ws2.pings).toBe(0);
  });

  // 非表示のあいだは送らないので、応答が無いのは当たり前。
  // ここで切断とみなすと、眠っている端末が無意味に繋ぎ直しを始める。
  it("非表示のあいだは無応答でも切断とみなさない", () => {
    const onClose = vi.fn();
    const { ch } = open({ onClose });
    ch.setActive(false);
    vi.advanceTimersByTime(PING_MS * 10);
    expect(onClose).not.toHaveBeenCalled();
  });
});

// 経路が黙って死んでも readyState は OPEN のまま残る。応答を確かめないと、
// クライアントは死んだソケットへ接続要求を投げ、来ない返事を待ち続ける。
describe("SignalChannel の応答確認", () => {
  it("応答が連続して無ければソケットを畳んで切断を知らせる", () => {
    const onClose = vi.fn();
    const { ch, ws } = open({ onClose });
    goSilent(ws);

    vi.advanceTimersByTime(PING_MS); // ping送信
    expect(ws.pings).toBe(1);
    expect(onClose).not.toHaveBeenCalled(); // まだ待っている

    vi.advanceTimersByTime(PONG_TIMEOUT_MS + PING_MS * (PONG_MISSES_BEFORE_DEAD - 1));
    expect(onClose).toHaveBeenCalledOnce();
    expect(ch.open).toBe(false);
    expect(ws.readyState).toBe(3);
  });

  it("応答が返るあいだは畳まない", () => {
    const onClose = vi.fn();
    const { ch } = open({ onClose });
    vi.advanceTimersByTime((PING_MS + PONG_TIMEOUT_MS) * 5);
    expect(onClose).not.toHaveBeenCalled();
    expect(ch.open).toBe(true);
  });

  // pongに限らず、何か届いた時点で経路は生きている。
  it("pong以外のメッセージでも生存とみなす", () => {
    const onClose = vi.fn();
    const { ws } = open({ onClose });
    goSilent(ws);
    vi.advanceTimersByTime(PING_MS);
    ws.onmessage?.({ data: JSON.stringify({ type: "peer-joined", ip: "203.0.113.1" }) });
    vi.advanceTimersByTime(PONG_TIMEOUT_MS);
    expect(onClose).not.toHaveBeenCalled();
  });

  // 眠っているあいだに切られていることがあるので、次の定期pingを待たない。
  it("表示に戻った瞬間に生きているか確かめる", () => {
    const onClose = vi.fn();
    const { ch, ws } = open({ onClose });
    ch.setActive(false);
    vi.advanceTimersByTime(PING_MS * 10);
    goSilent(ws); // 眠っているあいだに落とされていた

    ch.setActive(true);
    expect(ws.pings).toBe(1); // 復帰した時点で即座に問い合わせる
    vi.advanceTimersByTime(PONG_TIMEOUT_MS + PING_MS * (PONG_MISSES_BEFORE_DEAD - 1));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("応答が無くて畳んだ後、ブラウザのcloseで二重に知らせない", () => {
    const onClose = vi.fn();
    const { ws } = open({ onClose });
    goSilent(ws);
    const browserClose = ws.onclose!; // 畳む前のハンドラを控える

    vi.advanceTimersByTime(PONG_TIMEOUT_MS + PING_MS * PONG_MISSES_BEFORE_DEAD);
    expect(onClose).toHaveBeenCalledOnce();

    browserClose({ code: 1006, reason: "" }); // 遅れて飛んでくるclose
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("自分で閉じたときは切断を知らせない", () => {
    const onClose = vi.fn();
    const { ch } = open({ onClose });
    ch.close();
    vi.advanceTimersByTime(PING_MS + PONG_TIMEOUT_MS);
    expect(onClose).not.toHaveBeenCalled();
  });

  // 前のソケットを残したまま張り直すと、あとから死んだ方のoncloseが飛んできて
  // 生きている接続まで畳みに行く。
  it("繋ぎ直すと前のソケットを切り離す", () => {
    const onClose = vi.fn();
    const { ch, ws } = open({ onClose });
    const stale = ws.onclose!;

    ch.connect();
    const fresh = FakeSocket.last!;
    fresh.onopen?.();
    expect(ws.readyState).toBe(3);
    expect(fresh).not.toBe(ws);

    stale({ code: 1006, reason: "" });
    expect(onClose).not.toHaveBeenCalled();
    expect(ch.open).toBe(true);
  });
});

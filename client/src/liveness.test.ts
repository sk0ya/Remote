import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  PeerProbe,
  PROBE_INTERVAL_MS,
  PROBE_MISSES_BEFORE_DEAD,
  PROBE_TIMEOUT_MS,
} from "./liveness";

beforeEach(() => {
  vi.useFakeTimers();
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

describe("PeerProbe", () => {
  it("生きているか聞いて、返事が無ければ死んだと知らせる", () => {
    const send = vi.fn();
    const onDead = vi.fn();
    new PeerProbe(send, onDead).start();

    expect(send).toHaveBeenCalledWith({ t: "ping" });
    expect(onDead).not.toHaveBeenCalled();

    vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    expect(onDead).toHaveBeenCalledOnce();
  });

  it("返事が来たら死んだとみなさない", () => {
    const onDead = vi.fn();
    const probe = new PeerProbe(vi.fn(), onDead);
    probe.start();
    probe.noteAlive();

    vi.advanceTimersByTime(PROBE_TIMEOUT_MS * 3);
    expect(onDead).not.toHaveBeenCalled();
  });

  // ホストからの通知は何であれ経路が生きている証拠になる。
  // pongだけを見ていると、映像や通知が流れていても死んだと誤判定しかねない。
  it("何度でも聞き直せる", () => {
    const send = vi.fn();
    const onDead = vi.fn();
    const probe = new PeerProbe(send, onDead);

    probe.start();
    probe.noteAlive();
    probe.start();
    expect(send).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    expect(onDead).toHaveBeenCalledOnce();
  });

  // 復帰のたびに聞くと、返事待ちのあいだに何度も問い合わせが積み上がる。
  it("返事待ちのあいだは重ねて聞かない", () => {
    const send = vi.fn();
    const onDead = vi.fn();
    const probe = new PeerProbe(send, onDead);

    probe.start();
    probe.start();
    probe.start();
    expect(send).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(PROBE_TIMEOUT_MS);
    expect(onDead).toHaveBeenCalledOnce();
  });

  // 画面を畳んだ後に「死んでいる」と言われても、繋ぎ直す先がもう無い。
  it("捨てた後は死亡を知らせない", () => {
    const onDead = vi.fn();
    const probe = new PeerProbe(vi.fn(), onDead);
    probe.start();
    probe.stop();

    vi.advanceTimersByTime(PROBE_TIMEOUT_MS * 3);
    expect(onDead).not.toHaveBeenCalled();
  });

  it("monitorは表示中の経路を定期的に確認する", () => {
    const send = vi.fn();
    const onDead = vi.fn();
    const probe = new PeerProbe(send, onDead);

    probe.monitor();
    expect(send).toHaveBeenCalledOnce();
    probe.noteAlive();

    vi.advanceTimersByTime(PROBE_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(2);
    probe.noteAlive();

    probe.stop();
    vi.advanceTimersByTime(PROBE_INTERVAL_MS * 2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(onDead).not.toHaveBeenCalled();
  });

  it("monitorは応答が無ければ監視を止めて死亡を知らせる", () => {
    const onDead = vi.fn();
    const probe = new PeerProbe(vi.fn(), onDead);

    probe.monitor();
    vi.advanceTimersByTime(
      PROBE_TIMEOUT_MS * PROBE_MISSES_BEFORE_DEAD +
        PROBE_INTERVAL_MS * (PROBE_MISSES_BEFORE_DEAD - 1)
    );
    expect(onDead).toHaveBeenCalledOnce();

    vi.advanceTimersByTime(PROBE_INTERVAL_MS * 2);
    expect(onDead).toHaveBeenCalledOnce();
  });
});

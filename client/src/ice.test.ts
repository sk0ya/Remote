import { describe, expect, it, vi } from "vitest";
import { IceCandidateRelay } from "./ice";

const candidate = (value: string): RTCIceCandidateInit => ({
  candidate: value,
  sdpMid: "0",
  sdpMLineIndex: 0,
});

describe("IceCandidateRelay", () => {
  it("answer前の候補を保持し、answer送信後に全件を順番どおり送る", () => {
    const send = vi.fn();
    const relay = new IceCandidateRelay(send);
    const first = candidate("candidate:first");
    const second = candidate("candidate:second");

    relay.add(first);
    relay.add(second);
    expect(send).not.toHaveBeenCalled();

    relay.markAnswerSent();
    expect(send.mock.calls).toEqual([[first], [second]]);
  });

  it("answer送信後に集まった候補は待たずに送る", () => {
    const send = vi.fn();
    const relay = new IceCandidateRelay(send);
    relay.markAnswerSent();

    const late = candidate("candidate:late");
    relay.add(late);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith(late);
  });

  it("answer送信通知が重複しても候補を再送しない", () => {
    const send = vi.fn();
    const relay = new IceCandidateRelay(send);
    relay.add(candidate("candidate:once"));

    relay.markAnswerSent();
    relay.markAnswerSent();
    expect(send).toHaveBeenCalledOnce();
  });
});

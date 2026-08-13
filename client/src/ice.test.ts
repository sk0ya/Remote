import { describe, expect, it, vi } from "vitest";
import { CandidateGate } from "./ice";

const candidate = (value: string): RTCIceCandidateInit => ({
  candidate: value,
  sdpMid: "0",
  sdpMLineIndex: 0,
});

describe("CandidateGate", () => {
  it("開く前の候補を保持し、開いたら全件を順番どおり流す", () => {
    const flush = vi.fn();
    const gate = new CandidateGate(flush);
    const first = candidate("candidate:first");
    const second = candidate("candidate:second");

    gate.add(first);
    gate.add(second);
    expect(flush).not.toHaveBeenCalled();

    gate.open();
    expect(flush.mock.calls).toEqual([[first], [second]]);
  });

  it("開いた後に集まった候補は待たずに流す", () => {
    const flush = vi.fn();
    const gate = new CandidateGate(flush);
    gate.open();

    const late = candidate("candidate:late");
    gate.add(late);
    expect(flush).toHaveBeenCalledOnce();
    expect(flush).toHaveBeenCalledWith(late);
  });

  it("開く通知が重複しても候補を再送しない", () => {
    const flush = vi.fn();
    const gate = new CandidateGate(flush);
    gate.add(candidate("candidate:once"));

    gate.open();
    gate.open();
    expect(flush).toHaveBeenCalledOnce();
  });

  // 受ける側の使い方。ホストはtrickleで候補を送ってくるので、offerの
  // setRemoteDescription を待つあいだに届いたものを捨ててはいけない。
  it("開くまでに何件溜まっても取りこぼさない", () => {
    const flush = vi.fn();
    const gate = new CandidateGate(flush);
    const all = ["a", "b", "c", "d", "e"].map(candidate);

    for (const c of all) gate.add(c);
    gate.open();
    expect(flush.mock.calls.map(([c]) => c)).toEqual(all);
  });
});

import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { SignalEvents } from "./signal";
import { PROTOCOL_VERSION } from "./protocol";

const state = vi.hoisted(() => ({ events: null as SignalEvents | null, sent: [] as any[] }));
vi.mock("./signal", () => ({ SignalChannel: class {
  open = true;
  constructor(_id: string, events: SignalEvents) { state.events = events; }
  connect() { state.events!.onOpen?.("", true); }
  send(message: any) { state.sent.push(message); return true; }
  close() {}
} }));
vi.mock("./screen", () => ({ attachScreenLayout: () => ({ dispose() {} }) }));
vi.mock("./config", () => ({ loadTicket: () => "ticket", loadCredId: () => null, clearTicket() {}, saveTicket() {}, saveCredId() {} }));
const auth = vi.hoisted(() => ({ mac: vi.fn(), passkey: vi.fn() }));
vi.mock("./webauthn", () => ({ ticketMAC: auth.mac, b64uDecode: () => new Uint8Array(), assertPasskey: auth.passkey }));
import { renderViewer } from "./viewer";

class Peer {
  static all: Peer[] = [];
  connectionState = "connecting";
  localDescription = { sdp: "answer" };
  onconnectionstatechange?: () => void;
  constructor() { Peer.all.push(this); }
  async setRemoteDescription() {}
  async createAnswer() { return { sdp: "answer" }; }
  async setLocalDescription() {}
  close() { this.connectionState = "closed"; }
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const offer = async () => {
  state.events!.onMessage?.({ t: "offer", sdp: "offer", nonce: "nonce", v: PROTOCOL_VERSION }, "");
  await flush();
};
beforeEach(() => {
  vi.useFakeTimers();
  state.sent = [];
  Peer.all = [];
  auth.mac.mockReset();
  auth.mac.mockResolvedValue("mac");
  auth.passkey.mockReset();
  auth.passkey.mockResolvedValue({ credId: "cred", clientData: "c", authData: "a", sig: "s" });
  vi.stubGlobal("window", { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("document", { getElementById: () => ({ classList: { toggle() {} } }), addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal("RTCPeerConnection", Peer);
  renderViewer({ innerHTML: "" } as HTMLElement, "host");
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("does not restart an offer while its P2P route is still being discovered", async () => {
  await offer();
  await vi.advanceTimersByTimeAsync(12_000);
  expect(state.sent.filter(m => m.t === "connect")).toHaveLength(1);
  expect(Peer.all[0].connectionState).toBe("connecting");
});
it("retries a stalled P2P search after its own deadline", async () => {
  await offer();
  await vi.advanceTimersByTimeAsync(31_000);
  expect(Peer.all[0].connectionState).toBe("closed");
  expect(state.sent.filter(m => m.t === "connect")).toHaveLength(2);
});
it("does not apply the P2P deadline to an open authentication dialog", async () => {
  auth.mac.mockReturnValue(new Promise(() => {}));
  await offer();
  const peer = Peer.all[0];
  peer.connectionState = "connected";
  peer.onconnectionstatechange!();
  await vi.advanceTimersByTimeAsync(31_000);
  expect(peer.connectionState).toBe("connected");
  expect(state.sent.filter(m => m.t === "connect")).toHaveLength(1);
});
it("ignores an authentication failure belonging to a replaced peer", async () => {
  let reject!: (error: Error) => void;
  auth.mac.mockReturnValueOnce(new Promise((_resolve, fail) => { reject = fail; }));
  await offer();
  Peer.all[0].connectionState = "connected";
  Peer.all[0].onconnectionstatechange!();
  await offer();
  reject(new Error("old authentication"));
  await flush();
  expect(Peer.all[1].connectionState).toBe("connecting");
});

it("falls back to the passkey on the same peer when the ticket has expired", async () => {
  await offer();
  const peer = Peer.all[0];
  peer.connectionState = "connected";
  peer.onconnectionstatechange!();
  await flush();
  expect(state.sent.filter(m => m.t === "auth")).toEqual([expect.objectContaining({ mac: "mac" })]);
  state.events!.onMessage?.({ t: "error", reason: "auth", passkey: true }, "");
  await flush();
  expect(auth.passkey).toHaveBeenCalledTimes(1);
  expect(state.sent.filter(m => m.t === "auth")).toHaveLength(2);
  expect(state.sent.at(-1)).toMatchObject({ t: "auth", credId: "cred" });
  expect(peer.connectionState).toBe("connected");
  expect(state.sent.filter(m => m.t === "connect")).toHaveLength(1);
});
it("starts over from a connect request when the host did not keep the peer", async () => {
  await offer();
  Peer.all[0].connectionState = "connected";
  Peer.all[0].onconnectionstatechange!();
  await flush();
  state.events!.onMessage?.({ t: "error", reason: "auth" }, "");
  await vi.advanceTimersByTimeAsync(600);
  expect(Peer.all[0].connectionState).toBe("closed");
  expect(auth.passkey).not.toHaveBeenCalled();
  expect(state.sent.filter(m => m.t === "connect")).toHaveLength(2);
});

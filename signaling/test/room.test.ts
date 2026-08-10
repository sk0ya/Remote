import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

let sequence = 0;

function room(): string {
  sequence++;
  return `test-room-${sequence}`;
}

function nextEvent<K extends keyof WebSocketEventMap>(
  socket: WebSocket,
  type: K
): Promise<WebSocketEventMap[K]> {
  return new Promise((resolve) => {
    socket.addEventListener(type, (event) => resolve(event), { once: true });
  });
}

async function nextJSON(socket: WebSocket): Promise<Record<string, unknown>> {
  const event = await nextEvent(socket, "message");
  return JSON.parse(String(event.data)) as Record<string, unknown>;
}

async function connect(roomName: string, role: "host" | "client"): Promise<WebSocket> {
  const response = await SELF.fetch(
    `https://example.test/ws?room=${encodeURIComponent(roomName)}&role=${role}`,
    { headers: { Upgrade: "websocket" } }
  );
  expect(response.status).toBe(101);
  if (!response.webSocket) throw new Error("WebSocket upgrade response expected");
  response.webSocket.accept();
  return response.webSocket;
}

describe("signaling room", () => {
  it("rejects invalid room and role parameters", async () => {
    expect((await SELF.fetch("https://example.test/ws?room=short&role=host")).status).toBe(400);
    expect((await SELF.fetch("https://example.test/ws?room=valid-room&role=other")).status).toBe(400);
    expect((await SELF.fetch("https://example.test/not-ws")).status).toBe(200);
  });

  it("reports peer presence and notifies the existing peer of joins", async () => {
    const name = room();
    const host = await connect(name, "host");
    expect(await nextJSON(host)).toMatchObject({ type: "hello", peerPresent: false });

    const joined = nextJSON(host);
    const client = await connect(name, "client");
    expect(await nextJSON(client)).toMatchObject({ type: "hello", peerPresent: true });
    expect(await joined).toMatchObject({ type: "peer-joined", role: "client" });

    host.close(1000, "done");
    client.close(1000, "done");
  });

  it("relays connect, answer, candidate, and auth messages without changing their JSON", async () => {
    const name = room();
    const host = await connect(name, "host");
    await nextJSON(host);
    const joined = nextJSON(host);
    const client = await connect(name, "client");
    await nextJSON(client);
    await joined;

    const messages = [
      { t: "connect", v: 1 },
      { t: "answer", v: 1, sdp: "answer-sdp" },
      {
        t: "candidate",
        v: 1,
        candidate: { candidate: "candidate:1 1 UDP 1 192.0.2.1 5000 typ host", sdpMid: "0" },
      },
      { t: "auth", v: 1, credId: "credential", sig: "signature" },
    ];

    for (const message of messages) {
      const received = nextJSON(host);
      client.send(JSON.stringify(message));
      const envelope = await received;
      expect(envelope).toMatchObject({ type: "relay", from: "client" });
      expect(JSON.parse(String(envelope.msg))).toEqual(message);
    }

    host.close(1000, "done");
    client.close(1000, "done");
  });

  it("returns peer-absent instead of silently dropping a message", async () => {
    const client = await connect(room(), "client");
    await nextJSON(client);
    const absent = nextJSON(client);
    client.send(JSON.stringify({ t: "connect", v: 1 }));
    expect(await absent).toEqual({ type: "peer-absent" });
    client.close(1000, "done");
  });

  it("notifies the remaining peer when the other role genuinely leaves", async () => {
    const name = room();
    const host = await connect(name, "host");
    await nextJSON(host);
    const joined = nextJSON(host);
    const client = await connect(name, "client");
    await nextJSON(client);
    await joined;

    const left = nextJSON(host);
    client.close(1000, "done");
    expect(await left).toMatchObject({ type: "peer-left", role: "client" });
    host.close(1000, "done");
  });

  it("replaces the same role without falsely notifying the opposite peer that it left", async () => {
    const name = room();
    const host = await connect(name, "host");
    await nextJSON(host);
    const firstJoined = nextJSON(host);
    const first = await connect(name, "client");
    await nextJSON(first);
    await firstJoined;
    const closed = nextEvent(first, "close");

    const replacementJoined = nextJSON(host);
    const second = await connect(name, "client");
    await nextJSON(second);
    expect(await replacementJoined).toMatchObject({ type: "peer-joined", role: "client" });
    const event = await closed;
    expect(event.code).toBe(4000);
    expect(event.reason).toBe("replaced");

    // 古いsocketのclose処理が遅れて到着してもpeer-leftを挟まず、
    // 新しいsocketからのメッセージがそのまま届くことを確認する。
    const relayed = nextJSON(host);
    second.send(JSON.stringify({ t: "replacement-alive" }));
    expect(await relayed).toMatchObject({ type: "relay", from: "client" });

    host.close(1000, "done");
    second.close(1000, "done");
  });

  it("answers keepalive ping without waking message relay logic", async () => {
    const socket = await connect(room(), "client");
    await nextJSON(socket);
    const pong = nextEvent(socket, "message");
    socket.send("ping");
    expect((await pong).data).toBe("pong");
    socket.close(1000, "done");
  });
});

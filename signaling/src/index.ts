// リモートデスクトップ用シグナリング中継。
// hostId 毎に Durable Object の「部屋」を作り、host / client の
// 2本のWebSocket間でJSONメッセージを素通しする。認証・秘密情報は
// 一切持たず、各接続の観測グローバルIPを付与するだけ。

export interface Env {
  ROOM: DurableObjectNamespace;
}

const MAX_MSG_BYTES = 64 * 1024;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ws") {
      const room = url.searchParams.get("room");
      const role = url.searchParams.get("role");
      if (!room || !/^[A-Za-z0-9_-]{8,64}$/.test(room) || (role !== "host" && role !== "client")) {
        return new Response("bad request", { status: 400 });
      }
      const id = env.ROOM.idFromName(room);
      return env.ROOM.get(id).fetch(request);
    }
    return new Response("remote-signaling ok");
  },
} satisfies ExportedHandler<Env>;

type Role = "host" | "client";
interface Attachment {
  role: Role;
  ip: string;
}

export class Room implements DurableObject {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const role = url.searchParams.get("role") as Role;
    const ip = request.headers.get("CF-Connecting-IP") ?? "";

    // 同一ロールの既存接続は置き換える(host再起動・クライアント再読込対応)
    for (const ws of this.state.getWebSockets(role)) {
      ws.close(4000, "replaced");
    }

    const pair = new WebSocketPair();
    const [clientEnd, serverEnd] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(serverEnd, [role]);
    serverEnd.serializeAttachment({ role, ip } satisfies Attachment);

    serverEnd.send(
      JSON.stringify({ type: "hello", ip, peerPresent: this.peer(role) !== null })
    );
    this.peer(role)?.send(JSON.stringify({ type: "peer-joined", role, ip }));

    return new Response(null, { status: 101, webSocket: clientEnd });
  }

  private peer(myRole: Role): WebSocket | null {
    const others = this.state.getWebSockets(myRole === "host" ? "client" : "host");
    return others.length > 0 ? others[0] : null;
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string" || message.length > MAX_MSG_BYTES) return;
    const att = ws.deserializeAttachment() as Attachment;
    const peer = this.peer(att.role);
    if (!peer) {
      ws.send(JSON.stringify({ type: "peer-absent" }));
      return;
    }
    // msg はJSON文字列のまま素通し。中身の解釈は両端末が行う。
    peer.send(JSON.stringify({ type: "relay", from: att.role, ip: att.ip, msg: message }));
  }

  webSocketClose(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (att) {
      this.peer(att.role)?.send(JSON.stringify({ type: "peer-left", role: att.role }));
    }
  }
}

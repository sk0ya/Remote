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
  // 新しい同ロール接続に蹴られた古いソケット。閉じても「相手が退室した」ではない。
  replaced?: boolean;
}

// keepalive。待機中のシグナリングは完全に無通信になるため、経路上のNATや
// 中継にアイドルとみなされて切られる。この文字列だけは webSocketMessage を
// 起こさずランタイムが "pong" を返す(ハイバネーションも解除されない)。
const PING = "ping";
const PONG = "pong";

// WebSocket.READY_STATE_OPEN 相当。閉じかけのソケットを避けるのに使う。
const WS_OPEN = 1;

export class Room implements DurableObject {
  constructor(private state: DurableObjectState) {
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const url = new URL(request.url);
    const role = url.searchParams.get("role") as Role;
    const ip = request.headers.get("CF-Connecting-IP") ?? "";

    // 同一ロールの既存接続は置き換える(host再起動・クライアント再読込対応)。
    // 印を付けてから閉じる: closeイベントは新しい接続が入室した後に届くことがあり、
    // そのまま peer-left を流すと繋がったばかりの相手を切断扱いにしてしまう。
    for (const ws of this.state.getWebSockets(role)) {
      const att = ws.deserializeAttachment() as Attachment | null;
      if (att) ws.serializeAttachment({ ...att, replaced: true } satisfies Attachment);
      ws.close(4000, "replaced");
    }

    const pair = new WebSocketPair();
    const [clientEnd, serverEnd] = Object.values(pair) as [WebSocket, WebSocket];
    this.state.acceptWebSocket(serverEnd, [role]);
    serverEnd.serializeAttachment({ role, ip } satisfies Attachment);

    const peer = this.peer(role);
    send(serverEnd, { type: "hello", ip, peerPresent: peer !== null });
    if (peer) send(peer, { type: "peer-joined", role, ip });

    return new Response(null, { status: 101, webSocket: clientEnd });
  }

  // そのロールの「生きている」ソケット。蹴った直後の古いソケットは close が
  // 完了するまで一覧に残るので、置き換え済みと閉じかけを除いて数える。
  private live(role: Role): WebSocket[] {
    return this.state.getWebSockets(role).filter((ws) => {
      const att = ws.deserializeAttachment() as Attachment | null;
      return !att?.replaced && ws.readyState === WS_OPEN;
    });
  }

  // 相手ロールの現在の接続。素朴に先頭を取ると、繋ぎ直したばかりの相手ではなく
  // 死にかけの方へ送ってしまう(ホストが再接続した直後の接続要求が届かず、
  // 無反応に見える原因だった)。
  private peer(myRole: Role): WebSocket | null {
    const live = this.live(myRole === "host" ? "client" : "host");
    // 同着なら新しい方(後から入室した方)を採る
    return live.length > 0 ? live[live.length - 1] : null;
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string" || message.length > MAX_MSG_BYTES) return;
    // 自動応答が効かない経路(古いクライアント等)から来たpingもここで落とす
    if (message === PING) {
      send(ws, PONG);
      return;
    }
    const att = ws.deserializeAttachment() as Attachment;
    const peer = this.peer(att.role);
    if (!peer) {
      send(ws, { type: "peer-absent" });
      return;
    }
    // msg はJSON文字列のまま素通し。中身の解釈は両端末が行う。
    send(peer, { type: "relay", from: att.role, ip: att.ip, msg: message });
  }

  webSocketClose(ws: WebSocket) {
    this.notifyLeft(ws);
  }

  webSocketError(ws: WebSocket) {
    this.notifyLeft(ws);
  }

  // 相手に退室を伝える。ただし置き換えられた古いソケットと、
  // 同ロールの接続がまだ残っている場合は伝えない(繋がっている側を切らせないため)。
  private notifyLeft(ws: WebSocket) {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att || att.replaced) return;
    if (this.live(att.role).some((other) => other !== ws)) return;
    const peer = this.peer(att.role);
    if (peer) send(peer, { type: "peer-left", role: att.role });
  }
}

// 閉じかけのソケットへの送信は例外を投げる。ここで throw すると
// 中継そのものが落ちるので、届かなかったことは黙って受け入れる。
function send(ws: WebSocket, payload: unknown): void {
  try {
    ws.send(typeof payload === "string" ? payload : JSON.stringify(payload));
  } catch {
    /* 相手はもう居ない */
  }
}

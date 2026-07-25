// シグナリングサーバー(Cloudflare Worker)へのWebSocket接続。
// サーバーは {type:"relay", from, ip, msg} で相手のメッセージを包んで届ける。

import { SIGNAL_URL } from "./config";

export interface SignalEvents {
  onOpen?: (selfIp: string, peerPresent: boolean) => void;
  onPeerJoined?: (ip: string) => void;
  onPeerLeft?: () => void;
  onMessage?: (msg: unknown, peerIp: string) => void;
  onClose?: (reason: string) => void;
}

export class SignalChannel {
  private ws: WebSocket | null = null;
  private closed = false;

  constructor(
    private room: string,
    private events: SignalEvents
  ) {}

  connect(): void {
    this.closed = false;
    const url = `${SIGNAL_URL}?room=${encodeURIComponent(this.room)}&role=client`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onmessage = (ev) => {
      let data: any;
      try {
        data = JSON.parse(ev.data as string);
      } catch {
        return;
      }
      switch (data.type) {
        case "hello":
          this.events.onOpen?.(data.ip, data.peerPresent);
          break;
        case "peer-joined":
          this.events.onPeerJoined?.(data.ip);
          break;
        case "peer-left":
          this.events.onPeerLeft?.();
          break;
        case "relay":
          try {
            this.events.onMessage?.(JSON.parse(data.msg), data.ip);
          } catch {
            /* 不正なJSONは無視 */
          }
          break;
      }
    };
    ws.onclose = (ev) => {
      this.ws = null;
      if (!this.closed) this.events.onClose?.(ev.reason || `code ${ev.code}`);
    };
  }

  // 送れたらtrue、ソケットが閉じていればfalse。
  // 部屋は role ごとに1本で、後から来た接続が先客を蹴り出す(close 4000 "replaced")。
  // 黙って捨てると呼び出し側が来ない応答を待ち続けるので、必ず結果を返す。
  send(msg: unknown): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(JSON.stringify(msg));
    return true;
  }

  close(): void {
    this.closed = true;
    this.ws?.close();
    this.ws = null;
  }
}

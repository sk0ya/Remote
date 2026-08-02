// シグナリングサーバー(Cloudflare Worker)へのWebSocket接続。
// サーバーは {type:"relay", from, ip, msg} で相手のメッセージを包んで届ける。

import { signalUrl } from "./config";

export interface SignalEvents {
  onOpen?: (selfIp: string, peerPresent: boolean) => void;
  onPeerJoined?: (ip: string) => void;
  onPeerLeft?: () => void;
  // 送ったメッセージが「相手が居ない」と突き返された。
  // 拾わないと、来ない返事をタイムアウトまで待つことになる。
  onPeerAbsent?: () => void;
  onMessage?: (msg: unknown, peerIp: string) => void;
  onClose?: (reason: string) => void;
}

// keepalive間隔。モバイル回線のNATや中継は無通信のWebSocketを黙って切る。
// サーバーはこの文字列にだけ "pong" を自動応答する。
export const PING_MS = 25_000;

export class SignalChannel {
  private ws: WebSocket | null = null;
  private closed = false;
  private pingTimer = 0;
  // 画面を見ているあいだだけ true。非表示のあいだのpingは、誰も待っていない
  // 通信のためにモバイル回線のモデムをアイドル状態から起こし続けるだけになる。
  private activeState = true;

  constructor(
    private room: string,
    private events: SignalEvents
  ) {}

  connect(): void {
    this.closed = false;
    const url = `${signalUrl()}?room=${encodeURIComponent(this.room)}&role=client`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => this.restartPing();

    ws.onmessage = (ev) => {
      if (ev.data === "pong") return;
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
        case "peer-absent":
          this.events.onPeerAbsent?.();
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
      clearInterval(this.pingTimer);
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

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // setActive は画面を見ているかどうかを伝える。
  // 見ていないあいだ keepalive を止め、無線を眠らせる。
  setActive(on: boolean): void {
    if (this.activeState === on) return;
    this.activeState = on;
    this.restartPing();
  }

  private restartPing(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = 0;
    if (!this.activeState || this.closed) return;
    this.pingTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send("ping");
    }, PING_MS);
  }

  close(): void {
    this.closed = true;
    clearInterval(this.pingTimer);
    this.pingTimer = 0;
    this.ws?.close();
    this.ws = null;
  }
}

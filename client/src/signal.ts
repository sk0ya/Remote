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

// pingを送ってからこれだけ無音なら、経路が死んだとみなしてソケットを畳む。
//
// 切られるときにFINが飛んでくるとは限らない。モバイルでは画面を消している
// あいだにNATや基地局が黙って流れを落とすのが普通で、そのあとも
// readyState は OPEN のまま、send() も例外を投げずに成功したふりをする。
// 応答を確かめる仕組みが無いと、クライアントは死んだソケットへ接続要求を
// 投げ込んで、来るはずのない返事をタイムアウトまで待つことになる。
// (ホスト側は internal/signal の readTimeout が同じ役目をしている)
export const PONG_TIMEOUT_MS = 10_000;

export class SignalChannel {
  private ws: WebSocket | null = null;
  private closed = false;
  private pingTimer = 0;
  // ping送信中の応答待ち。何か1つでも届けば解除する。
  private deadTimer = 0;
  // 画面を見ているあいだだけ true。非表示のあいだのpingは、誰も待っていない
  // 通信のためにモバイル回線のモデムをアイドル状態から起こし続けるだけになる。
  private activeState = true;

  constructor(
    private room: string,
    private events: SignalEvents
  ) {}

  connect(): void {
    this.closed = false;
    // 前のソケットを残したまま張り直すと、あとから死んだ方のoncloseが飛んで
    // 生きている接続まで畳みに行く。必ず切り離してから開く。
    this.dropSocket();
    const url = `${signalUrl()}?room=${encodeURIComponent(this.room)}&role=client`;
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.onopen = () => this.restartPing();

    ws.onmessage = (ev) => {
      // 届いた時点で経路は生きている。pongに限らず何でも生存の証拠になる。
      this.noteAlive();
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
      if (this.ws !== ws) return; // 既に切り離したソケットの後始末
      this.dropSocket();
      if (!this.closed) this.events.onClose?.(ev.reason || `code ${ev.code}`);
    };
  }

  // 送れたらtrue、ソケットが閉じていればfalse。
  // 部屋は role ごとに1本で、後から来た接続が先客を蹴り出す(close 4000 "replaced")。
  // 黙って捨てると呼び出し側が来ない応答を待ち続けるので、必ず結果を返す。
  //
  // なお true は「送信キューに乗った」でしかない。経路が死んでいても OPEN の
  // ままなので true が返る。届いたかどうかは上の応答待ちだけが知っている。
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
    // 戻ってきた瞬間に生きているかを確かめる。眠っているあいだに黙って
    // 切られているのがむしろ普通で、次のping(25秒後)まで待つと、そのあいだ
    // 死んだソケットへ接続要求を投げ続けることになる。
    if (on) this.ping();
  }

  private ping(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    // 待ち始めてから送る。応答が先に届いても取り消せるようにしておく
    // (既に応答待ちなら待ち時間は伸ばさない)。
    if (!this.deadTimer) {
      this.deadTimer = window.setTimeout(() => this.giveUp(), PONG_TIMEOUT_MS);
    }
    this.ws.send("ping");
  }

  private noteAlive(): void {
    clearTimeout(this.deadTimer);
    this.deadTimer = 0;
  }

  // 応答が返らなかった。ソケットは開いているように見えるが経路は死んでいる。
  // 自分から畳んで、通常の切断と同じ再接続の流れに乗せる。
  private giveUp(): void {
    this.deadTimer = 0;
    this.dropSocket();
    if (!this.closed) this.events.onClose?.("応答なし (keepalive タイムアウト)");
  }

  // ソケットを切り離して黙らせる。以後このソケットからは何も上がってこない。
  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    clearInterval(this.pingTimer);
    this.pingTimer = 0;
    clearTimeout(this.deadTimer);
    this.deadTimer = 0;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.close();
  }

  private restartPing(): void {
    clearInterval(this.pingTimer);
    this.pingTimer = 0;
    this.noteAlive(); // 送らないあいだは応答も待たない
    if (!this.activeState || this.closed) return;
    this.pingTimer = window.setInterval(() => this.ping(), PING_MS);
  }

  close(): void {
    this.closed = true;
    this.dropSocket();
  }
}

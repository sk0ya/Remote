// Package signal はシグナリングサーバー(Cloudflare Worker)への
// 常時WebSocket接続を維持し、クライアントとのメッセージ中継を扱う。
package signal

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"

	"github.com/coder/websocket"
)

const (
	// keepalive。待機中は何分も無通信になるため、経路上のNATや中継に
	// アイドルとみなされて切られる(実際、数十分〜数時間おきにEOFで落ちていた)。
	// サーバーはこの文字列に自動応答するので、部屋の状態には影響しない。
	pingInterval = 25 * time.Second
	ping         = "ping"
	pong         = "pong"
	// pingを送っても応答が返らないまま無通信が続いたら経路が死んだとみなす。
	// TCPが半分だけ死ぬとReadはEOFすら返さずブロックし続けるため、
	// これが無いとホストは「繋がっているつもり」で無応答になる。
	readTimeout = 70 * time.Second

	minBackoff = time.Second
	maxBackoff = 30 * time.Second
	// これだけ繋がっていられたら「一度は安定した」とみなし、
	// 次の切断は1秒から数え直す。
	//
	// 以前は成功してもbackoffを戻していなかったため、数回切れたあとは
	// 何時間安定していようが再接続まで常に32秒かかっていた。
	// その32秒はホストが部屋に居らず、スマホから接続できない時間になる。
	stableAfter = 60 * time.Second
)

// サーバーが送ってくる封筒
type envelope struct {
	Type        string `json:"type"`
	From        string `json:"from,omitempty"`
	IP          string `json:"ip,omitempty"`
	Msg         string `json:"msg,omitempty"`
	Role        string `json:"role,omitempty"`
	PeerPresent bool   `json:"peerPresent,omitempty"`
}

type Handlers struct {
	// OnHello は接続確立時。selfIP はサーバーが観測した自分のグローバルIP。
	OnHello func(selfIP string)
	// OnPeerJoined はクライアントが部屋に入ったとき。ip は相手の観測IP。
	OnPeerJoined func(ip string)
	OnPeerLeft   func()
	// OnMessage はクライアントからの中継メッセージ。
	OnMessage func(msg json.RawMessage, peerIP string)
}

type Client struct {
	url      string
	room     string
	handlers Handlers
	sendCh   chan []byte
}

func New(url, room string, h Handlers) *Client {
	return &Client{url: url, room: room, handlers: h, sendCh: make(chan []byte, 64)}
}

// Run は切断時の再接続を含めて接続を維持する。ctxキャンセルで終了。
func (c *Client) Run(ctx context.Context) {
	var wait time.Duration // 最初の切断は minBackoff から
	for ctx.Err() == nil {
		start := time.Now()
		err := c.runOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		wait = backoffAfter(wait, time.Since(start))
		log.Printf("signal: 切断: %v (再接続まで %v)", err, wait)
		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}
	}
}

// backoffAfter は切断後に待つ時間を決める。lasted は今の接続が続いていた時間。
// 落ち続けるあいだは倍々に伸ばすが、一度でも安定して繋がっていたなら仕切り直す。
func backoffAfter(prev, lasted time.Duration) time.Duration {
	if lasted >= stableAfter {
		return minBackoff
	}
	next := prev * 2
	return min(max(next, minBackoff), maxBackoff)
}

func (c *Client) runOnce(ctx context.Context) error {
	// 切断中に積まれた送信待ちは、もう居ない相手への返事なので捨てる。
	// 残したまま繋ぎ直すと、次に入室したクライアントへ前のセッションの
	// offer が飛んで噛み合わなくなる。
	c.drainSend()

	url := c.url + "?room=" + c.room + "&role=host"
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return err
	}
	// 映像は流れないが、SDPは数十KBになることがある
	conn.SetReadLimit(1 << 20)

	connCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	defer conn.Close(websocket.StatusNormalClosure, "")

	go c.writeLoop(connCtx, cancel, conn)

	for {
		readCtx, cancelRead := context.WithTimeout(connCtx, readTimeout)
		_, data, err := conn.Read(readCtx)
		cancelRead()
		if err != nil {
			if ctx.Err() != nil {
				return ctx.Err()
			}
			if errors.Is(err, context.DeadlineExceeded) {
				return errors.New("応答なし (keepalive タイムアウト)")
			}
			return err
		}
		if string(data) == pong {
			continue
		}
		var env envelope
		if err := json.Unmarshal(data, &env); err != nil {
			continue
		}
		switch env.Type {
		case "hello":
			if c.handlers.OnHello != nil {
				c.handlers.OnHello(env.IP)
			}
		case "peer-joined":
			if env.Role == "client" && c.handlers.OnPeerJoined != nil {
				c.handlers.OnPeerJoined(env.IP)
			}
		case "peer-left":
			if env.Role == "client" && c.handlers.OnPeerLeft != nil {
				c.handlers.OnPeerLeft()
			}
		case "relay":
			if c.handlers.OnMessage != nil {
				c.handlers.OnMessage(json.RawMessage(env.Msg), env.IP)
			}
		}
	}
}

// writeLoop は送信キューとkeepaliveの両方を1本のゴルーチンで扱う
// (WebSocketは同時に複数の書き手を持てない)。
// 書き込みに失敗したら接続ごと畳んで読み側にも知らせる。黙って止まると
// 「繋がっているのに何も送られない」状態になる。
func (c *Client) writeLoop(ctx context.Context, cancel context.CancelFunc, conn *websocket.Conn) {
	defer cancel()
	ticker := time.NewTicker(pingInterval)
	defer ticker.Stop()
	for {
		var data []byte
		select {
		case <-ctx.Done():
			return
		case data = <-c.sendCh:
		case <-ticker.C:
			data = []byte(ping)
		}
		writeCtx, cancelWrite := context.WithTimeout(ctx, 10*time.Second)
		err := conn.Write(writeCtx, websocket.MessageText, data)
		cancelWrite()
		if err != nil {
			if ctx.Err() == nil {
				log.Printf("signal: 送信失敗: %v", err)
			}
			return
		}
	}
}

func (c *Client) drainSend() {
	for {
		select {
		case <-c.sendCh:
		default:
			return
		}
	}
}

// Send はクライアント宛メッセージをキューに積む。
// 送信は接続中のゴルーチンが行うので、この呼び出しはブロックしない。
func (c *Client) Send(msg any) {
	data, err := json.Marshal(msg)
	if err != nil {
		log.Printf("signal: 送信データの変換失敗: %v", err)
		return
	}
	select {
	case c.sendCh <- data:
	default:
		log.Printf("signal: 送信キュー溢れ、破棄")
	}
}

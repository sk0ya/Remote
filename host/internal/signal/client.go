// Package signal はシグナリングサーバー(Cloudflare Worker)への
// 常時WebSocket接続を維持し、クライアントとのメッセージ中継を扱う。
package signal

import (
	"context"
	"encoding/json"
	"log"
	"time"

	"github.com/coder/websocket"
)

// サーバーが送ってくる封筒
type envelope struct {
	Type        string          `json:"type"`
	From        string          `json:"from,omitempty"`
	IP          string          `json:"ip,omitempty"`
	Msg         string          `json:"msg,omitempty"`
	Role        string          `json:"role,omitempty"`
	PeerPresent bool            `json:"peerPresent,omitempty"`
	raw         json.RawMessage `json:"-"`
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
	conn     *websocket.Conn
	sendCh   chan any
}

func New(url, room string, h Handlers) *Client {
	return &Client{url: url, room: room, handlers: h, sendCh: make(chan any, 64)}
}

// Run は切断時の再接続を含めて接続を維持する。ctxキャンセルで終了。
func (c *Client) Run(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		if err := c.runOnce(ctx); err != nil && ctx.Err() == nil {
			log.Printf("signal: 切断: %v (再接続まで %v)", err, backoff)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(backoff):
		}
		if backoff < 30*time.Second {
			backoff *= 2
		}
	}
}

func (c *Client) runOnce(ctx context.Context) error {
	url := c.url + "?room=" + c.room + "&role=host"
	conn, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		return err
	}
	c.conn = conn
	defer func() {
		c.conn = nil
		conn.Close(websocket.StatusNormalClosure, "")
	}()

	sendCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	go func() {
		for {
			select {
			case <-sendCtx.Done():
				return
			case msg := <-c.sendCh:
				data, err := json.Marshal(msg)
				if err != nil {
					continue
				}
				if err := conn.Write(sendCtx, websocket.MessageText, data); err != nil {
					return
				}
			}
		}
	}()

	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return err
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

// Send はクライアント宛メッセージをキューに積む(未接続時は破棄されず接続後に送信)。
func (c *Client) Send(msg any) {
	select {
	case c.sendCh <- msg:
	default:
		log.Printf("signal: 送信キュー溢れ、破棄")
	}
}

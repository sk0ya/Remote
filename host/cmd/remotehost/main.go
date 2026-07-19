package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"time"

	"remotehost/internal/config"
	"remotehost/internal/input"
	"remotehost/internal/session"
	sig "remotehost/internal/signal"
)

type clientMsg struct {
	T   string `json:"t"`
	SDP string `json:"sdp,omitempty"`
}

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("設定読み込み失敗: %v", err)
	}
	log.Printf("HostID: %s", cfg.HostID)
	log.Printf("シグナリング: %s", cfg.SignalURL)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	var client *sig.Client
	var sess *session.Session

	closeSession := func() {
		if sess != nil {
			sess.Close()
			sess = nil
		}
	}

	client = sig.New(cfg.SignalURL, cfg.HostID, sig.Handlers{
		OnHello: func(selfIP string) {
			log.Printf("signal: 接続確立 (観測IP: %s)", selfIP)
		},
		OnPeerJoined: func(ip string) {
			log.Printf("signal: クライアント入室 (IP: %s)", ip)
		},
		OnPeerLeft: func() {
			log.Printf("signal: クライアント退室")
		},
		OnMessage: func(msg json.RawMessage, peerIP string) {
			var m clientMsg
			if err := json.Unmarshal(msg, &m); err != nil {
				return
			}
			switch m.T {
			case "ping":
				client.Send(map[string]any{"t": "pong", "time": time.Now().Format(time.RFC3339)})

			case "connect":
				// クライアントが接続要求 → 新セッションを作りofferを返す
				closeSession()
				s, sdp, err := session.New(ctx)
				if err != nil {
					log.Printf("session: 作成失敗: %v", err)
					client.Send(map[string]any{"t": "error", "reason": "session"})
					return
				}
				s.OnInput = input.Handle
				s.OnClosed = func() { log.Printf("session: 終了") }
				sess = s
				client.Send(map[string]any{"t": "offer", "sdp": sdp})
				log.Printf("session: offer送信")

			case "answer":
				if sess == nil {
					return
				}
				if err := sess.HandleAnswer(m.SDP); err != nil {
					log.Printf("session: answer適用失敗: %v", err)
					return
				}
				log.Printf("session: answer適用")
			}
		},
	})
	client.Run(ctx)
	closeSession()
}

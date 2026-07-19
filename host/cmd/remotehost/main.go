package main

import (
	"context"
	"encoding/json"
	"log"
	"os"
	"os/signal"
	"time"

	"remotehost/internal/config"
	sig "remotehost/internal/signal"
)

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
			var m struct {
				T string `json:"t"`
			}
			if err := json.Unmarshal(msg, &m); err != nil {
				return
			}
			log.Printf("signal: 受信 t=%s from %s", m.T, peerIP)
			switch m.T {
			case "ping":
				client.Send(map[string]any{"t": "pong", "time": time.Now().Format(time.RFC3339)})
			}
		},
	})
	client.Run(ctx)
}

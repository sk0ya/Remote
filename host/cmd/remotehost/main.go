package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"os"
	"os/signal"
	"time"

	"remotehost/internal/config"
	"remotehost/internal/input"
	"remotehost/internal/pair"
	"remotehost/internal/session"
	sig "remotehost/internal/signal"
	"remotehost/internal/ui"
)

type clientMsg struct {
	T        string `json:"t"`
	SDP      string `json:"sdp,omitempty"`
	MAC      string `json:"mac,omitempty"`
	Code     string `json:"code,omitempty"`
	Password string `json:"password,omitempty"`
	Token    string `json:"token,omitempty"`
}

func main() {
	cfg, err := config.Load()
	if err != nil {
		log.Fatalf("設定読み込み失敗: %v", err)
	}
	log.Printf("HostID: %s", cfg.HostID)
	log.Printf("シグナリング: %s", cfg.SignalURL)

	pm := pair.NewManager(cfg)
	pairURL, err := ui.StartPairServer(pm, cfg)
	if err != nil {
		log.Fatalf("ペアリングページ起動失敗: %v", err)
	}
	log.Printf("ペアリングページ: %s", pairURL)
	if !pm.Paired() {
		ui.OpenBrowser(pairURL)
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt)
	defer stop()

	var client *sig.Client
	var sess *session.Session
	var hostIP string

	closeSession := func() {
		if sess != nil {
			sess.Close()
			sess = nil
		}
	}

	client = sig.New(cfg.SignalURL, cfg.HostID, sig.Handlers{
		OnHello: func(selfIP string) {
			hostIP = selfIP
			log.Printf("signal: 接続確立 (観測IP: %q)", selfIP)
		},
		OnPeerJoined: func(ip string) { log.Printf("signal: クライアント入室 (IP: %q)", ip) },
		OnPeerLeft:   func() { log.Printf("signal: クライアント退室") },
		OnMessage: func(msg json.RawMessage, peerIP string) {
			var m clientMsg
			if err := json.Unmarshal(msg, &m); err != nil {
				return
			}
			switch m.T {
			case "ping":
				client.Send(map[string]any{"t": "pong", "time": time.Now().Format(time.RFC3339)})

			case "pair":
				token, secret, err := pm.Handle(m.Code, m.Password, peerIP, hostIP)
				if err != nil {
					reason := "unknown"
					switch {
					case errors.Is(err, pair.ErrCode):
						reason = "code"
					case errors.Is(err, pair.ErrPass):
						reason = "password"
					case errors.Is(err, pair.ErrNetwork):
						reason = "network"
					}
					log.Printf("pair: 失敗 (%s) client=%q host=%q", reason, peerIP, hostIP)
					client.Send(map[string]any{"t": "pair-err", "reason": reason})
					return
				}
				log.Printf("pair: 端末登録完了 (旧端末は失効)")
				client.Send(map[string]any{"t": "pair-ok", "token": token, "secret": secret})

			case "connect":
				if !pm.VerifyToken(m.Token) {
					log.Printf("session: 認証失敗")
					client.Send(map[string]any{"t": "error", "reason": "auth"})
					return
				}
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
				client.Send(map[string]any{"t": "offer", "sdp": sdp, "mac": pm.MAC(sdp)})
				log.Printf("session: offer送信")

			case "answer":
				if sess == nil {
					return
				}
				// HTTPS環境のクライアントはMACを付ける。付いていれば必ず検証。
				// (開発用HTTP環境ではWebCryptoが使えないためMACなしを許容)
				if m.MAC != "" && !pm.VerifyMAC(m.SDP, m.MAC) {
					log.Printf("session: answer MAC不一致 — 破棄")
					return
				}
				if m.MAC == "" {
					log.Printf("session: answerにMACなし (開発モード想定)")
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

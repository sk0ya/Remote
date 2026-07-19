package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"time"

	"remotehost/internal/config"
	"remotehost/internal/input"
	"remotehost/internal/media"
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

type app struct {
	ctx       context.Context
	cfg       *config.Config
	pm        *pair.Manager
	client    *sig.Client
	sess      *session.Session
	hostIP    string
	setStatus func(string)
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

	ctx, cancel := context.WithCancel(context.Background())
	a := &app{ctx: ctx, cfg: cfg, pm: pm, setStatus: func(string) {}}

	ui.RunTray(pm, ui.TrayCallbacks{PairPageURL: pairURL, OnQuit: cancel},
		func(setStatus func(string)) {
			a.setStatus = setStatus
			setStatus("シグナリング接続中...")
			if !pm.Paired() {
				ui.OpenBrowser(pairURL)
			}
			go a.runSignal()
		})

	// systray.Quit後にここへ戻る
	a.closeSession()
}

func (a *app) closeSession() {
	if a.sess != nil {
		a.sess.Close()
		a.sess = nil
	}
}

func (a *app) runSignal() {
	a.client = sig.New(a.cfg.SignalURL, a.cfg.HostID, sig.Handlers{
		OnHello: func(selfIP string) {
			a.hostIP = selfIP
			log.Printf("signal: 接続確立 (観測IP: %q)", selfIP)
			a.setStatus(statusIdle(a.pm))
		},
		OnPeerJoined: func(ip string) { log.Printf("signal: クライアント入室 (IP: %q)", ip) },
		OnPeerLeft:   func() { log.Printf("signal: クライアント退室") },
		OnMessage:    a.onMessage,
	})
	a.client.Run(a.ctx)
}

func statusIdle(pm *pair.Manager) string {
	if pm.Paired() {
		return "待機中 (端末登録済み)"
	}
	return "待機中 (端末未登録)"
}

func (a *app) onMessage(msg json.RawMessage, peerIP string) {
	var m clientMsg
	if err := json.Unmarshal(msg, &m); err != nil {
		return
	}
	switch m.T {
	case "ping":
		a.client.Send(map[string]any{"t": "pong", "time": time.Now().Format(time.RFC3339)})

	case "pair":
		token, secret, err := a.pm.Handle(m.Code, m.Password, peerIP, a.hostIP)
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
			log.Printf("pair: 失敗 (%s) client=%q host=%q", reason, peerIP, a.hostIP)
			a.client.Send(map[string]any{"t": "pair-err", "reason": reason})
			return
		}
		log.Printf("pair: 端末登録完了 (旧端末は失効)")
		a.setStatus(statusIdle(a.pm))
		a.client.Send(map[string]any{"t": "pair-ok", "token": token, "secret": secret})

	case "connect":
		if !a.pm.VerifyToken(m.Token) {
			log.Printf("session: 認証失敗")
			a.client.Send(map[string]any{"t": "error", "reason": "auth"})
			return
		}
		a.closeSession()
		opts := media.Options{FPS: a.cfg.FPS, BitrateMbps: a.cfg.BitrateMbps}
		s, sdp, err := session.New(a.ctx, opts)
		if err != nil {
			log.Printf("session: 作成失敗: %v", err)
			a.client.Send(map[string]any{"t": "error", "reason": "session"})
			return
		}
		s.OnInput = input.Handle
		s.OnClosed = func() {
			log.Printf("session: 終了")
			a.setStatus(statusIdle(a.pm))
		}
		s.OnState = func(state string) {
			if state == "connected" {
				a.setStatus("接続中 (リモート操作中)")
			}
		}
		a.sess = s
		a.client.Send(map[string]any{"t": "offer", "sdp": sdp, "mac": a.pm.MAC(sdp)})
		log.Printf("session: offer送信")

	case "answer":
		if a.sess == nil {
			return
		}
		// HTTPS環境のクライアントはMACを付ける。付いていれば必ず検証。
		// (開発用HTTP環境ではWebCryptoが使えないためMACなしを許容)
		if m.MAC != "" && !a.pm.VerifyMAC(m.SDP, m.MAC) {
			log.Printf("session: answer MAC不一致 — 破棄")
			return
		}
		if m.MAC == "" {
			log.Printf("session: answerにMACなし (開発モード想定)")
		}
		if err := a.sess.HandleAnswer(m.SDP); err != nil {
			log.Printf("session: answer適用失敗: %v", err)
			return
		}
		log.Printf("session: answer適用")
	}
}

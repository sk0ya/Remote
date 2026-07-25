package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"remotehost/internal/config"
	"remotehost/internal/display"
	"remotehost/internal/input"
	"remotehost/internal/media"
	"remotehost/internal/pair"
	"remotehost/internal/session"
	sig "remotehost/internal/signal"
	"remotehost/internal/stt"
	"remotehost/internal/ui"
	"remotehost/internal/voice"
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
	stt       *stt.Engine
	hostIP    string
	display   int // 表示中のモニタindex (-1=未選択→プライマリ)
	setStatus func(string)

	// クライアントから分割送信される音声の組み立て中バッファ
	audioMu   sync.Mutex
	audioBuf  []byte
	audioWant int
}

// 1発話あたりの音声データの上限 (opusなら数十KB程度。桁違いのものは捨てる)
const maxAudioBytes = 4 << 20

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
	a := &app{
		ctx: ctx, cfg: cfg, pm: pm, display: -1, setStatus: func(string) {},
		stt: stt.New(cfg.STTCommand, cfg.STTDir),
	}
	if a.stt.Available() {
		log.Printf("音声認識: %s", cfg.STTCommand)
	} else {
		log.Printf("音声認識: 無効 (実行ファイルが見つかりません: %q)", cfg.STTCommand)
	}

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
	a.stt.Close()
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
		mons := display.List()
		if a.display < 0 || a.display >= len(mons) {
			a.display = display.PrimaryIndex(mons)
		}
		s, sdp, err := session.New(a.ctx, a.mediaOptions(mons))
		if err != nil {
			log.Printf("session: 作成失敗: %v", err)
			a.client.Send(map[string]any{"t": "error", "reason": "session"})
			return
		}
		s.OnInput = a.onInput
		s.OnBinary = a.onAudioChunk
		s.OnDCOpen = func() {
			a.sendDisplays()
			a.stt.Warm() // 最初の発話でモデル読み込みを待たせない
		}
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
		// 正規ペアリング済み(共有シークレットあり)なら、answerのMACは必須。
		// MACなし/不一致のanswerは中継サーバーやなりすまし端末による
		// セッション乗っ取りとみなして破棄する。VerifyMACはMAC空でもfalseを返す。
		// 共有シークレット未設定の純開発モード(HTTP/WebCrypto不可)のみMACなしを許容。
		if a.pm.HasSecret() {
			if !a.pm.VerifyMAC(m.SDP, m.MAC) {
				log.Printf("session: answer MAC検証失敗 — 破棄")
				return
			}
		} else {
			log.Printf("session: 共有シークレット未設定 — MAC検証なし(開発モード)")
		}
		if err := a.sess.HandleAnswer(m.SDP); err != nil {
			log.Printf("session: answer適用失敗: %v", err)
			return
		}
		log.Printf("session: answer適用")
	}
}

// mediaOptions は選択中モニタに合わせたキャプチャ設定を作り、
// マウス座標のマップ先も同じモニタに合わせる。
func (a *app) mediaOptions(mons []display.Monitor) media.Options {
	opts := media.Options{FPS: a.cfg.FPS, BitrateMbps: a.cfg.BitrateMbps}
	if a.display >= 0 && a.display < len(mons) {
		mon := mons[a.display]
		opts.Display = a.display
		opts.X, opts.Y, opts.W, opts.H = mon.X, mon.Y, mon.W, mon.H
		input.SetTarget(mon.X, mon.Y, mon.W, mon.H)
	} else {
		input.ResetTarget()
	}
	return opts
}

// onInput はDataChannelメッセージを振り分ける。ディスプレイ切替と音声だけここで拾い、
// 残りは入力注入へ渡す。
func (a *app) onInput(data []byte) {
	var m struct {
		T   string `json:"t"`
		N   int    `json:"n"`
		S   string `json:"s"`
		Len int    `json:"len"`
	}
	if err := json.Unmarshal(data, &m); err == nil {
		switch m.T {
		case "disp":
			a.switchDisplay(m.N)
			return
		case "aud":
			a.beginAudio(m.Len)
			return
		case "voice":
			// クライアント側で認識した場合 (現在は使っていないが互換のため残す)
			a.handleVoice(m.S)
			return
		}
	}
	input.Handle(data)
}

// beginAudio は音声受信の開始通知 {t:"aud", len:<全バイト数>} を受けてバッファを用意する。
func (a *app) beginAudio(n int) {
	a.audioMu.Lock()
	defer a.audioMu.Unlock()
	if n <= 0 || n > maxAudioBytes {
		log.Printf("voice: 音声サイズが不正 (%d bytes) — 無視", n)
		a.audioBuf, a.audioWant = nil, 0
		return
	}
	a.audioBuf = make([]byte, 0, n)
	a.audioWant = n
}

// onAudioChunk は音声の分割データを受け取り、宣言サイズに達したら認識へ回す。
func (a *app) onAudioChunk(data []byte) {
	a.audioMu.Lock()
	if a.audioWant == 0 {
		a.audioMu.Unlock()
		return // 開始通知なしのバイナリは捨てる
	}
	a.audioBuf = append(a.audioBuf, data...)
	if len(a.audioBuf) < a.audioWant {
		a.audioMu.Unlock()
		return
	}
	audio := a.audioBuf
	a.audioBuf, a.audioWant = nil, 0
	a.audioMu.Unlock()

	// 認識は数百ms〜数秒かかるのでDataChannelの受信を止めない
	go a.recognize(audio)
}

// recognize は受け取った音声を文字起こしし、結果を音声コマンド処理へ渡す。
func (a *app) recognize(audio []byte) {
	if !a.stt.Available() {
		a.sendVoiceResult("", "", "PCに音声認識エンジンが設定されていません")
		return
	}
	text, err := a.stt.Recognize(audio)
	if err != nil {
		log.Printf("voice: 認識失敗: %v", err)
		a.sendVoiceResult("", "", err.Error())
		return
	}
	if text == "" {
		log.Printf("voice: 認識結果なし (%d bytes)", len(audio))
		a.sendVoiceResult("", "", "聞き取れませんでした")
		return
	}
	a.handleVoice(text)
}

// handleVoice はスマホ側の音声認識結果を処理する。設定コマンドに一致すればそれを実行し、
// 一致しなければ発話をそのまま打ち込む(ディクテーション)。
// 処理結果はスマホへ返してHUDに表示する(何が起きたか分からないのがいちばん怖いため)。
func (a *app) handleVoice(s string) {
	s = strings.TrimSpace(s)
	if s == "" {
		return
	}
	c, ok := voice.Match(a.cfg.VoiceCommands, s)
	if !ok {
		log.Printf("voice: テキスト入力 %q", s)
		input.Text(s)
		a.sendVoiceResult(s, "", "")
		return
	}
	if err := voice.Execute(c); err != nil {
		log.Printf("voice: コマンド %q の実行失敗: %v", c.Name, err)
		a.sendVoiceResult(s, c.Name, "実行に失敗しました")
		return
	}
	log.Printf("voice: コマンド実行 %q ← %q", c.Name, s)
	a.sendVoiceResult(s, c.Name, "")
}

func (a *app) sendVoiceResult(utterance, cmd, errMsg string) {
	if a.sess == nil {
		return
	}
	msg := map[string]any{"t": "voice", "s": utterance, "cmd": cmd}
	if errMsg != "" {
		msg["err"] = errMsg
	}
	if err := a.sess.Send(msg); err != nil {
		log.Printf("session: voice結果送信失敗: %v", err)
	}
}

func (a *app) sendDisplays() {
	if a.sess == nil {
		return
	}
	mons := display.List()
	n := len(mons)
	if n == 0 {
		n = 1
	}
	if err := a.sess.Send(map[string]any{"t": "displays", "n": n, "cur": a.display}); err != nil {
		log.Printf("session: displays送信失敗: %v", err)
	}
}

func (a *app) switchDisplay(n int) {
	mons := display.List()
	if a.sess == nil || n < 0 || n >= len(mons) || n == a.display {
		return
	}
	a.display = n
	log.Printf("session: ディスプレイ切替 → %d (%s)", n, mons[n].Device)
	a.sess.SetMediaOptions(a.mediaOptions(mons))
	a.sendDisplays()
}

package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
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
	Code     string `json:"code,omitempty"`
	Password string `json:"password,omitempty"`
	// パスキー登録 (pair-key)。Reg は pair-ok で渡した合言葉の返送。
	Reg    string `json:"reg,omitempty"`
	CredID string `json:"credId,omitempty"`
	PubKey string `json:"pubKey,omitempty"`
	// 接続時のWebAuthn assertion (answer)。いずれもbase64url。
	ClientData string `json:"clientData,omitempty"`
	AuthData   string `json:"authData,omitempty"`
	Sig        string `json:"sig,omitempty"`
	// 再接続チケットを使う場合はassertionの代わりにこのMACが載る
	MAC string `json:"mac,omitempty"`
}

type app struct {
	ctx       context.Context
	cfg       *config.Config
	pm        *pair.Manager
	client    *sig.Client
	stt       *stt.Engine
	hostIP    string
	display   int // 表示中のモニタindex (-1=未選択→プライマリ)
	setStatus func(string)

	// sessMu は現行セッションと認証待ちセッションの両方を守る。
	// タイムアウトは別ゴルーチンから触るので、ここは必ずロック越しに扱う。
	sessMu  sync.Mutex
	sess    *session.Session // 認証済みの現行セッション
	pending *pendingAuth     // offer送信済み・assertion付きanswer待ち
	authGen uint64           // 仮セッションの世代カウンタ

	// クライアントから分割送信される音声の組み立て中バッファ
	audioMu   sync.Mutex
	audioBuf  []byte
	audioWant int
}

// pendingAuth は認証が済むまでの仮のセッション。
// 認証を通るまで現行セッションには昇格させないので、hostIdを知るだけの第三者が
// connectを撃っても、操作中のセッションは切れない。
type pendingAuth struct {
	sess  *session.Session
	nonce []byte
	offer string
	gen   uint64 // 世代番号。タイムアウトが古い世代を巻き添えにしないための目印
	timer *time.Timer
}

// 1発話あたりの音声データの上限 (opusなら数十KB程度。桁違いのものは捨てる)
const maxAudioBytes = 4 << 20

// offerを送ってから認証付きanswerが返ってくるまでの猶予。
// クライアント側はICE収集(最大5秒)のあとに生体認証ダイアログ(最大60秒)を挟むので、
// その合計より確実に長く取る。短いとホストだけが先に諦めて無反応に見える。
// 超えたら仮セッションを畳む(放置された場合や、hostIDを知る第三者の空打ち対策)。
// なお映像のキャプチャはP2P確立後にしか始まらないため、認証前に掴む資源はPeerConnectionだけ。
const authTimeout = 120 * time.Second

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

// session は現行セッションを返す。無ければnil。
func (a *app) session() *session.Session {
	a.sessMu.Lock()
	defer a.sessMu.Unlock()
	return a.sess
}

// closeSession は現行セッションと認証待ちの仮セッションをまとめて畳む。
func (a *app) closeSession() {
	a.sessMu.Lock()
	sess, pending := a.sess, a.pending
	a.sess, a.pending = nil, nil
	if pending != nil && pending.timer != nil {
		pending.timer.Stop()
	}
	a.sessMu.Unlock()

	if sess != nil {
		sess.Close()
	}
	if pending != nil {
		pending.sess.Close()
	}
}

// beginAuth はofferを送る直前に呼び、仮セッションを認証待ちとして登録する。
// 先にぶら下がっていた仮セッションがあれば畳む(現行セッションには手を出さない)。
func (a *app) beginAuth(s *session.Session, nonce []byte, offerSDP string) {
	a.sessMu.Lock()
	old := a.pending
	if old != nil && old.timer != nil {
		old.timer.Stop()
	}
	a.authGen++
	gen := a.authGen
	p := &pendingAuth{sess: s, nonce: nonce, offer: offerSDP, gen: gen}
	// 世代を照合してから畳むので、入れ替わった後に古いタイマーが発火しても実害はない。
	p.timer = time.AfterFunc(authTimeout, func() { a.expireAuth(gen) })
	a.pending = p
	a.sessMu.Unlock()

	if old != nil {
		old.sess.Close()
	}
}

// takeAuth は認証待ちの仮セッションを取り出す。取り出せるのは一度だけ。
func (a *app) takeAuth() *pendingAuth {
	a.sessMu.Lock()
	defer a.sessMu.Unlock()
	p := a.pending
	if p == nil {
		return nil
	}
	if p.timer != nil {
		p.timer.Stop()
	}
	a.pending = nil
	return p
}

// promote は認証を通った仮セッションを現行セッションに昇格させ、古い方を畳む。
func (a *app) promote(s *session.Session) {
	a.sessMu.Lock()
	old := a.sess
	a.sess = s
	a.sessMu.Unlock()
	if old != nil {
		old.Close()
	}
}

// expireAuth は認証待ちのまま猶予を過ぎた仮セッションを畳む。
// 世代が変わっていれば(=既に認証済み、または新しい要求で入れ替わっていれば)何もしない。
func (a *app) expireAuth(gen uint64) {
	a.sessMu.Lock()
	p := a.pending
	if p == nil || p.gen != gen {
		a.sessMu.Unlock()
		return
	}
	a.pending = nil
	a.sessMu.Unlock()

	log.Printf("session: 認証待ちタイムアウト — 仮セッション破棄")
	p.sess.Close()
	a.client.Send(map[string]any{"t": "error", "reason": "timeout"})
	a.setStatus(statusIdle(a.pm))
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
		// コード/パスワード/ネットワークの検証まで。実際の登録はこの後の pair-key。
		regToken, err := a.pm.Handle(m.Code, m.Password, peerIP, a.hostIP)
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
		log.Printf("pair: 検証OK — パスキー登録待ち")
		a.client.Send(map[string]any{"t": "pair-ok", "reg": regToken})

	case "pair-key":
		if err := a.pm.Register(m.CredID, m.PubKey, m.Reg); err != nil {
			reason := "unknown"
			switch {
			case errors.Is(err, pair.ErrRegister):
				reason = "code" // 猶予切れ。QRからやり直してもらう
			case errors.Is(err, pair.ErrKey):
				reason = "key"
			}
			log.Printf("pair: パスキー登録失敗 (%s): %v", reason, err)
			a.client.Send(map[string]any{"t": "pair-err", "reason": reason})
			return
		}
		log.Printf("pair: パスキー登録完了 (旧端末は失効)")
		a.setStatus(statusIdle(a.pm))
		a.client.Send(map[string]any{"t": "pair-done"})

	case "connect":
		if !a.pm.Paired() {
			log.Printf("session: 端末未登録のまま接続要求")
			a.client.Send(map[string]any{"t": "error", "reason": "unpaired"})
			return
		}
		// 認証が通るまで現行セッションは畳まない。
		// hostIdを知るだけの第三者がconnectを撃っても、操作中の接続は切れない。
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
			// 再接続チケットの受け渡しはここだけ。DataChannelはDTLSで暗号化された
			// P2P経路なので、中継サーバーには見えない。
			a.sendTicket(s)
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
		// nonceはこの接続限り。クライアントはこれとoffer/answerからチャレンジを作り、
		// パスキーで署名して返す。認証はanswerを受け取った時点で行う。
		nonce := pair.Nonce()
		a.beginAuth(s, nonce, sdp)
		a.client.Send(map[string]any{
			"t": "offer", "sdp": sdp,
			"nonce": base64.RawURLEncoding.EncodeToString(nonce),
		})
		log.Printf("session: offer送信 (認証待ち)")

	case "answer":
		p := a.takeAuth()
		if p == nil {
			log.Printf("session: 認証待ちでないanswer — 破棄")
			return
		}
		// 認証が通らない限りSDPは適用せず、現行セッションにも昇格させない。
		// 中継サーバーがSDPを書き換えていればチャレンジが食い違うので、ここで落ちる。
		// MACがあれば再接続チケット、無ければパスキーのassertionで検証する。
		// どちらも対象は同じ Challenge(nonce, offer, answer)。
		var err error
		if m.MAC != "" {
			if !a.pm.VerifyTicketMAC(p.nonce, p.offer, m.SDP, m.MAC) {
				err = errors.New("再接続チケットが無効または期限切れ")
			}
		} else {
			var as pair.Assertion
			if as, err = decodeAssertion(m); err == nil {
				err = a.pm.VerifyAssertion(p.nonce, p.offer, m.SDP, as)
			}
		}
		if err != nil {
			log.Printf("session: 認証失敗: %v", err)
			p.sess.Close()
			// 失効したチケットで来た相手には、パスキーからやり直してもらう
			a.client.Send(map[string]any{"t": "error", "reason": "auth"})
			return
		}
		if err := p.sess.HandleAnswer(m.SDP); err != nil {
			log.Printf("session: answer適用失敗: %v", err)
			p.sess.Close()
			return
		}
		a.promote(p.sess)
		if m.MAC != "" {
			log.Printf("session: 認証OK (再接続チケット) — answer適用")
		} else {
			log.Printf("session: 認証OK (パスキー) — answer適用")
		}
	}
}

func decodeAssertion(m clientMsg) (pair.Assertion, error) {
	clientData, err := pair.B64Decode(m.ClientData)
	if err != nil {
		return pair.Assertion{}, fmt.Errorf("clientData: %w", err)
	}
	authData, err := pair.B64Decode(m.AuthData)
	if err != nil {
		return pair.Assertion{}, fmt.Errorf("authData: %w", err)
	}
	sig, err := pair.B64Decode(m.Sig)
	if err != nil {
		return pair.Assertion{}, fmt.Errorf("sig: %w", err)
	}
	return pair.Assertion{
		CredID: m.CredID, ClientData: clientData, AuthData: authData, Signature: sig,
	}, nil
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
	sess := a.session()
	if sess == nil {
		return
	}
	msg := map[string]any{"t": "voice", "s": utterance, "cmd": cmd}
	if errMsg != "" {
		msg["err"] = errMsg
	}
	if err := sess.Send(msg); err != nil {
		log.Printf("session: voice結果送信失敗: %v", err)
	}
}

// sendTicket は再接続チケットを発行してクライアントへ渡す。
// これがあるあいだ、再接続で生体認証を求めずに済む。
// 昇格の前後で取り違えないよう、対象のセッションは呼び出し元から受け取る。
func (a *app) sendTicket(sess *session.Session) {
	if sess == nil {
		return
	}
	if err := sess.Send(map[string]any{"t": "ticket", "v": a.pm.IssueTicket()}); err != nil {
		log.Printf("session: チケット送信失敗: %v", err)
	}
}

func (a *app) sendDisplays() {
	sess := a.session()
	if sess == nil {
		return
	}
	mons := display.List()
	n := len(mons)
	if n == 0 {
		n = 1
	}
	if err := sess.Send(map[string]any{"t": "displays", "n": n, "cur": a.display}); err != nil {
		log.Printf("session: displays送信失敗: %v", err)
	}
}

func (a *app) switchDisplay(n int) {
	sess := a.session()
	mons := display.List()
	if sess == nil || n < 0 || n >= len(mons) || n == a.display {
		return
	}
	a.display = n
	log.Printf("session: ディスプレイ切替 → %d (%s)", n, mons[n].Device)
	sess.SetMediaOptions(a.mediaOptions(mons))
	a.sendDisplays()
}

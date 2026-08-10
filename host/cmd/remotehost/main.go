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
	Version  int    `json:"v,omitempty"`
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
	// Trickle ICE。answer適用後に集まったクライアント候補を逐次受け取る。
	Candidate *iceCandidateMsg `json:"candidate,omitempty"`
}

type iceCandidateMsg struct {
	Candidate        string  `json:"candidate"`
	SDPMid           *string `json:"sdpMid,omitempty"`
	SDPMLineIndex    *uint16 `json:"sdpMLineIndex,omitempty"`
	UsernameFragment *string `json:"usernameFragment,omitempty"`
}

type iceCandidateAdder interface {
	AddICECandidate(string, *string, *uint16, *string) error
}

func applyICECandidate(version int, candidate *iceCandidateMsg, target iceCandidateAdder) error {
	if version != protocolVersion {
		return fmt.Errorf("非対応プロトコル v%d", version)
	}
	if candidate == nil || candidate.Candidate == "" {
		return errors.New("ICE候補が空です")
	}
	return target.AddICECandidate(
		candidate.Candidate,
		candidate.SDPMid,
		candidate.SDPMLineIndex,
		candidate.UsernameFragment,
	)
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

	// クライアントが申告した表示サイズ(デバイスピクセル)。0なら未申告。
	// これより大きい解像度を送っても、スマホ側で縮小されて捨てられるだけなので、
	// 送る前に落としておく。
	// 書くのはDataChannelゴルーチン(onInput)、読むのは接続要求を捌く
	// シグナリングゴルーチンなので、必ずロック越しに扱う。
	viewMu       sync.Mutex
	viewW, viewH int

	// sessMu は現行セッションと認証待ちセッションの両方を守る。
	// タイムアウトは別ゴルーチンから触るので、ここは必ずロック越しに扱う。
	sessMu  sync.Mutex
	sess    *session.Session // 認証済みの現行セッション
	pending *pendingAuth     // offer送信済み・P2P確認または認証待ち
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
	sess   *session.Session
	nonce  []byte
	offer  string
	answer string // P2P疎通確認に適用済みのanswer。認証チャレンジにもこの値を使う。
	ufrag  string // answerのice-ufrag。この接続要求のICE候補かどうかの照合に使う。
	gen    uint64 // 世代番号。タイムアウトが古い世代を巻き添えにしないための目印
	timer  *time.Timer
}

// sdpICEUfrag はSDPから a=ice-ufrag の値を取り出す。見つからなければ空。
// ICE候補にも同じ値が入っているので、どの接続要求で集めた候補かを見分けられる。
func sdpICEUfrag(sdp string) string {
	for _, line := range strings.Split(sdp, "\n") {
		if v, ok := strings.CutPrefix(strings.TrimSpace(line), "a=ice-ufrag:"); ok {
			return strings.TrimSpace(v)
		}
	}
	return ""
}

// 1発話あたりの音声データの上限 (opusなら数十KB程度。桁違いのものは捨てる)
const maxAudioBytes = 4 << 20

// クライアントとホスト間のメッセージ仕様。互換性のない片側更新を
// 認証失敗や無応答として扱わず、更新が必要だと明示する。
const protocolVersion = 1

// offerを送ってからP2P確認と認証が終わるまでの猶予。
// クライアント側はICE収集(最大5秒)、P2P確立、生体認証(最大60秒)を順に行うので、
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

// recordAnswer は認証前のP2P疎通確認用answerを一度だけ記録する。
func (a *app) recordAnswer(sdp string) *pendingAuth {
	a.sessMu.Lock()
	defer a.sessMu.Unlock()
	p := a.pending
	if p == nil || p.answer != "" {
		return nil
	}
	p.answer = sdp
	p.ufrag = sdpICEUfrag(sdp)
	return p
}

// abortAuth は仮セッションを畳んで登録から外す。入れ替わっていれば何もしない
// (新しい要求で別のセッションが入っているとき、それを巻き添えにしない)。
//
// answerの適用に失敗したときはこれで捨てる。放置すると answer だけ記録された
// 仮セッションが残り、閉じたPeerConnectionへICE候補を注ぎ続けることになる。
func (a *app) abortAuth(p *pendingAuth) {
	if a.detachPending(p) {
		p.sess.Close()
	}
}

// detachPending は仮セッションpを登録から外す。外せたらtrue。
// 既に別のものへ入れ替わっていればfalseで、そのときpは呼び出し側が畳む。
func (a *app) detachPending(p *pendingAuth) bool {
	a.sessMu.Lock()
	defer a.sessMu.Unlock()
	if a.pending != p {
		return false
	}
	if p.timer != nil {
		p.timer.Stop()
	}
	a.pending = nil
	return true
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
		if m.Version != protocolVersion {
			a.client.Send(map[string]any{"t": "pair-err", "reason": "protocol", "expected": protocolVersion})
			return
		}
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
		if m.Version != protocolVersion {
			log.Printf("session: 非対応プロトコル v%d (必要 v%d)", m.Version, protocolVersion)
			a.client.Send(map[string]any{"t": "error", "reason": "protocol", "expected": protocolVersion})
			return
		}
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
				a.client.Send(map[string]any{"t": "ready-auth"})
				a.setStatus("接続確認済み (認証待ち)")
			}
		}
		// nonceはこの接続限り。クライアントはこれとoffer/answerからチャレンジを作り、
		// パスキーで署名して返す。認証はanswerを受け取った時点で行う。
		nonce := pair.Nonce()
		a.beginAuth(s, nonce, sdp)
		a.client.Send(map[string]any{
			"t": "offer", "v": protocolVersion, "sdp": sdp,
			"nonce": base64.RawURLEncoding.EncodeToString(nonce),
		})
		log.Printf("session: offer送信 (認証待ち)")

	case "answer":
		if m.Version != protocolVersion {
			a.client.Send(map[string]any{"t": "error", "reason": "protocol", "expected": protocolVersion})
			return
		}
		p := a.recordAnswer(m.SDP)
		if p == nil {
			log.Printf("session: 接続確認待ちでないanswer — 破棄")
			return
		}
		if err := p.sess.HandleAnswer(m.SDP); err != nil {
			log.Printf("session: answer適用失敗: %v", err)
			a.abortAuth(p) // 登録からも外す (閉じた相手に候補を送り続けない)
			return
		}
		log.Printf("session: answer適用 — P2P疎通確認待ち")

	case "candidate":
		if m.Version != protocolVersion || m.Candidate == nil {
			return
		}
		a.sessMu.Lock()
		p := a.pending
		a.sessMu.Unlock()
		if p == nil || p.answer == "" {
			return
		}
		// 別の接続要求が来て仮セッションが入れ替わると、前の要求で集めていた
		// 候補が遅れて届く。ufragは候補を集めた側のもので、その要求のanswerと
		// 一致するので、食い違うものは今のセッションのものではない。
		if uf := m.Candidate.UsernameFragment; uf != nil && *uf != "" && p.ufrag != "" && *uf != p.ufrag {
			log.Printf("session: 古い接続要求のICE候補 — 破棄")
			return
		}
		if err := applyICECandidate(m.Version, m.Candidate, p.sess); err != nil {
			log.Printf("session: クライアントICE候補の追加失敗: %v", err)
		}

	case "auth":
		if m.Version != protocolVersion {
			a.client.Send(map[string]any{"t": "error", "reason": "protocol", "expected": protocolVersion})
			return
		}
		p := a.takeAuth()
		if p == nil || p.answer == "" {
			log.Printf("session: 接続確認前の認証 — 破棄")
			if p != nil {
				p.sess.Close()
			}
			return
		}
		// P2P経路は確認済みだが、認証が通るまでは映像・入力を解禁せず、
		// 現行セッションにも昇格させない。SDPが書き換えられていれば
		// チャレンジが食い違うので、ここで落ちる。
		// MACがあれば再接続チケット、無ければパスキーのassertionで検証する。
		// どちらも対象は同じ Challenge(nonce, offer, answer)。
		var err error
		if m.MAC != "" {
			if !a.pm.VerifyTicketMAC(p.nonce, p.offer, p.answer, m.MAC) {
				err = errors.New("再接続チケットが無効または期限切れ")
			}
		} else {
			var as pair.Assertion
			if as, err = decodeAssertion(m); err == nil {
				err = a.pm.VerifyAssertion(p.nonce, p.offer, p.answer, as)
			}
		}
		if err != nil {
			log.Printf("session: 認証失敗: %v", err)
			p.sess.Close()
			// 失効したチケットで来た相手には、パスキーからやり直してもらう
			a.client.Send(map[string]any{"t": "error", "reason": "auth"})
			return
		}
		a.promote(p.sess)
		p.sess.Authorize()
		a.client.Send(map[string]any{"t": "auth-ok"})
		a.setStatus("接続中 (リモート操作中)")
		if m.MAC != "" {
			log.Printf("session: 認証OK (再接続チケット) — 映像・入力を解禁")
		} else {
			log.Printf("session: 認証OK (パスキー) — 映像・入力を解禁")
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
	a.viewMu.Lock()
	vw, vh := a.viewW, a.viewH
	a.viewMu.Unlock()
	opts := media.Options{
		FPS: a.cfg.FPS, BitrateMbps: a.cfg.BitrateMbps,
		MaxW: vw, MaxH: vh,
		CapW: a.cfg.MaxWidth, CapH: a.cfg.MaxHeight,
	}
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
		On  bool   `json:"on"`
		W   int    `json:"w"`
		H   int    `json:"h"`
	}
	if err := json.Unmarshal(data, &m); err == nil {
		switch m.T {
		case "disp":
			a.switchDisplay(m.N)
			return
		case "vis":
			a.setActive(m.On)
			return
		case "view":
			a.setViewport(m.W, m.H)
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

// setActive はスマホが前面にあるかどうかの通知を受けてキャプチャを止め/再開する。
// バックグラウンドに回った相手に送り続ける映像は、誰も見ないまま
// スマホの無線とデコーダを回すだけなので、まるごと止める。
func (a *app) setActive(on bool) {
	if sess := a.session(); sess != nil {
		sess.SetActive(on)
	}
}

// setViewport はクライアントが実際に表示できる大きさを受け取り、
// それより大きい解像度を送らないようにする。
func (a *app) setViewport(w, h int) {
	// 桁違いの値は無視する (上限はどのみち media 側で頭打ちになる)
	if w <= 0 || h <= 0 || w > 8192 || h > 8192 {
		return
	}
	a.viewMu.Lock()
	unchanged := w == a.viewW && h == a.viewH
	if !unchanged {
		a.viewW, a.viewH = w, h
	}
	a.viewMu.Unlock()
	if unchanged {
		return
	}
	sess := a.session()
	if sess == nil {
		return
	}
	opts := a.mediaOptions(display.List())
	ow, oh := opts.EncodedSize()
	log.Printf("session: クライアント表示サイズ %dx%d → 送出 %dx%d", w, h, ow, oh)
	// 送出解像度が変わらない申告ならキャプチャは再起動されない (SetMediaOptions側で判断)
	sess.SetMediaOptions(opts)
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

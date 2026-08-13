// Package session は1クライアントとのWebRTCセッションを管理する。
// ホストがofferを作り、映像トラック(H.264)と入力用DataChannelを持つ。
// ICEは双方向のTrickle方式で、offerは収集を待たずに送り、候補は集まり次第
// シグナリング経由で流す。
package session

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"

	"github.com/pion/interceptor"
	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	hostmedia "remotehost/internal/media"
)

var iceServers = []webrtc.ICEServer{
	{URLs: []string{"stun:stun.cloudflare.com:3478"}},
	{URLs: []string{"stun:stun.l.google.com:19302"}},
}

// newPeerConnection はIPv4/IPv6の両方でICE候補を集める。
//
// UDPだけを挙げるのは、TCPの候補がここでは絶対に出ないため。Pionは
// SettingEngine.SetICETCPMux でmuxを渡さないかぎりTCPの収集を丸ごと飛ばす
// (ice/v4 gather.go の `if a.tcpMux == nil { continue }`)ので、TCP4/TCP6を
// 並べても候補は1つも増えず、「TCPでも繋がる」という誤解だけが残る。
//
// なお、この4種を並べた状態はPionの既定値そのもの (NetworkTypesが空なら
// supportedNetworkTypes() に落ちる) で、指定しても挙動は変わらなかった。
// UDPに絞った今も候補の中身は変わらない — 変わったのは、コードが実際の
// 収集内容と一致するようになったことだけ。TURNなしでモバイル回線と繋ぐには
// IPv6の共通経路が要るので、UDP6を明示して意図を残す。
func newPeerConnection(config webrtc.Configuration) (*webrtc.PeerConnection, error) {
	var settings webrtc.SettingEngine
	settings.SetNetworkTypes([]webrtc.NetworkType{
		webrtc.NetworkTypeUDP4,
		webrtc.NetworkTypeUDP6,
	})
	return webrtc.NewAPI(
		webrtc.WithSettingEngine(settings),
	).NewPeerConnection(config)
}

type Session struct {
	pc          *webrtc.PeerConnection
	track       *webrtc.TrackLocalStaticSample
	dc          *webrtc.DataChannel
	mediaMu     sync.Mutex
	cancelMedia context.CancelFunc
	mediaOpts   hostmedia.Options
	auth        authorizationGate
	// クライアントが映像を見ているか。スマホがバックグラウンドに回ったり
	// 画面が消えたりしているあいだは false になり、キャプチャを止める。
	active   bool
	OnInput  func(data []byte) // DataChannel "input" のテキスト受信 (操作メッセージ)
	OnBinary func(data []byte) // 同バイナリ受信 (音声データのチャンク)
	OnDCOpen func()            // DataChannelが開いた(ホスト→クライアント送信可能)
	OnClosed func()
	OnState  func(state string)
	// 集めた自分のICE候補。offerを送り終えるまでは手元に溜まる。
	ice candidateGate
	// ICE候補の集計。書くのはICEの収集ゴルーチン、読むのは接続状態の
	// 変化を扱うゴルーチンなので、必ずロック越しに扱う。
	iceMu     sync.Mutex
	localICE  candidateSummary
	remoteICE candidateSummary
}

// candidateGate は自分のICE候補を、送り先が決まるまで手元に溜める。
// offerより先に候補を送っても、クライアントはまだどの接続要求のものか
// 結び付けられない (remote descriptionが無いとaddIceCandidateは弾かれる)。
type candidateGate struct {
	mu     sync.Mutex
	send   func(webrtc.ICECandidateInit)
	queued []webrtc.ICECandidateInit
}

func (g *candidateGate) add(c webrtc.ICECandidateInit) {
	g.mu.Lock()
	if g.send == nil {
		g.queued = append(g.queued, c)
		g.mu.Unlock()
		return
	}
	send := g.send
	g.mu.Unlock()
	send(c)
}

// open は送り先を決め、溜めていた候補を集まった順に流す。
// 二度目以降は何もしない(同じ候補を二重に送らない)。
func (g *candidateGate) open(send func(webrtc.ICECandidateInit)) {
	g.mu.Lock()
	if g.send != nil || send == nil {
		g.mu.Unlock()
		return
	}
	g.send = send
	queued := g.queued
	g.queued = nil
	g.mu.Unlock()
	for _, c := range queued {
		send(c)
	}
}

// fmtpLine は実際に送るストリームに見合ったSDPのfmtp行を組み立てる。
// profile-level-id を実態より低く名乗ると、スマホがハードウェアデコーダで
// 扱えないと判断してソフトウェアデコードに落ち、電池と発熱で跳ね返る。
func fmtpLine(opts hostmedia.Options) string {
	opts = opts.Normalize()
	w, h := opts.EncodedSize()
	return "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=" +
		hostmedia.ProfileLevelID(w, h, opts.FPS, opts.BitrateMbps*1000)
}

// sameCapture は2つの設定が同じffmpegパイプラインになるかを返す。
// クライアントは向きの変更などのたびに表示サイズを送ってくるが、送出解像度が
// 変わらないなら再起動する意味はない(そのたびに映像が1秒近く止まる)。
func sameCapture(a, b hostmedia.Options) bool {
	a, b = a.Normalize(), b.Normalize()
	aw, ah := a.EncodedSize()
	bw, bh := b.EncodedSize()
	return aw == bw && ah == bh &&
		a.Display == b.Display && a.X == b.X && a.Y == b.Y && a.W == b.W && a.H == b.H &&
		a.FPS == b.FPS && a.BitrateMbps == b.BitrateMbps
}

// New はPeerConnectionを作り、offer SDPを返す。
//
// ICE収集の完了は待たない。待つと、STUNの応答が遅い回線ではその数秒がまるごと
// 「接続要求を出したのに何も起きない」時間になる。候補はこの後 SendCandidates で
// 送り先を決めてから、集まり次第クライアントへ流す。
func New(mediaOpts hostmedia.Options) (*Session, string, error) {
	pc, err := newPeerConnection(webrtc.Configuration{ICEServers: iceServers})
	if err != nil {
		return nil, "", err
	}
	mediaOpts = mediaOpts.Normalize()
	s := &Session{pc: pc, mediaOpts: mediaOpts, active: true}

	s.track, err = webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeH264,
			SDPFmtpLine: fmtpLine(mediaOpts),
		},
		"video", "remote-screen",
	)
	if err != nil {
		pc.Close()
		return nil, "", err
	}
	rtpSender, err := pc.AddTrack(s.track)
	if err != nil {
		pc.Close()
		return nil, "", err
	}
	// RTCPを読まないと受信側のフィードバックが詰まり、NACK等のinterceptorも
	// 機能しない。映像送信中は必ず排出し、PeerConnection終了時にReadが戻る。
	go drainRTCP(rtpSender)

	dc, err := pc.CreateDataChannel("input", nil)
	if err != nil {
		pc.Close()
		return nil, "", err
	}
	s.dc = dc
	dc.OnOpen(func() {
		if s.auth.markDCOpen() && s.OnDCOpen != nil {
			s.OnDCOpen()
		}
	})
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if !s.auth.allow() {
			return
		}
		if !msg.IsString {
			if s.OnBinary != nil {
				s.OnBinary(msg.Data)
			}
			return
		}
		if s.OnInput != nil {
			s.OnInput(msg.Data)
		}
	})

	pc.OnICECandidate(func(c *webrtc.ICECandidate) {
		if c == nil {
			s.logLocalCandidates() // 収集完了
			return
		}
		init := c.ToJSON()
		s.iceMu.Lock()
		s.localICE.addLine(init.Candidate)
		s.iceMu.Unlock()
		s.ice.add(init)
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("session: 状態 %s", state)
		if s.OnState != nil {
			s.OnState(state.String())
		}
		switch state {
		case webrtc.PeerConnectionStateConnected:
			s.logSelectedPair()
			if s.auth.allow() {
				s.startMedia()
			}
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed,
			webrtc.PeerConnectionStateDisconnected:
			if state == webrtc.PeerConnectionStateFailed {
				s.iceMu.Lock()
				local, remote := s.localICE, s.remoteICE
				s.iceMu.Unlock()
				log.Printf("session: P2P確立に失敗 — %s", diagnoseICEFailure(local, remote))
			}
			s.stopMedia()
			if state != webrtc.PeerConnectionStateDisconnected && s.OnClosed != nil {
				s.OnClosed()
			}
		}
	})

	offer, err := pc.CreateOffer(nil)
	if err != nil {
		pc.Close()
		return nil, "", err
	}
	if err := pc.SetLocalDescription(offer); err != nil {
		pc.Close()
		return nil, "", err
	}
	// 返すのは CreateOffer が作ったSDPそのもの。pc.LocalDescription() は
	// 呼んだ時点までに集まった候補を混ぜて返すため、収集と並行して読むと
	// 中身が呼ぶたびに変わる。認証チャレンジはこのSDP文字列を含むので、
	// クライアントと1バイトも違ってはいけない。
	return s, offer.SDP, nil
}

// SendCandidates は集めたICE候補の送り先を決める。offerを送り終えてから呼ぶ。
// それまでに集まっていた候補も、ここで順にまとめて流れる。
func (s *Session) SendCandidates(send func(webrtc.ICECandidateInit)) {
	s.ice.open(send)
}

type candidateSummary struct {
	counts   map[string]map[string]int
	publicV4 bool
	publicV6 bool
	total    int
	relay    int
}

// addLine は候補1つを数える。SDPの "a=candidate:..." でも、trickleで1つずつ
// 届く "candidate:..." でも同じ集計になるよう、頭の "a=" は落として見る。
func (s *candidateSummary) addLine(line string) {
	line = strings.TrimPrefix(strings.TrimSpace(line), "a=")
	fields := strings.Fields(line)
	if len(fields) < 8 || !strings.HasPrefix(fields[0], "candidate:") || fields[6] != "typ" {
		return
	}
	typ, address := fields[7], fields[4]
	family := "name"
	if ip := net.ParseIP(address); ip != nil {
		if ip.To4() != nil {
			family = "v4"
		} else {
			family = "v6"
		}
		// srflx/relay は外部から見える候補。host はグローバルアドレスだけを
		// 到達可能と数え、LAN内・リンクローカルを誤診断に使わない。
		public := typ == "srflx" || typ == "relay" ||
			(typ == "host" && ip.IsGlobalUnicast() && !ip.IsPrivate())
		if public && family == "v4" {
			s.publicV4 = true
		}
		if public && family == "v6" {
			s.publicV6 = true
		}
	}
	if s.counts == nil {
		s.counts = map[string]map[string]int{}
	}
	if s.counts[typ] == nil {
		s.counts[typ] = map[string]int{}
	}
	s.counts[typ][family]++
	s.total++
	if typ == "relay" {
		s.relay++
	}
}

func summarizeCandidates(sdp string) candidateSummary {
	var s candidateSummary
	for _, line := range strings.Split(sdp, "\n") {
		s.addLine(line)
	}
	return s
}

func (s candidateSummary) count(typ, family string) int { return s.counts[typ][family] }

func (s candidateSummary) String() string {
	return fmt.Sprintf("host[v4=%d v6=%d name=%d] srflx[v4=%d v6=%d] relay=%d",
		s.count("host", "v4"), s.count("host", "v6"), s.count("host", "name"),
		s.count("srflx", "v4"), s.count("srflx", "v6"), s.relay)
}

// logLocalCandidates は自分の候補の収集が終わった時点の内訳を残す。
// trickleでは1つずつ届くので、SDPからまとめて数えることはできない。
func (s *Session) logLocalCandidates() {
	s.iceMu.Lock()
	summary := s.localICE
	s.iceMu.Unlock()
	log.Printf("session: ICE候補(ホスト) %s", summary)
}

func diagnoseICEFailure(local, remote candidateSummary) string {
	if remote.total == 0 {
		return "クライアントからICE候補を受信できませんでした"
	}
	if local.total == 0 {
		return "ホストでICE候補を収集できませんでした"
	}
	if !(local.publicV4 && remote.publicV4) && !(local.publicV6 && remote.publicV6) {
		return "双方から到達可能な共通IP方式がありません (IPv4/IPv6の不一致、またはSTUN失敗)"
	}
	if local.relay == 0 && remote.relay == 0 {
		return "候補は交換できましたがUDPがNAT/ファイアウォールを越えられませんでした (TURN候補なし)"
	}
	return "ICE候補間の疎通に失敗しました (回線またはファイアウォールを確認)"
}

func (s *Session) HandleAnswer(sdp string) error {
	remote := summarizeCandidates(sdp)
	log.Printf("session: ICE候補(クライアント) %s", remote)
	s.iceMu.Lock()
	s.remoteICE = remote
	s.iceMu.Unlock()
	return s.pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  sdp,
	})
}

// AddICECandidate はanswer送信後に集まったクライアント候補を追加する。
func (s *Session) AddICECandidate(candidate string, sdpMid *string, sdpMLineIndex *uint16, usernameFragment *string) error {
	if candidate == "" {
		return nil
	}
	// answerに候補が載らない(クライアントもtrickle)ので、失敗時の診断に使う
	// 集計はここで積む。
	s.iceMu.Lock()
	s.remoteICE.addLine(candidate)
	s.iceMu.Unlock()
	log.Printf("session: クライアントICE候補を追加")
	return s.pc.AddICECandidate(webrtc.ICECandidateInit{
		Candidate:        candidate,
		SDPMid:           sdpMid,
		SDPMLineIndex:    sdpMLineIndex,
		UsernameFragment: usernameFragment,
	})
}

// Authorize はP2P経路の確立後、パスキーまたは再接続チケットの検証に
// 成功した時だけ映像と入力を解禁する。接続確認中のDataChannel入力は捨てる。
func (s *Session) Authorize() {
	changed, dcOpened := s.auth.authorize()
	if !changed {
		return
	}

	if s.pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
		s.startMedia()
	}
	if dcOpened && s.OnDCOpen != nil {
		s.OnDCOpen()
	}
}

// authorizationGate は認証とDataChannelオープンのどちらが先でも、
// 認証前の入力を拒否し、解禁通知を一度だけ行える状態機械。
type authorizationGate struct {
	mu         sync.Mutex
	authorized bool
	dcOpened   bool
}

func (g *authorizationGate) allow() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	return g.authorized
}

// markDCOpen は既に認証済みなら、その場で解禁通知が必要なことを返す。
func (g *authorizationGate) markDCOpen() bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.dcOpened = true
	return g.authorized
}

// authorize は初回だけchanged=trueを返す。dcOpenedは、認証完了時点で
// DataChannelへの解禁通知も必要かを示す。
func (g *authorizationGate) authorize() (changed, dcOpened bool) {
	g.mu.Lock()
	defer g.mu.Unlock()
	if g.authorized {
		return false, g.dcOpened
	}
	g.authorized = true
	return true, g.dcOpened
}

func (s *Session) logSelectedPair() {
	transport := s.pc.SCTP().Transport().ICETransport()
	pair, err := transport.GetSelectedCandidatePair()
	if err != nil || pair == nil {
		log.Printf("session: 選択ICE経路を取得できません: %v", err)
		return
	}
	log.Printf("session: 選択ICE経路 %s/%s:%d(%s) <-> %s/%s:%d(%s)",
		pair.Local.Protocol, pair.Local.Address, pair.Local.Port, pair.Local.Typ,
		pair.Remote.Protocol, pair.Remote.Address, pair.Remote.Port, pair.Remote.Typ)
}

func (s *Session) startMedia() {
	s.mediaMu.Lock()
	// 見ていない相手に送るフレームは、そのぶん丸ごと電力の無駄になる。
	if s.cancelMedia != nil || !s.active {
		s.mediaMu.Unlock()
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancelMedia = cancel
	opts := s.mediaOpts
	s.mediaMu.Unlock()
	ch := make(chan hostmedia.Sample, 8)
	go func() {
		if err := hostmedia.Capture(ctx, opts, ch); err != nil && ctx.Err() == nil {
			log.Printf("session: キャプチャ終了: %v", err)
		}
	}()
	go func() {
		first := true
		for {
			select {
			case <-ctx.Done():
				return
			case sample := <-ch:
				if err := writeSample(s.track, sample); err != nil {
					log.Printf("session: WriteSample失敗: %v", err)
					return
				}
				if first && len(sample.Data) > 0 {
					first = false
					log.Printf("session: 映像RTPへ最初のフレーム投入 (%d bytes)", len(sample.Data))
				}
			}
		}
	}()
}

type rtcpReader interface {
	Read([]byte) (int, interceptor.Attributes, error)
}

func drainRTCP(reader rtcpReader) {
	buf := make([]byte, 1500)
	for {
		if _, _, err := reader.Read(buf); err != nil {
			return
		}
	}
}

// sampleWriter は *webrtc.TrackLocalStaticSample を差し替えられるようにするためだけの型。
type sampleWriter interface {
	WriteSample(media.Sample) error
}

// writeSample は1フレームをトラックへ書く。
//
// Pion の Duration は「このサンプルを送ったあとに時計をどれだけ進めるか」で、
// フレーム自身のタイムスタンプには効かない。間隔をフレームに持たせると、
// RTPタイムスタンプは常に1フレーム前の時刻を指すことになる。
// フレームレートが固定なら1枚ぶんのずれで済むが、dup_frames=0 では前の
// フレームとの間隔が何分にもなりうる。静止のあとに動かした瞬間、
// 「実時間では33msしか経っていないのにRTPでは数分進む」フレームが出て、
// 受け側のジッタバッファが狂う (映像が遅れて出る・固まる)。
// 中身の無いサンプルで先に時計だけ進めておけば、フレームには実際に
// 撮れた時刻が乗る。
func writeSample(track sampleWriter, sample hostmedia.Sample) error {
	if sample.Gap > 0 {
		// Data が空のサンプルはパケットを作らず、時計だけを進める
		if err := track.WriteSample(media.Sample{Duration: sample.Gap}); err != nil {
			return err
		}
	}
	return track.WriteSample(media.Sample{Data: sample.Data})
}

func (s *Session) stopMedia() {
	s.mediaMu.Lock()
	defer s.mediaMu.Unlock()
	if s.cancelMedia != nil {
		s.cancelMedia()
		s.cancelMedia = nil
	}
}

// SetMediaOptions はキャプチャ設定を差し替え、配信中ならキャプチャを再起動する。
// (ディスプレイ切り替え用。エンコーダ再起動でSPS/PPSが再送されるため
// クライアント側デコーダは解像度変更込みで追従できる)
func (s *Session) SetMediaOptions(opts hostmedia.Options) {
	opts = opts.Normalize()
	s.mediaMu.Lock()
	unchanged := sameCapture(s.mediaOpts, opts)
	s.mediaOpts = opts
	running := s.cancelMedia != nil
	s.mediaMu.Unlock()
	if running && !unchanged {
		s.stopMedia()
		s.startMedia()
	}
}

// SetActive はクライアントが映像を見ているかどうかを伝える。
// スマホがバックグラウンドに回る・画面が消えるあいだ送り続けるフレームは
// 誰も見ないまま電波とデコーダを回すだけなので、まるごと止める。
func (s *Session) SetActive(on bool) {
	s.mediaMu.Lock()
	if s.active == on {
		s.mediaMu.Unlock()
		return
	}
	s.active = on
	s.mediaMu.Unlock()

	if !on {
		log.Printf("session: クライアントが非表示 — キャプチャ停止")
		s.stopMedia()
		return
	}
	log.Printf("session: クライアントが復帰 — キャプチャ再開")
	if s.pc.ConnectionState() == webrtc.PeerConnectionStateConnected {
		s.startMedia()
	}
}

// Send はJSONにしてDataChannel "input" でクライアントへ送る。
func (s *Session) Send(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return s.dc.SendText(string(b))
}

func (s *Session) Close() {
	s.stopMedia()
	_ = s.pc.Close()
}

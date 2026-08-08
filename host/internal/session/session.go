// Package session は1クライアントとのWebRTCセッションを管理する。
// ホストがofferを作り、映像トラック(H.264)と入力用DataChannelを持つ。
// ICEはVanilla方式(gathering完了後にSDP一括交換)で、シグナリングを単純に保つ。
package session

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	hostmedia "remotehost/internal/media"
)

var iceServers = []webrtc.ICEServer{
	{URLs: []string{"stun:stun.cloudflare.com:3478"}},
	{URLs: []string{"stun:stun.l.google.com:19302"}},
}

type Session struct {
	pc          *webrtc.PeerConnection
	track       *webrtc.TrackLocalStaticSample
	dc          *webrtc.DataChannel
	mediaMu     sync.Mutex
	cancelMedia context.CancelFunc
	mediaOpts   hostmedia.Options
	// クライアントが映像を見ているか。スマホがバックグラウンドに回ったり
	// 画面が消えたりしているあいだは false になり、キャプチャを止める。
	active    bool
	OnInput   func(data []byte) // DataChannel "input" のテキスト受信 (操作メッセージ)
	OnBinary  func(data []byte) // 同バイナリ受信 (音声データのチャンク)
	OnDCOpen  func()            // DataChannelが開いた(ホスト→クライアント送信可能)
	OnClosed  func()
	OnState   func(state string)
	localICE  candidateSummary
	remoteICE candidateSummary
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

// New はPeerConnectionを作り、gathering完了済みのoffer SDPを返す。
func New(ctx context.Context, mediaOpts hostmedia.Options) (*Session, string, error) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: iceServers})
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
	if _, err := pc.AddTrack(s.track); err != nil {
		pc.Close()
		return nil, "", err
	}

	dc, err := pc.CreateDataChannel("input", nil)
	if err != nil {
		pc.Close()
		return nil, "", err
	}
	s.dc = dc
	dc.OnOpen(func() {
		if s.OnDCOpen != nil {
			s.OnDCOpen()
		}
	})
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
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

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("session: 状態 %s", state)
		if s.OnState != nil {
			s.OnState(state.String())
		}
		switch state {
		case webrtc.PeerConnectionStateConnected:
			s.logSelectedPair()
			s.startMedia()
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed,
			webrtc.PeerConnectionStateDisconnected:
			if state == webrtc.PeerConnectionStateFailed {
				log.Printf("session: P2P確立に失敗 — %s", diagnoseICEFailure(s.localICE, s.remoteICE))
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
	gatherDone := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		pc.Close()
		return nil, "", err
	}
	select {
	case <-gatherDone:
	case <-time.After(10 * time.Second):
		pc.Close()
		return nil, "", fmt.Errorf("ICE gathering タイムアウト")
	case <-ctx.Done():
		pc.Close()
		return nil, "", ctx.Err()
	}
	sdp := pc.LocalDescription().SDP
	s.localICE = logCandidates("ホスト", sdp)
	return s, sdp, nil
}

type candidateSummary struct {
	counts   map[string]map[string]int
	publicV4 bool
	publicV6 bool
	total    int
	relay    int
}

func summarizeCandidates(sdp string) candidateSummary {
	s := candidateSummary{counts: map[string]map[string]int{}}
	for _, line := range strings.Split(sdp, "\n") {
		fields := strings.Fields(strings.TrimSpace(line))
		if len(fields) < 8 || !strings.HasPrefix(fields[0], "a=candidate:") || fields[6] != "typ" {
			continue
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
		if s.counts[typ] == nil {
			s.counts[typ] = map[string]int{}
		}
		s.counts[typ][family]++
		s.total++
		if typ == "relay" {
			s.relay++
		}
	}
	return s
}

func (s candidateSummary) count(typ, family string) int { return s.counts[typ][family] }

func logCandidates(side, sdp string) candidateSummary {
	s := summarizeCandidates(sdp)
	log.Printf("session: ICE候補(%s) host[v4=%d v6=%d name=%d] srflx[v4=%d v6=%d] relay=%d",
		side, s.count("host", "v4"), s.count("host", "v6"), s.count("host", "name"),
		s.count("srflx", "v4"), s.count("srflx", "v6"), s.relay)
	return s
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
	s.remoteICE = logCandidates("クライアント", sdp)
	return s.pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  sdp,
	})
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
		for {
			select {
			case <-ctx.Done():
				return
			case sample := <-ch:
				if err := writeSample(s.track, sample); err != nil {
					log.Printf("session: WriteSample失敗: %v", err)
					return
				}
			}
		}
	}()
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

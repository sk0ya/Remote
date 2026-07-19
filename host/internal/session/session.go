// Package session は1クライアントとのWebRTCセッションを管理する。
// ホストがofferを作り、映像トラック(H.264)と入力用DataChannelを持つ。
// ICEはVanilla方式(gathering完了後にSDP一括交換)で、シグナリングを単純に保つ。
package session

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
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
	OnInput     func(data []byte) // DataChannel "input" の受信
	OnDCOpen    func()            // DataChannelが開いた(ホスト→クライアント送信可能)
	OnClosed    func()
	OnState     func(state string)
}

// New はPeerConnectionを作り、gathering完了済みのoffer SDPを返す。
func New(ctx context.Context, mediaOpts hostmedia.Options) (*Session, string, error) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: iceServers})
	if err != nil {
		return nil, "", err
	}
	s := &Session{pc: pc, mediaOpts: mediaOpts}

	s.track, err = webrtc.NewTrackLocalStaticSample(
		webrtc.RTPCodecCapability{
			MimeType:    webrtc.MimeTypeH264,
			SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
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
			s.startMedia()
		case webrtc.PeerConnectionStateFailed, webrtc.PeerConnectionStateClosed,
			webrtc.PeerConnectionStateDisconnected:
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
	return s, pc.LocalDescription().SDP, nil
}

func (s *Session) HandleAnswer(sdp string) error {
	return s.pc.SetRemoteDescription(webrtc.SessionDescription{
		Type: webrtc.SDPTypeAnswer,
		SDP:  sdp,
	})
}

func (s *Session) startMedia() {
	s.mediaMu.Lock()
	if s.cancelMedia != nil {
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
				if err := s.track.WriteSample(media.Sample{
					Data:     sample.Data,
					Duration: sample.Duration,
				}); err != nil {
					log.Printf("session: WriteSample失敗: %v", err)
					return
				}
			}
		}
	}()
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
	s.mediaMu.Lock()
	s.mediaOpts = opts
	running := s.cancelMedia != nil
	s.mediaMu.Unlock()
	if running {
		s.stopMedia()
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

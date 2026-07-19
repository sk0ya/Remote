// Package session は1クライアントとのWebRTCセッションを管理する。
// ホストがofferを作り、映像トラック(H.264)と入力用DataChannelを持つ。
// ICEはVanilla方式(gathering完了後にSDP一括交換)で、シグナリングを単純に保つ。
package session

import (
	"context"
	"fmt"
	"log"
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
	cancelMedia context.CancelFunc
	OnInput     func(data []byte) // DataChannel "input" の受信 (task4で使用)
	OnClosed    func()
}

// New はPeerConnectionを作り、gathering完了済みのoffer SDPを返す。
func New(ctx context.Context) (*Session, string, error) {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{ICEServers: iceServers})
	if err != nil {
		return nil, "", err
	}
	s := &Session{pc: pc}

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
	dc.OnMessage(func(msg webrtc.DataChannelMessage) {
		if s.OnInput != nil {
			s.OnInput(msg.Data)
		}
	})

	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		log.Printf("session: 状態 %s", state)
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
	if s.cancelMedia != nil {
		return
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.cancelMedia = cancel
	ch := make(chan hostmedia.Sample, 8)
	go func() {
		if err := hostmedia.Capture(ctx, ch); err != nil && ctx.Err() == nil {
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
	if s.cancelMedia != nil {
		s.cancelMedia()
		s.cancelMedia = nil
	}
}

func (s *Session) Send(data []byte) error {
	return nil // 予約: ホスト→クライアントのDataChannel送信(必要時に実装)
}

func (s *Session) Close() {
	s.stopMedia()
	_ = s.pc.Close()
}

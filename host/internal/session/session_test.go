package session

import (
	"strings"
	"testing"
	"time"

	"github.com/pion/rtp"
	"github.com/pion/rtp/codecs"
	"github.com/pion/webrtc/v4/pkg/media"

	hostmedia "remotehost/internal/media"
)

// フレーム自身に間隔を持たせると、RTPタイムスタンプは1フレーム前の時刻を指す。
// フレームレートが固定ならずれは1枚ぶんだが、dup_frames=0 では前のフレームとの
// 間隔が何分にもなりうるので、静止のあとに動かした瞬間「実時間では33msなのに
// RTPでは数分進む」フレームが出て、受け側のジッタバッファが狂う。
// 先に時計だけ進めておけば、各フレームのタイムスタンプは撮れた時刻に一致する。
func TestWriteSampleStampsFramesAtCaptureTime(t *testing.T) {
	w := &recordingWriter{}
	// 33ms → 5分静止 → 33ms
	gaps := []time.Duration{0, 33 * time.Millisecond, 5 * time.Minute, 33 * time.Millisecond}
	for i, gap := range gaps {
		if err := writeSample(w, hostmedia.Sample{Data: []byte{byte(i)}, Gap: gap}); err != nil {
			t.Fatalf("writeSample: %v", err)
		}
	}

	// 中身のあるサンプルの直前までに積まれた時間 = そのフレームが撮れた時刻
	var elapsed, want time.Duration
	frames := 0
	for _, s := range w.samples {
		if len(s.Data) == 0 {
			elapsed += s.Duration // 時計だけ進めるサンプル
			continue
		}
		want += gaps[frames]
		if elapsed != want {
			t.Errorf("%d枚目のタイムスタンプ = %v, want %v", frames+1, elapsed, want)
		}
		if s.Duration != 0 {
			t.Errorf("%d枚目に長さが付いている (次のフレームの時刻がずれる): %v", frames+1, s.Duration)
		}
		frames++
	}
	if frames != len(gaps) {
		t.Errorf("書いたフレーム数 %d, want %d", frames, len(gaps))
	}
}

// 上のやり方は「中身の無いサンプルはパケットを作らず時計だけ進める」という
// Pionの挙動に乗っている。ここが変わると、静止のたびに無音のパケットが
// 飛ぶか、時計が進まなくなる。
func TestEmptySampleOnlyAdvancesTheClock(t *testing.T) {
	p := rtp.NewPacketizer(1200, 96, 1, &codecs.H264Payloader{}, rtp.NewRandomSequencer(), 90000)

	if pkts := p.Packetize(nil, 90000); len(pkts) != 0 {
		t.Fatalf("中身が無いのにパケットが出た: %d", len(pkts))
	}
	pkts := p.Packetize([]byte{0, 0, 0, 1, 0x65, 0x88}, 0)
	if len(pkts) == 0 {
		t.Fatal("フレームがパケットにならなかった")
	}
	first := pkts[0].Timestamp

	p.Packetize(nil, 90000) // 1秒ぶん進める
	pkts = p.Packetize([]byte{0, 0, 0, 1, 0x65, 0x88}, 0)
	if got := pkts[0].Timestamp - first; got != 90000 {
		t.Errorf("空サンプルで進んだ時間 = %d ticks, want 90000", got)
	}
}

type recordingWriter struct {
	samples []media.Sample
}

func (w *recordingWriter) WriteSample(s media.Sample) error {
	w.samples = append(w.samples, s)

	return nil
}

// SDPで名乗る profile-level-id は、実際に送るストリームに見合っていなければならない。
// 以前は解像度に関わらず 3.1 (最大1280x720@30) 固定を名乗りながら4Kをそのまま
// 流していたため、スマホがハードウェアデコーダを使えずソフトウェアデコードに
// 落ちる余地があった。いまは720pまで落としてから送るので 3.1 は正直な宣言になる。
func TestFmtpLineMatchesEncodedStream(t *testing.T) {
	tests := []struct {
		name string
		opts hostmedia.Options
		want string
	}{
		{"4Kモニタでも送るのは720pなので3.1",
			hostmedia.Options{W: 3840, H: 2160, FPS: 30, BitrateMbps: 4}, "42e01f"},
		{"小さいモニタでも下限は3.1",
			hostmedia.Options{W: 1024, H: 600, FPS: 30, BitrateMbps: 4}, "42e01f"},
		{"60fpsならレベルが上がる",
			hostmedia.Options{W: 2560, H: 1440, FPS: 60, BitrateMbps: 4}, "42e020"},
		{"モニタ不明なら安全側に倒す",
			hostmedia.Options{FPS: 30, BitrateMbps: 4}, "42e034"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := fmtpLine(tt.opts)
			if !strings.Contains(got, "profile-level-id="+tt.want) {
				t.Errorf("fmtpLine() = %q, want profile-level-id=%s", got, tt.want)
			}
			// パケット化モードを落とすと映像が出なくなる
			if !strings.Contains(got, "packetization-mode=1") {
				t.Errorf("packetization-mode が落ちている: %q", got)
			}
		})
	}
}

// クライアントは向きの変更やアドレスバーの伸縮のたびに表示サイズを送ってくる。
// 送出解像度が変わらない申告でキャプチャを再起動すると、そのたびに映像が
// 1秒近く止まり、ffmpeg起動ぶんの電力も無駄に使う。
func TestSameCaptureIgnoresHarmlessChanges(t *testing.T) {
	base := hostmedia.Options{W: 2560, H: 1440, FPS: 30, BitrateMbps: 4, MaxW: 800, MaxH: 450}

	same := base
	same.MaxW, same.MaxH = 801, 451 // 偶数へ丸めた結果は 800x450 のまま変わらない
	if !sameCapture(base, same) {
		t.Errorf("送出解像度が同じなのに再起動すると判定された")
	}

	bigger := base
	bigger.MaxW, bigger.MaxH = 1280, 720
	if sameCapture(base, bigger) {
		t.Errorf("送出解像度が変わるのに再起動しないと判定された")
	}

	otherDisplay := base
	otherDisplay.Display = 1
	if sameCapture(base, otherDisplay) {
		t.Errorf("モニタが変わるのに再起動しないと判定された")
	}

	slower := base
	slower.FPS = 15
	if sameCapture(base, slower) {
		t.Errorf("fpsが変わるのに再起動しないと判定された")
	}
}

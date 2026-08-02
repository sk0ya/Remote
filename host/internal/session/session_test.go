package session

import (
	"strings"
	"testing"

	hostmedia "remotehost/internal/media"
)

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

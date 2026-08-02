package signal

import (
	"testing"
	"time"
)

// 以前は接続に成功しても待ち時間を戻していなかったため、数回切れたあとは
// 何時間安定していようが再接続まで常に上限(32秒)かかっていた。
// その間ホストは部屋に居らず、スマホからは「接続できない」ように見える。
func TestBackoffAfter(t *testing.T) {
	tests := []struct {
		name   string
		prev   time.Duration
		lasted time.Duration
		want   time.Duration
	}{
		{"最初の失敗", 0, 0, time.Second},
		{"落ち続けるあいだは倍々", time.Second, time.Second, 2 * time.Second},
		{"上限で頭打ち", 20 * time.Second, time.Second, maxBackoff},
		{"上限を超えない", maxBackoff, time.Second, maxBackoff},
		{"安定後の切断は仕切り直し", maxBackoff, time.Hour, minBackoff},
		{"安定の境目ちょうど", maxBackoff, stableAfter, minBackoff},
		{"安定と言うには短い", 4 * time.Second, stableAfter - time.Second, 8 * time.Second},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := backoffAfter(tt.prev, tt.lasted); got != tt.want {
				t.Errorf("backoffAfter(%v, %v) = %v, want %v", tt.prev, tt.lasted, got, tt.want)
			}
		})
	}
}

// 切断中に積まれた送信待ちは、もう居ない相手への返事なので繋ぎ直す前に捨てる。
func TestDrainSend(t *testing.T) {
	c := New("ws://example.invalid/ws", "ROOM", Handlers{})
	c.Send(map[string]string{"t": "offer"})
	c.Send(map[string]string{"t": "offer"})
	if len(c.sendCh) != 2 {
		t.Fatalf("送信キューに積まれていない: %d", len(c.sendCh))
	}
	c.drainSend()
	if len(c.sendCh) != 0 {
		t.Errorf("キューが残っている: %d", len(c.sendCh))
	}
}

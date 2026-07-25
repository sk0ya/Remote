package stt

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// 認識エンジンとffmpegが揃っている環境でのみ実行する統合テスト。
// testdata/memo.webm はブラウザの録音と同じ webm/opus で、「メモ帳を開いて」と話している。
func TestRecognize(t *testing.T) {
	// 既定はリポジトリ内の stt/ (host/internal/stt から見た相対)
	workDir := envOr("REMOTE_STT_DIR", filepath.Join("..", "..", "..", "stt"))
	cmdPath := envOr("REMOTE_STT_COMMAND",
		filepath.Join(workDir, "target", "release", "remote-stt.exe"))

	e := New(cmdPath, workDir)
	if !e.Available() {
		t.Skipf("認識エンジンが無いのでスキップ: %s", cmdPath)
	}
	defer e.Close()

	audio, err := os.ReadFile("testdata/memo.webm")
	if err != nil {
		t.Fatal(err)
	}
	text, err := e.Recognize(audio)
	if err != nil {
		t.Fatalf("Recognize: %v", err)
	}
	if !strings.Contains(text, "メモ帳") {
		t.Errorf("認識結果 = %q, 「メモ帳」を含むことを期待", text)
	}

	// 2回目も同じプロセスを使い回して認識できること (常駐前提の作りのため)
	again, err := e.Recognize(audio)
	if err != nil {
		t.Fatalf("2回目のRecognize: %v", err)
	}
	if again != text {
		t.Errorf("2回目の認識結果 = %q, 1回目 = %q", again, text)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

package input

import (
	"os"
	"strconv"
	"testing"
	"time"
	"unsafe"
)

func TestButtonFlagMapsButtons(t *testing.T) {
	tests := []struct {
		b    int
		up   bool
		want uint32
		ok   bool
	}{
		{0, false, mouseeventfLeftDown, true},
		{0, true, mouseeventfLeftUp, true},
		{1, false, mouseeventfMiddleDown, true},
		{1, true, mouseeventfMiddleUp, true},
		{2, false, mouseeventfRightDown, true},
		{2, true, mouseeventfRightUp, true},
		{3, false, 0, false},
		{-1, true, 0, false},
	}
	for _, tt := range tests {
		got, ok := buttonFlag(tt.b, tt.up)
		if got != tt.want || ok != tt.ok {
			t.Errorf("buttonFlag(%d, up=%v) = 0x%x,%v — want 0x%x,%v", tt.b, tt.up, got, ok, tt.want, tt.ok)
		}
	}
}

// 同じ知らせを連発しない (マウス移動は毎秒何十発も来る)。
// 内容が変わったときは状況が変わったということなので、待たずに出す。
func TestNoticeThrottlesRepeats(t *testing.T) {
	t.Cleanup(func() {
		OnNotice(nil)
		noticeMu.Lock()
		noticeAt, noticeLast = time.Time{}, ""
		noticeMu.Unlock()
	})

	var got []string
	OnNotice(func(s string) { got = append(got, s) })
	noticeMu.Lock()
	noticeAt, noticeLast = time.Time{}, ""
	noticeMu.Unlock()

	for range 10 {
		notice("届きません")
	}
	if len(got) != 1 {
		t.Fatalf("同じ知らせが %d 回 (1回にまとめたい): %v", len(got), got)
	}
	notice("別の知らせ")
	if len(got) != 2 {
		t.Fatalf("内容が変わった知らせが出ていない: %v", got)
	}

	noticeMu.Lock()
	noticeAt = time.Now().Add(-noticeInterval - time.Second)
	noticeMu.Unlock()
	notice("別の知らせ")
	if len(got) != 3 {
		t.Fatalf("間隔を空けた後に出ていない: %v", got)
	}
}

// 前面ロックの一時解除は、必ず元の値に戻ること。
// 戻し忘れると「アプリが勝手に前面へ出てくる」設定がセッション中ずっと残る。
func TestLockTimeoutIsRestored(t *testing.T) {
	original := readLockTimeout()
	t.Cleanup(func() { writeLockTimeout(original) })

	// ロックが効いているPC (既定は200秒) を再現する
	writeLockTimeout(200000)
	if got := readLockTimeout(); got != 200000 {
		t.Skipf("前面ロック時間を変更できない環境のためスキップ (%d ms)", got)
	}

	prev, changed := clearLockTimeout()
	if !changed || prev != 200000 {
		t.Fatalf("clearLockTimeout() = %d,%v — 200000,true が欲しい", prev, changed)
	}
	if got := readLockTimeout(); got != 0 {
		t.Fatalf("解除後のロック時間が %d ms (0であるべき)", got)
	}

	restoreLockTimeout(prev, changed)
	if got := readLockTimeout(); got != 200000 {
		t.Fatalf("戻した後のロック時間が %d ms (200000であるべき)", got)
	}

	// もともと0のPCでは触らない (戻すときに勝手に有効化しない)
	writeLockTimeout(0)
	if prev, changed := clearLockTimeout(); changed {
		t.Errorf("もともと無効なのに触った (prev=%d)", prev)
	}
}

func readLockTimeout() uint32 {
	var v uint32
	procSystemParametersInfo.Call(spiGetForegroundLockTimeout, 0, uintptr(unsafe.Pointer(&v)), 0)
	return v
}

func writeLockTimeout(ms uint32) {
	procSystemParametersInfo.Call(spiSetForegroundLockTimeout, 0, uintptr(ms), 0)
}

// 実機確認。権限の高いウィンドウ(管理者権限アプリ)を前面にして実行すると、
//  1. その状態では SendInput が成功を返すのにカーソルが動かないこと
//  2. unblock() で塞がりが解け、動くようになること
//
// を確かめる。前面が通常のウィンドウならスキップするので、普段の go test では走らない。
// 走った場合は前面のウィンドウがデスクトップに変わる(それがこの機能の動作そのもの)。
//
// 手で確かめるときは、管理者権限のウィンドウを前面にする猶予を作れる:
//
//	REMOTE_UIPI_WAIT=60 go test ./internal/input/ -run TestUnblock -v
//
// (テスト自身は昇格していない必要があるので、管理者のコンソールからは実行しないこと)
func TestUnblockRestoresInputUnderElevatedWindow(t *testing.T) {
	waitForElevatedForeground(t)
	if blockedBy() == 0 {
		t.Skip("権限の高いウィンドウが前面にないためスキップ (管理者権限のアプリを前面にすると走る)")
	}

	fromX, fromY := cursorPoint()
	t.Cleanup(func() { moveToPixel(fromX, fromY) })

	toX, toY := fromX+60, fromY+40
	if moveToPixel(toX, toY); cursorAt(toX, toY) {
		t.Fatal("権限の高いウィンドウが前面なのにカーソルが動いた — 前提が崩れている")
	}

	if !unblock() {
		t.Fatal("unblock() が前面を奪えなかった")
	}
	if fg := blockedBy(); fg != 0 {
		t.Fatalf("unblock() 後も塞がれたまま (hwnd=0x%x)", fg)
	}
	if moveToPixel(toX, toY); !cursorAt(toX, toY) {
		t.Fatal("unblock() 後もカーソルが動かない")
	}
}

// waitForElevatedForeground は REMOTE_UIPI_WAIT=<秒> が指定されていれば、
// 権限の高いウィンドウが前面になるまでその秒数だけ待つ。手で確かめるとき用。
func waitForElevatedForeground(t *testing.T) {
	sec, err := strconv.Atoi(os.Getenv("REMOTE_UIPI_WAIT"))
	if err != nil || sec <= 0 {
		return
	}
	t.Logf("管理者権限のウィンドウを前面にしてください (最大%d秒待ちます)", sec)
	deadline := time.Now().Add(time.Duration(sec) * time.Second)
	for time.Now().Before(deadline) {
		if blockedBy() != 0 {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
}

// moveToPixel は画面ピクセル座標へカーソルを動かそうとする(届くとは限らない)。
func moveToPixel(x, y int32) {
	w, h := metric(smCxScreen), metric(smCyScreen)
	if w <= 1 || h <= 1 {
		return
	}
	sendMouse(mouseInput{
		dx:      int32(float64(x) / (w - 1) * 65535),
		dy:      int32(float64(y) / (h - 1) * 65535),
		dwFlags: mouseeventfMove | mouseeventfAbsolute,
	})
	time.Sleep(80 * time.Millisecond) // 注入は非同期。反映を待つ
}

func cursorAt(wantX, wantY int32) bool {
	x, y := cursorPoint()
	return abs32(x-wantX) <= 2 && abs32(y-wantY) <= 2
}

func abs32(v int32) int32 {
	if v < 0 {
		return -v
	}
	return v
}

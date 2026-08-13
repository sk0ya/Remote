package input

import (
	"fmt"
	"log"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// 権限の高いウィンドウ(管理者権限アプリ)が前面にあるあいだ、Windowsは
// 下位プロセスからの入力を捨てる(UIPI)。やっかいなのは、SendInputが
// 成功を返すのにカーソルが1pxも動かないこと — MSDNにも
// 「戻り値もGetLastErrorも失敗を示さない」と書かれている。
// つまり送ってから気づくことはできないので、前面のウィンドウを見て判断する。
//
// この状態からの復帰も、そのままではスマホ側から手が出せない。カーソルが
// 動かせない以上、管理者ウィンドウの外をクリックして前面から外すこともできず、
// 行き止まりになる。そこで、クリックが来たときにデスクトップを前面にして
// 塞がりを解いてから、そのクリックを送る。
// (デスクトップを前面にするのは権限の低いウィンドウ同士のやりとりなので通る)

var (
	procGetForegroundWindow      = user32.NewProc("GetForegroundWindow")
	procSetForegroundWindow      = user32.NewProc("SetForegroundWindow")
	procGetWindowThreadProcessId = user32.NewProc("GetWindowThreadProcessId")
	procWindowFromPoint          = user32.NewProc("WindowFromPoint")
	procGetAncestor              = user32.NewProc("GetAncestor")
	procGetShellWindow           = user32.NewProc("GetShellWindow")
	procFindWindow               = user32.NewProc("FindWindowW")
	procGetCursorPos             = user32.NewProc("GetCursorPos")
	procSystemParametersInfo     = user32.NewProc("SystemParametersInfoW")
)

const (
	gaRoot = 2 // GetAncestor: 最上位の親ウィンドウ

	spiGetForegroundLockTimeout = 0x2000
	spiSetForegroundLockTimeout = 0x2001
)

// selfIntegrity は自分の整合性レベル。プロセス中で変わらないので一度だけ調べる。
var selfIntegrity = sync.OnceValue(func() uint32 {
	rid, err := processIntegrity(windows.GetCurrentProcessId())
	if err != nil {
		log.Printf("input: 自分の整合性レベルを取得できません: %v", err)
		return 0x2000 // 中(通常のユーザープロセス)とみなす
	}
	return rid
})

// 前面ウィンドウの判定結果。ウィンドウが変わらないかぎり結果も変わらないので、
// 入力1件ごとにプロセスを開き直さずに済むよう覚えておく。
var (
	fgMu     sync.Mutex
	fgWindow uintptr
	fgHigher bool
)

// blockedBy は入力を捨てさせている前面ウィンドウを返す。塞がれていなければ0。
func blockedBy() uintptr {
	h, _, _ := procGetForegroundWindow.Call()
	if h == 0 {
		return 0
	}
	fgMu.Lock()
	defer fgMu.Unlock()
	if h != fgWindow {
		fgWindow, fgHigher = h, higherThanSelf(h)
	}
	if !fgHigher {
		return 0
	}
	return h
}

// higherThanSelf はウィンドウの持ち主が自分より強い権限で動いているかを返す。
func higherThanSelf(hwnd uintptr) bool {
	if hwnd == 0 {
		return false
	}
	var pid uint32
	procGetWindowThreadProcessId.Call(hwnd, uintptr(unsafe.Pointer(&pid)))
	rid, err := processIntegrity(pid)
	if err != nil {
		// 開けないほど強い相手 (システム権限など) の可能性が高いが、
		// 決めつけずに「塞がれていない」側に倒す。誤検知で勝手に前面を
		// 奪うほうが害が大きい。
		return false
	}
	return rid > selfIntegrity()
}

// processIntegrity はプロセスの整合性レベル(RID)を返す。0x2000=中, 0x3000=高。
func processIntegrity(pid uint32) (uint32, error) {
	h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return 0, fmt.Errorf("OpenProcess(pid=%d): %w", pid, err)
	}
	defer windows.CloseHandle(h)
	var tok windows.Token
	if err := windows.OpenProcessToken(h, windows.TOKEN_QUERY, &tok); err != nil {
		return 0, fmt.Errorf("OpenProcessToken(pid=%d): %w", pid, err)
	}
	defer tok.Close()
	var n uint32
	windows.GetTokenInformation(tok, windows.TokenIntegrityLevel, nil, 0, &n)
	if n == 0 {
		return 0, fmt.Errorf("整合性レベルの長さが取れません (pid=%d)", pid)
	}
	buf := make([]byte, n)
	if err := windows.GetTokenInformation(tok, windows.TokenIntegrityLevel, &buf[0], n, &n); err != nil {
		return 0, fmt.Errorf("GetTokenInformation(pid=%d): %w", pid, err)
	}
	label := (*windows.Tokenmandatorylabel)(unsafe.Pointer(&buf[0]))
	sid := label.Label.Sid
	return sid.SubAuthority(uint32(sid.SubAuthorityCount()) - 1), nil
}

// cursorPoint は今のカーソル位置(画面ピクセル)を返す。
func cursorPoint() (int32, int32) {
	var pt struct{ X, Y int32 }
	procGetCursorPos.Call(uintptr(unsafe.Pointer(&pt)))
	return pt.X, pt.Y
}

// windowAt は画面座標(ピクセル)にある最上位ウィンドウを返す。
func windowAt(x, y int32) uintptr {
	// POINTは8バイトの構造体で、x64では1レジスタに詰めて渡される。
	h, _, _ := procWindowFromPoint.Call(uintptr(uint32(x)) | uintptr(uint32(y))<<32)
	if h == 0 {
		return 0
	}
	root, _, _ := procGetAncestor.Call(h, gaRoot)
	return root
}

// unblock は前面から権限の高いウィンドウを外して、入力が通る状態に戻す。
// ウィンドウの配置は変えず、デスクトップを前面にするだけ
// (このあと送るクリックが、押した先のウィンドウを自分で前面にする)。
//
// 前面ロックを外してから試す。Windowsには「直近のユーザー操作から一定時間
// (既定200秒)は、アプリが勝手に前面へ出ることを許さない」仕組みがあり、
// これに当たると SetForegroundWindow は成功を返しながら何も起きない。
// 開発環境ではこの設定が0msでこの状態を再現できていない (=保険) が、
// 既定値のPCでは、誰かが管理者ウィンドウをクリックした直後がこれに当たる。
func unblock() bool {
	defer restoreLockTimeout(clearLockTimeout())

	// 前面の入れ替えは即座に見えるとはかぎらないので、少しのあいだ繰り返す。
	// ここで早合点すると、通るはずのクリックを捨ててしまう。
	for round := range unblockRounds {
		if round > 0 {
			time.Sleep(unblockWait)
		}
		for _, h := range desktopWindows() {
			if h == 0 {
				continue
			}
			procSetForegroundWindow.Call(h)
			if blockedBy() == 0 {
				return true
			}
		}
	}
	return false
}

const (
	unblockRounds = 5
	unblockWait   = 40 * time.Millisecond
)

// clearLockTimeout は前面ロックを一時的に無効にし、元の値を返す。
// レジストリには書かない(fWinIni=0)ので、変わるのはこのセッションの設定だけ。
func clearLockTimeout() (prev uint32, ok bool) {
	if r, _, _ := procSystemParametersInfo.Call(
		spiGetForegroundLockTimeout, 0, uintptr(unsafe.Pointer(&prev)), 0); r == 0 {
		return 0, false
	}
	if prev == 0 {
		return 0, false // もともと無効。触らない
	}
	r, _, _ := procSystemParametersInfo.Call(spiSetForegroundLockTimeout, 0, 0, 0)
	return prev, r != 0
}

func restoreLockTimeout(prev uint32, changed bool) {
	if !changed {
		return
	}
	procSystemParametersInfo.Call(spiSetForegroundLockTimeout, 0, uintptr(prev), 0)
}

// desktopWindows は逃がし先の候補。どれもエクスプローラー(通常権限)のウィンドウ。
func desktopWindows() []uintptr {
	shell, _, _ := procGetShellWindow.Call()
	progman, _, _ := procFindWindow.Call(strPtr("Progman"), 0)
	tray, _, _ := procFindWindow.Call(strPtr("Shell_TrayWnd"), 0)
	return []uintptr{shell, progman, tray}
}

func strPtr(s string) uintptr {
	return uintptr(unsafe.Pointer(windows.StringToUTF16Ptr(s)))
}

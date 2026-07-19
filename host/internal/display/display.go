// Package display は接続中のモニタを列挙する。
// 並び順はデバイス名 (\\.\DISPLAY1, \\.\DISPLAY2, ...) の番号順で安定させる。
// ffmpeg ddagrab の output_idx (DXGIのアダプタ内出力順) と一致する前提を置く。
// マルチGPU構成では一致しない可能性があるが、単一アダプタでは通常一致する。
package display

import (
	"sort"
	"sync"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32                  = windows.NewLazySystemDLL("user32.dll")
	procEnumDisplayMonitors = user32.NewProc("EnumDisplayMonitors")
	procGetMonitorInfoW     = user32.NewProc("GetMonitorInfoW")
)

const monitorinfofPrimary = 1

type winRect struct {
	Left, Top, Right, Bottom int32
}

type monitorInfoEx struct {
	CbSize    uint32
	RcMonitor winRect
	RcWork    winRect
	DwFlags   uint32
	SzDevice  [32]uint16
}

// Monitor は1台のモニタ。座標は仮想デスクトップ(プライマリ左上原点)基準。
type Monitor struct {
	X, Y, W, H int
	Primary    bool
	Device     string
}

var (
	enumMu    sync.Mutex
	collected []Monitor
	// syscall.NewCallback は生成数に上限があるため1度だけ作る
	enumCB = syscall.NewCallback(func(hMon, hdc, lprc, lparam uintptr) uintptr {
		var mi monitorInfoEx
		mi.CbSize = uint32(unsafe.Sizeof(mi))
		r, _, _ := procGetMonitorInfoW.Call(hMon, uintptr(unsafe.Pointer(&mi)))
		if r != 0 {
			collected = append(collected, Monitor{
				X:       int(mi.RcMonitor.Left),
				Y:       int(mi.RcMonitor.Top),
				W:       int(mi.RcMonitor.Right - mi.RcMonitor.Left),
				H:       int(mi.RcMonitor.Bottom - mi.RcMonitor.Top),
				Primary: mi.DwFlags&monitorinfofPrimary != 0,
				Device:  windows.UTF16ToString(mi.SzDevice[:]),
			})
		}
		return 1 // 列挙続行
	})
)

// List はモニタ一覧をデバイス番号順で返す。失敗時は空スライス。
func List() []Monitor {
	enumMu.Lock()
	defer enumMu.Unlock()
	collected = nil
	procEnumDisplayMonitors.Call(0, 0, enumCB, 0)
	mons := collected
	collected = nil
	sort.Slice(mons, func(i, j int) bool {
		return deviceNum(mons[i].Device) < deviceNum(mons[j].Device)
	})
	return mons
}

// PrimaryIndex はプライマリモニタのインデックスを返す。見つからなければ0。
func PrimaryIndex(mons []Monitor) int {
	for i, m := range mons {
		if m.Primary {
			return i
		}
	}
	return 0
}

// deviceNum は "\\.\DISPLAY12" 末尾の数値を取り出す。
func deviceNum(dev string) int {
	n := 0
	for _, c := range dev {
		if c >= '0' && c <= '9' {
			n = n*10 + int(c-'0')
		} else {
			n = 0
		}
	}
	return n
}

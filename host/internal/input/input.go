// Package input はクライアントからの操作メッセージをWindowsに注入する。
// マウスは正規化絶対座標(0..1)、キーはJSのKeyboardEvent.code、
// テキストはKEYEVENTF_UNICODEで送る。
package input

import (
	"encoding/json"
	"log"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32       = windows.NewLazySystemDLL("user32.dll")
	procSendInput = user32.NewProc("SendInput")
)

const (
	inputMouse    = 0
	inputKeyboard = 1

	mouseeventfMove       = 0x0001
	mouseeventfLeftDown   = 0x0002
	mouseeventfLeftUp     = 0x0004
	mouseeventfRightDown  = 0x0008
	mouseeventfRightUp    = 0x0010
	mouseeventfMiddleDown = 0x0020
	mouseeventfMiddleUp   = 0x0040
	mouseeventfWheel      = 0x0800
	mouseeventfHWheel     = 0x1000
	mouseeventfAbsolute   = 0x8000

	keyeventfExtendedkey = 0x0001
	keyeventfKeyup       = 0x0002
	keyeventfUnicode     = 0x0004
	keyeventfScancode    = 0x0008
)

// INPUT構造体 (x64): type(4) + pad(4) + union(32) = 40 bytes
type mouseInput struct {
	typ         uint32
	_           uint32
	dx          int32
	dy          int32
	mouseData   int32
	dwFlags     uint32
	time        uint32
	_           uint32
	dwExtraInfo uintptr
}

type keybdInput struct {
	typ         uint32
	_           uint32
	wVk         uint16
	wScan       uint16
	dwFlags     uint32
	time        uint32
	_           uint32
	dwExtraInfo uintptr
	_           [8]byte // MOUSEINPUTとのサイズ差を埋める
}

func sendMouse(mi mouseInput) {
	mi.typ = inputMouse
	procSendInput.Call(1, uintptr(unsafe.Pointer(&mi)), unsafe.Sizeof(mi))
}

func sendKey(ki keybdInput) {
	ki.typ = inputKeyboard
	procSendInput.Call(1, uintptr(unsafe.Pointer(&ki)), unsafe.Sizeof(ki))
}

// Msg はDataChannel経由の操作メッセージ。
type Msg struct {
	T    string  `json:"t"`
	X    float64 `json:"x,omitempty"`    // mv: 正規化座標 0..1
	Y    float64 `json:"y,omitempty"`
	B    int     `json:"b,omitempty"`    // dn/up: 0=左 1=中 2=右
	DX   float64 `json:"dx,omitempty"`   // wh: ホイールノッチ数
	DY   float64 `json:"dy,omitempty"`
	Code string  `json:"code,omitempty"` // key: KeyboardEvent.code
	Down bool    `json:"down,omitempty"`
	S    string  `json:"s,omitempty"`    // txt: 入力テキスト
}

// Handle は1メッセージを処理する。
func Handle(data []byte) {
	var m Msg
	if err := json.Unmarshal(data, &m); err != nil {
		return
	}
	switch m.T {
	case "mv":
		sendMouse(mouseInput{
			dx:      int32(clamp01(m.X) * 65535),
			dy:      int32(clamp01(m.Y) * 65535),
			dwFlags: mouseeventfMove | mouseeventfAbsolute,
		})
	case "dn", "up":
		var flag uint32
		switch m.B {
		case 0:
			flag = mouseeventfLeftDown
		case 1:
			flag = mouseeventfMiddleDown
		case 2:
			flag = mouseeventfRightDown
		default:
			return
		}
		if m.T == "up" {
			flag <<= 1 // 各ボタンのUPフラグはDOWNの2倍値
		}
		sendMouse(mouseInput{dwFlags: flag})
	case "wh":
		if m.DY != 0 {
			sendMouse(mouseInput{dwFlags: mouseeventfWheel, mouseData: int32(m.DY * 120)})
		}
		if m.DX != 0 {
			sendMouse(mouseInput{dwFlags: mouseeventfHWheel, mouseData: int32(m.DX * 120)})
		}
	case "key":
		sc, ext, ok := scanCode(m.Code)
		if !ok {
			log.Printf("input: 未対応キー: %s", m.Code)
			return
		}
		var flags uint32 = keyeventfScancode
		if ext {
			flags |= keyeventfExtendedkey
		}
		if !m.Down {
			flags |= keyeventfKeyup
		}
		sendKey(keybdInput{wScan: sc, dwFlags: flags})
	case "txt":
		for _, u := range windows.StringToUTF16(m.S) {
			if u == 0 {
				break
			}
			sendKey(keybdInput{wScan: u, dwFlags: keyeventfUnicode})
			sendKey(keybdInput{wScan: u, dwFlags: keyeventfUnicode | keyeventfKeyup})
		}
	}
}

func clamp01(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 1 {
		return 1
	}
	return v
}

// Package input はクライアントからの操作メッセージをWindowsに注入する。
// マウスは正規化絶対座標(0..1)、キーはJSのKeyboardEvent.code、
// テキストはKEYEVENTF_UNICODEで送る。
package input

import (
	"encoding/json"
	"log"
	"strings"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32               = windows.NewLazySystemDLL("user32.dll")
	procSendInput        = user32.NewProc("SendInput")
	procGetSystemMetrics = user32.NewProc("GetSystemMetrics")
)

const (
	inputMouse    = 0
	inputKeyboard = 1

	mouseeventfMove        = 0x0001
	mouseeventfLeftDown    = 0x0002
	mouseeventfLeftUp      = 0x0004
	mouseeventfRightDown   = 0x0008
	mouseeventfRightUp     = 0x0010
	mouseeventfMiddleDown  = 0x0020
	mouseeventfMiddleUp    = 0x0040
	mouseeventfWheel       = 0x0800
	mouseeventfHWheel      = 0x1000
	mouseeventfVirtualdesk = 0x4000
	mouseeventfAbsolute    = 0x8000

	smCxScreen        = 0
	smCyScreen        = 1
	smXVirtualScreen  = 76
	smYVirtualScreen  = 77
	smCxVirtualScreen = 78
	smCyVirtualScreen = 79

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

// スマホへ出す知らせの送り先と、間引きの間隔。
// マウス移動は毎秒何十発も来るので、そのたびに出すと表示が埋まる。
var (
	noticeMu   sync.Mutex
	noticeFn   func(string)
	noticeAt   time.Time
	noticeLast string
)

const noticeInterval = 5 * time.Second

// OnNotice は操作が届かなかった理由などをスマホへ出す送り先を登録する。
// 黙って効かなくなるのがいちばん困る — スマホからは、繋がっていないのか
// 操作が捨てられているのか見分けられない。
func OnNotice(f func(string)) {
	noticeMu.Lock()
	defer noticeMu.Unlock()
	noticeFn = f
}

// notice は同じ知らせを続けざまに出さないよう間引いてから送る。
// 内容が変わったときは状況が変わったということなので、待たずに出す。
func notice(msg string) {
	noticeMu.Lock()
	if msg == noticeLast && time.Since(noticeAt) < noticeInterval {
		noticeMu.Unlock()
		return
	}
	noticeAt, noticeLast = time.Now(), msg
	fn := noticeFn
	noticeMu.Unlock()

	log.Printf("input: %s", msg)
	if fn != nil {
		fn(msg)
	}
}

// Msg はDataChannel経由の操作メッセージ。
type Msg struct {
	T    string  `json:"t"`
	X    float64 `json:"x,omitempty"` // mv: 正規化座標 0..1
	Y    float64 `json:"y,omitempty"`
	B    int     `json:"b,omitempty"`  // dn/up: 0=左 1=中 2=右
	DX   float64 `json:"dx,omitempty"` // wh: ホイールノッチ数
	DY   float64 `json:"dy,omitempty"`
	Code string  `json:"code,omitempty"` // key: KeyboardEvent.code
	Down bool    `json:"down,omitempty"`
	S    string  `json:"s,omitempty"` // txt: 入力テキスト
}

// 正規化座標のマップ先モニタ領域(仮想デスクトップ座標)。未設定ならプライマリ全面。
var (
	targetMu  sync.Mutex
	hasTarget bool
	tgX, tgY  int
	tgW, tgH  int
)

// SetTarget はマウス座標のマップ先をモニタ領域(仮想デスクトップ座標)に設定する。
func SetTarget(x, y, w, h int) {
	targetMu.Lock()
	defer targetMu.Unlock()
	hasTarget = w > 0 && h > 0
	tgX, tgY, tgW, tgH = x, y, w, h
}

// ResetTarget はマップ先を従来どおりプライマリモニタ全面に戻す。
func ResetTarget() {
	targetMu.Lock()
	defer targetMu.Unlock()
	hasTarget = false
}

func metric(index uintptr) float64 {
	r, _, _ := procGetSystemMetrics.Call(index)
	return float64(int32(r))
}

// mapNorm は正規化座標(0..1)を SendInput 用の絶対座標(0..65535)とフラグに変換する。
// 対象モニタが設定されていれば仮想デスクトップ全体基準(VIRTUALDESK)でそのモニタ内へ、
// 未設定ならプライマリモニタ基準で変換する。
func mapNorm(x, y float64) (dx, dy int32, flags uint32) {
	targetMu.Lock()
	defer targetMu.Unlock()
	if !hasTarget {
		return int32(x * 65535), int32(y * 65535), mouseeventfAbsolute
	}
	vx, vy := metric(smXVirtualScreen), metric(smYVirtualScreen)
	vw, vh := metric(smCxVirtualScreen), metric(smCyVirtualScreen)
	if vw <= 0 || vh <= 0 {
		return int32(x * 65535), int32(y * 65535), mouseeventfAbsolute
	}
	px := float64(tgX) + x*float64(tgW)
	py := float64(tgY) + y*float64(tgH)
	dx = int32((px - vx) / vw * 65535)
	dy = int32((py - vy) / vh * 65535)
	return dx, dy, mouseeventfAbsolute | mouseeventfVirtualdesk
}

// screenPoint は正規化座標(0..1)を画面上のピクセル座標に直す。
// mapNorm と同じマップ先を見るが、こちらはウィンドウを調べるための実座標を返す
// (SendInput用の 0..65535 ではない)。
func screenPoint(x, y float64) (int32, int32) {
	targetMu.Lock()
	defer targetMu.Unlock()
	if !hasTarget {
		return int32(x * metric(smCxScreen)), int32(y * metric(smCyScreen))
	}
	return int32(float64(tgX) + x*float64(tgW)), int32(float64(tgY) + y*float64(tgH))
}

// クライアントが最後に指した位置(正規化座標)。
// 塞がれているあいだのカーソル移動は捨てられるが、どこを指したかは覚えておき、
// 復帰した瞬間にそこへ飛ばす。そうしないと、塞がれる前の位置のまま押すことになる。
// 触るのはDataChannelゴルーチンだけなので、ロックは要らない。
var (
	wantSet  bool
	wantX    float64
	wantY    float64
	skipUpOf [3]bool // 押下を捨てたボタン。対応する解放も捨てる
)

// Handle は1メッセージを処理する。
func Handle(data []byte) {
	var m Msg
	if err := json.Unmarshal(data, &m); err != nil {
		return
	}
	switch m.T {
	case "mv":
		wantSet, wantX, wantY = true, clamp01(m.X), clamp01(m.Y)
		moveTo(wantX, wantY)
		noticeIfBlocked()
	case "dn", "up":
		flag, ok := buttonFlag(m.B, m.T == "up")
		if !ok {
			return
		}
		if m.T == "dn" {
			skipUpOf[m.B] = !prepareClick()
			if skipUpOf[m.B] {
				return
			}
		} else if skipUpOf[m.B] {
			// 押していないボタンを離すと、掴んだ覚えのないドラッグが終わってしまう
			skipUpOf[m.B] = false
			return
		}
		sendMouse(mouseInput{dwFlags: flag})
	case "wh":
		if m.DY != 0 {
			sendMouse(mouseInput{dwFlags: mouseeventfWheel, mouseData: int32(m.DY * 120)})
		}
		if m.DX != 0 {
			sendMouse(mouseInput{dwFlags: mouseeventfHWheel, mouseData: int32(m.DX * 120)})
		}
		noticeIfBlocked()
	case "key":
		if !Key(m.Code, m.Down) {
			log.Printf("input: 未対応キー: %s", m.Code)
		}
		noticeIfBlocked()
	case "txt":
		Text(m.S)
		noticeIfBlocked()
	}
}

// moveTo は正規化座標へカーソルを動かす。
func moveTo(x, y float64) {
	dx, dy, flags := mapNorm(x, y)
	sendMouse(mouseInput{dx: dx, dy: dy, dwFlags: mouseeventfMove | flags})
}

// buttonFlag はボタン番号(0=左 1=中 2=右)を押下/解放のフラグに直す。
func buttonFlag(b int, up bool) (uint32, bool) {
	var flag uint32
	switch b {
	case 0:
		flag = mouseeventfLeftDown
	case 1:
		flag = mouseeventfMiddleDown
	case 2:
		flag = mouseeventfRightDown
	default:
		return 0, false
	}
	if up {
		flag <<= 1 // 各ボタンのUPフラグはDOWNの2倍値
	}
	return flag, true
}

// prepareClick は、権限の高いウィンドウのせいで入力が捨てられているなら、
// クリックが届くように前面から外す。押していい状態ならtrue。
//
// 押す先がその権限の高いウィンドウ自身のときはfalse。押せばまた前面に戻って
// 塞がるだけなので、カーソルだけ取り戻して押下は捨てる。
func prepareClick() bool {
	if blockedBy() == 0 {
		return true
	}
	// 塞がれているあいだカーソルは動いていないので、押す先は
	// 「クライアントが最後に指した位置」で見る(実際のカーソル位置ではない)。
	x, y := clickPoint()
	onHigher := higherThanSelf(windowAt(x, y))

	if !unblock() {
		notice("管理者権限のウィンドウが前面のため、操作が届きません")
		return false
	}
	if onHigher {
		notice("管理者権限のウィンドウは操作できません(カーソルは戻しました)")
		return false
	}
	// 捨てられていたあいだのカーソル移動をここで反映してから押す。
	// 省くと、塞がる前の位置で押すことになる。
	if wantSet {
		moveTo(wantX, wantY)
	}
	log.Printf("input: 権限の高いウィンドウを前面から外し、操作を再開しました")
	return true
}

// clickPoint はこれから押す画面上の位置(ピクセル)を返す。
func clickPoint() (int32, int32) {
	if wantSet {
		return screenPoint(wantX, wantY)
	}
	return cursorPoint()
}

// noticeIfBlocked は入力が捨てられている状態なら、その理由をスマホへ出す。
func noticeIfBlocked() {
	if blockedBy() != 0 {
		notice("管理者権限のウィンドウが前面です。別のウィンドウをタップすると操作に戻れます")
	}
}

// Key は1キーの押下/解放を送る。未対応のcodeならfalseを返す。
func Key(code string, down bool) bool {
	sc, ext, ok := scanCode(code)
	if !ok {
		return false
	}
	var flags uint32 = keyeventfScancode
	if ext {
		flags |= keyeventfExtendedkey
	}
	if !down {
		flags |= keyeventfKeyup
	}
	sendKey(keybdInput{wScan: sc, dwFlags: flags})
	return true
}

// Combo は ["ControlLeft","KeyC"] のようなキー列を順に押し、逆順で離す(同時押し)。
// 途中で未対応キーに当たったら、そこまでに押したキーを離して中断する。
func Combo(codes []string) bool {
	pressed := make([]string, 0, len(codes))
	ok := true
	for _, code := range codes {
		code = strings.TrimSpace(code)
		if !Key(code, true) {
			log.Printf("input: 未対応キー: %s", code)
			ok = false
			break
		}
		pressed = append(pressed, code)
	}
	for i := len(pressed) - 1; i >= 0; i-- {
		Key(pressed[i], false)
	}
	return ok
}

// Text はUnicodeテキストをそのままキー入力として打ち込む(IMEを介さない)。
func Text(s string) {
	for _, u := range windows.StringToUTF16(s) {
		if u == 0 {
			break
		}
		sendKey(keybdInput{wScan: u, dwFlags: keyeventfUnicode})
		sendKey(keybdInput{wScan: u, dwFlags: keyeventfUnicode | keyeventfKeyup})
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

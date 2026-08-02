// Package media は ffmpeg サブプロセスで画面をキャプチャ・H.264エンコードし、
// Annex-B ストリームをアクセスユニット(1フレーム)単位に切り出して届ける。
// cgo を避けるため、エンコードはすべて ffmpeg 側で行う。
package media

import (
	"bufio"
	"bytes"
	"context"
	"fmt"
	"io"
	"log"
	"math"
	"os/exec"
	"sync"
	"syscall"
	"time"
)

// 起動から最初のフレームまでの猶予。これを過ぎた候補は見切って次へ移る。
// 使えないエンコーダは1秒未満でffmpegごと終了するので、ここで待たされるのは
// 「起動はしたが映像が出てこない」場合だけ。高解像度のソフトウェア
// エンコードは初回が遅いことがあるので短く切りすぎない。
const firstFrameTimeout = 6 * time.Second

// 送出解像度の上限。スマホのデコード電力はほぼピクセル数に比例するので、
// モニタの実解像度をそのまま送るのは電池の無駄でしかない(スマホ側の表示は
// せいぜい800px幅で、拡大して見るときもズームはクライアント側で行う)。
// 720p30 は profile-level-id 3.1 の上限ちょうどで、ハードウェアデコーダを
// 持たないスマホが事実上存在しない安全圏でもある。
const (
	capW = 1280
	capH = 720
)

// フレーム1枚に与える長さの範囲。画面が静止しているあいだフレームは出ないので、
// 動き出したときの間隔はいくらでも伸びうる。RTPの時計を飛ばしすぎない上限と、
// 同時刻に2枚出たときに0幅にしないための下限。
const (
	minSampleGap = time.Millisecond
	maxSampleGap = 5 * time.Second
)

// 強制IDRの間隔(秒)。パケロスからの復帰はここまで待たされる。
const keyframeSec = 2

// Options はキャプチャ・エンコード設定。
type Options struct {
	FPS         int
	BitrateMbps int
	Display     int // キャプチャ対象モニタ (ddagrab output_idx)
	// gdigrabフォールバック用の対象モニタ領域(仮想デスクトップ座標)。W==0なら全体。
	// W/H はキャプチャ元の解像度でもあり、縮小率の計算に使う。
	X, Y, W, H int
	// クライアントが実際に表示できる大きさ(デバイスピクセル)。
	// 0なら上限まで。これを超える解像度を送っても、スマホ側で捨てられるだけ。
	MaxW, MaxH int
	// ホスト側で決める送出解像度の上限。0なら既定 (capW×capH)。
	// クライアントの申告がこれより大きくても従わない。
	CapW, CapH int
}

func (o Options) Normalize() Options {
	if o.FPS <= 0 {
		o.FPS = 30
	}
	if o.BitrateMbps <= 0 {
		o.BitrateMbps = 4
	}
	if o.CapW <= 0 {
		o.CapW = capW
	}
	if o.CapH <= 0 {
		o.CapH = capH
	}
	// クライアントの申告は縮小方向にしか効かない。大きく申告されても従わない。
	if o.MaxW <= 0 || o.MaxW > o.CapW {
		o.MaxW = o.CapW
	}
	if o.MaxH <= 0 || o.MaxH > o.CapH {
		o.MaxH = o.CapH
	}
	return o
}

// EncodedSize は実際にエンコードされる解像度を返す。キャプチャ元が不明なら 0,0。
func (o Options) EncodedSize() (int, int) {
	if w, h := fitScale(o.W, o.H, o.MaxW, o.MaxH); w > 0 {
		return w, h
	}
	return o.W, o.H
}

// fitScale は srcW×srcH を maxW×maxH に収まるまで縦横比を保って縮小した解像度を返す。
// 縮小が要らない(または判断できない)場合は 0,0 を返す。拡大はしない。
// H.264 4:2:0 は偶数解像度しか扱えないので偶数に丸める。
func fitScale(srcW, srcH, maxW, maxH int) (int, int) {
	if srcW <= 0 || srcH <= 0 || maxW <= 0 || maxH <= 0 {
		return 0, 0
	}
	if srcW <= maxW && srcH <= maxH {
		return 0, 0
	}
	s := math.Min(float64(maxW)/float64(srcW), float64(maxH)/float64(srcH))
	even := func(v float64) int {
		n := int(math.Round(v))
		return max(n-n%2, 2)
	}
	return even(float64(srcW) * s), even(float64(srcH) * s)
}

// H.264 レベルの上限表 (Annex A)。maxFS はフレームあたりのマクロブロック数、
// maxMBPS は毎秒のマクロブロック数、maxBR は kbps。
// 3.1 未満は載せない。それ以下を名乗る意味はなく、どのスマホでも通る下限。
var h264Levels = []struct {
	id      byte
	maxFS   int
	maxMBPS int
	maxBR   int
}{
	{0x1f, 3600, 108000, 14000},    // 3.1
	{0x20, 5120, 216000, 20000},    // 3.2
	{0x28, 8192, 245760, 20000},    // 4.0
	{0x29, 8192, 245760, 50000},    // 4.1
	{0x2a, 8704, 522240, 50000},    // 4.2
	{0x32, 22080, 589824, 135000},  // 5.0
	{0x33, 36864, 983040, 240000},  // 5.1
	{0x34, 36864, 2073600, 240000}, // 5.2
}

// ProfileLevelID は実際に送るストリームに見合った SDP の profile-level-id を返す。
// Constrained Baseline (42e0…) 固定で、レベルだけ解像度・fps・ビットレートから決める。
//
// ここが実態より低いと、スマホはハードウェアデコーダが対応できないと判断して
// ソフトウェアデコードに落ち、電池を焼いて発熱する。以前は解像度に関わらず
// 3.1 を名乗りながら4Kをそのまま流していた。
func ProfileLevelID(w, h, fps, kbps int) string {
	if w <= 0 || h <= 0 {
		// 分からないときは安全側 = 一番高いレベルを名乗る。
		// 低く名乗って弾かれるより、高く名乗って実際は軽いほうが害がない。
		return fmt.Sprintf("42e0%02x", h264Levels[len(h264Levels)-1].id)
	}
	mbs := ((w + 15) / 16) * ((h + 15) / 16)
	for _, l := range h264Levels {
		if mbs <= l.maxFS && mbs*fps <= l.maxMBPS && kbps <= l.maxBR {
			return fmt.Sprintf("42e0%02x", l.id)
		}
	}
	return fmt.Sprintf("42e0%02x", h264Levels[len(h264Levels)-1].id)
}

// pipeline は1つのキャプチャ+エンコード構成。name はログと記憶用の名前。
type pipeline struct {
	name string
	args []string
}

// エンコーダ候補。上から順に試し、最初に映像が出たものを使う。
// ddagrab は Desktop Duplication ベースでカーソルも描画される。
// NVENC/AMF は d3d11 フレームを直接受け取れる。QSV/libx264 はhwdownloadが必要。
func pipelines(o Options) []pipeline {
	ow, oh := o.EncodedSize()
	scaled := ow > 0 && (ow != o.W || oh != o.H)

	// dup_frames=0: 画面が変化したときだけフレームを出す。既定(複製あり)では
	// デスクトップが完全に静止していても毎秒fps枚を送り続け、待機しているだけで
	// スマホのデコーダと無線を全開で回していた。
	grab := func(post string) string {
		return fmt.Sprintf("ddagrab=output_idx=%d:framerate=%d:dup_frames=0%s", o.Display, o.FPS, post)
	}
	// GPU内で縮小してからエンコーダへ渡す(システムメモリへの読み戻しが要らない)。
	// scale_d3d11 は scale と違って w/h の略記を受け付けず、format を明示しないと
	// 出力フォーマットが決まらず初期化に失敗する。古いGPU/ドライバでは
	// そもそもテクスチャを作れないことがあるので、これが駄目でも
	// 下の「読み戻してから縮小」版へ落ちられるようにしてある。
	gpuScale := ""
	if scaled {
		gpuScale = fmt.Sprintf(",scale_d3d11=width=%d:height=%d:format=nv12", ow, oh)
	}
	// システムメモリへ降ろしてから縮小する版。読み戻しのぶん重いが環境を選ばない。
	cpuScale := ",hwdownload,format=bgra"
	if scaled {
		cpuScale += fmt.Sprintf(",scale=%d:%d:flags=fast_bilinear", ow, oh)
	}
	// 縮小が要らないなら、ハードウェアエンコーダにはd3d11フレームを直接渡せる。
	hwIn := ""
	if scaled {
		hwIn = cpuScale
	}

	// SDPで Constrained Baseline を名乗る以上、実際にその profile で出させる。
	// h264_nvenc の既定は main、h264_qsv は unknown で、放っておくと宣言と食い違う。
	nvenc := []string{"-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ull", "-zerolatency", "1", "-profile:v", "baseline"}
	amf := []string{"-c:v", "h264_amf", "-usage", "ultralowlatency", "-profile:v", "constrained_baseline"}
	qsv := []string{"-c:v", "h264_qsv", "-preset", "veryfast", "-profile:v", "baseline"}
	x264 := []string{"-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-pix_fmt", "yuv420p"}

	// Desktop Duplication が使えない環境向けの最終フォールバック。
	// gdigrabにはモニタ指定がないため、対象モニタの領域を矩形指定で切り出す。
	gdi := []string{"-f", "gdigrab", "-framerate", fmt.Sprint(o.FPS)}
	if o.W > 0 {
		gdi = append(gdi,
			"-offset_x", fmt.Sprint(o.X), "-offset_y", fmt.Sprint(o.Y),
			"-video_size", fmt.Sprintf("%dx%d", o.W, o.H),
		)
	}
	gdi = append(gdi, "-i", "desktop")
	if scaled {
		gdi = append(gdi, "-vf", fmt.Sprintf("scale=%d:%d:flags=fast_bilinear", ow, oh))
	}
	gdi = append(gdi, x264...)

	with := func(filter string, enc []string) []string {
		return append([]string{"-filter_complex", grab(filter)}, enc...)
	}
	var ps []pipeline
	if scaled {
		// 縮小もエンコードもGPU内で完結する構成が一番安い。まずこれを試す。
		ps = append(ps,
			pipeline{"h264_nvenc(GPU縮小)", with(gpuScale, nvenc)},
			pipeline{"h264_amf(GPU縮小)", with(gpuScale, amf)},
		)
	}
	return append(ps,
		pipeline{"h264_nvenc", with(hwIn, nvenc)},
		pipeline{"h264_amf", with(hwIn, amf)},
		pipeline{"h264_qsv", with(cpuScale, qsv)},
		pipeline{"libx264", with(cpuScale, x264)},
		pipeline{"libx264(gdigrab)", gdi},
	)
}

// 前回映像が出たパイプライン。使えるエンコーダはマシン構成で決まり毎回同じなので、
// 一度分かったら次はそこから試す。NVENC/AMF/QSV が無い環境では、候補を順に
// 潰すだけで毎接続1〜2秒かかり、そのぶん映像が出るまでの待ちが伸びていた。
var lastGood struct {
	mu   sync.Mutex
	name string
}

func rememberEncoder(name string) {
	lastGood.mu.Lock()
	defer lastGood.mu.Unlock()
	lastGood.name = name
}

// ordered は前回映像が出たパイプラインを先頭に繰り上げる。
// 残りの順序は変えない(そのエンコーダが使えなくなっていても通常どおり降りていく)。
func ordered(ps []pipeline) []pipeline {
	lastGood.mu.Lock()
	name := lastGood.name
	lastGood.mu.Unlock()
	if name == "" {
		return ps
	}
	for i, p := range ps {
		if p.name != name {
			continue
		}
		if i == 0 {
			return ps
		}
		out := make([]pipeline, 0, len(ps))
		out = append(out, p)
		out = append(out, ps[:i]...)
		return append(out, ps[i+1:]...)
	}
	return ps
}

func buildArgs(p pipeline, o Options) []string {
	bitrate := fmt.Sprintf("%dM", o.BitrateMbps)
	args := []string{"-hide_banner", "-loglevel", "error"}
	args = append(args, p.args...)
	args = append(args,
		// dup_frames=0 だけでは足りない。フィルタの出力リンクが公称fpsを名乗るため、
		// 既定(-fps_mode auto)だとffmpegがエンコード段で改めてフレームを複製し、
		// 結局CFRに戻してしまう。実測でも vfr を付けて初めて枚数が落ちた。
		"-fps_mode", "vfr",
		"-b:v", bitrate, "-maxrate", bitrate, "-bufsize", fmt.Sprintf("%dM", o.BitrateMbps*2),
		// GOP: IDR強制(PLI)ができないので周期的に入れるしかない。ただし dup_frames=0 で
		// フレームが出るのは画面が変化したときだけなので、-g が枚数で数えるかぎり
		// 静止中にIDRが積まれることはない。時間ベースの強制も足して、動いている
		// あいだのパケロスからは2秒以内に復帰できるようにする。
		"-g", fmt.Sprint(o.FPS*keyframeSec),
		"-force_key_frames", fmt.Sprintf("expr:gte(t,n_forced*%d)", keyframeSec),
		"-bf", "0",
		"-f", "h264", "-",
	)
	return args
}

// Sample は1アクセスユニット(1フレーム)分のAnnex-Bデータ。
type Sample struct {
	Data     []byte
	Duration time.Duration
}

// paceKeeper はフレームの実間隔を測る。dup_frames=0 でフレームレートが可変に
// なったため、公称fpsから求めた固定値ではRTPタイムスタンプが実時間からずれていく。
// 送れなかったフレームの時間は次のフレームへ繰り越し、映像が早送りになるのを防ぐ。
type paceKeeper struct {
	nominal time.Duration // 前フレームが無いときに使う公称の1枚分
	last    time.Time
	carry   time.Duration
}

// next は今回のフレームに与える長さを返す。
func (p *paceKeeper) next(t time.Time) time.Duration {
	d := p.nominal
	if !p.last.IsZero() {
		d = min(max(t.Sub(p.last), minSampleGap), maxSampleGap)
	}
	p.last = t
	d += p.carry
	p.carry = 0
	return d
}

// dropped は next で得た長さのフレームを送れなかったことを伝える。
func (p *paceKeeper) dropped(d time.Duration) { p.carry = d }

// Capture は画面キャプチャを開始し、フレームを ch に送る。ctxキャンセルで停止。
func Capture(ctx context.Context, opts Options, ch chan<- Sample) error {
	opts = opts.Normalize()
	for _, p := range ordered(pipelines(opts)) {
		err := runPipeline(ctx, p, opts, ch)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		log.Printf("media: %s は使えません: %v", p.name, err)
	}
	return fmt.Errorf("media: 全エンコーダ候補が失敗")
}

// runPipeline は1候補を起動する。最初のフレームが firstFrameTimeout 以内に
// 出なければ失敗扱い。
// 一度映像が出た後のエラーはそのまま返す(呼び出し側は次候補に行かず再起動判断)。
func runPipeline(ctx context.Context, p pipeline, opts Options, ch chan<- Sample) error {
	cmd := exec.CommandContext(ctx, "ffmpeg", buildArgs(p, opts)...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	start := time.Now()
	if err := cmd.Start(); err != nil {
		return err
	}
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	firstFrame := make(chan struct{})
	watchdog := time.AfterFunc(firstFrameTimeout, func() { _ = cmd.Process.Kill() })
	go func() {
		defer watchdog.Stop()
		select {
		case <-firstFrame:
			// 次の接続ではここから試す。使えないエンコーダを毎回試し直さない。
			rememberEncoder(p.name)
			log.Printf("media: %s で映像開始 (%v)", p.name, time.Since(start).Round(time.Millisecond))
		case <-ctx.Done():
		}
	}()

	err = readAccessUnits(bufio.NewReaderSize(stdout, 1<<20), opts, ch, firstFrame, time.Now)
	if s := stderr.String(); s != "" {
		return fmt.Errorf("%w (ffmpeg: %s)", err, s)
	}
	return err
}

// readAccessUnits は Annex-B ストリームをNAL単位で読み、アクセスユニット境界で
// フレームとして送出する。境界判定は「first_mb_in_slice==0 のVCL NAL」
// (ペイロード先頭バイトの最上位ビットが1 = ue(v)の0)を新フレーム開始とみなす定石を使う。
func readAccessUnits(r *bufio.Reader, opts Options, ch chan<- Sample, firstFrame chan struct{}, now func() time.Time) error {
	var buf []byte    // 未処理バイト
	var au []byte     // 組み立て中のアクセスユニット
	auHasVCL := false // 現在のAUにスライスNALが含まれるか
	first := true
	pace := &paceKeeper{nominal: time.Second / time.Duration(opts.FPS)}

	flush := func() {
		if len(au) == 0 {
			return
		}
		if first {
			close(firstFrame)
			first = false
		}
		d := pace.next(now())
		sample := Sample{Data: append([]byte(nil), au...), Duration: d}
		select {
		case ch <- sample:
		default:
			// 受け側が詰まったら古いフレームは捨てる(遅延蓄積防止)。
			// ただし時間は次のフレームへ繰り越す。
			pace.dropped(d)
		}
		au = au[:0]
		auHasVCL = false
	}

	tmp := make([]byte, 64*1024)
	for {
		n, err := r.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
			for {
				nal, rest, ok := nextNAL(buf)
				if !ok {
					break
				}
				buf = rest
				nalType := nal[startCodeLen(nal)] & 0x1f
				isVCL := nalType >= 1 && nalType <= 5
				if isVCL && auHasVCL && isFirstSlice(nal) {
					flush()
				}
				au = append(au, nal...)
				if isVCL {
					auHasVCL = true
				}
			}
		}
		if err != nil {
			flush()
			if err == io.EOF {
				return fmt.Errorf("ffmpeg終了")
			}
			return err
		}
	}
}

func startCodeLen(nal []byte) int {
	if bytes.HasPrefix(nal, []byte{0, 0, 0, 1}) {
		return 4
	}
	return 3
}

func isFirstSlice(nal []byte) bool {
	i := startCodeLen(nal) + 1 // NALヘッダの次
	return i < len(nal) && nal[i]&0x80 != 0
}

// nextNAL は buf 先頭の完結したNAL(次のスタートコード直前まで)を返す。
// 次のスタートコードが見つからない場合は不完全なので待つ。
func nextNAL(buf []byte) (nal, rest []byte, ok bool) {
	start := indexStartCode(buf, 0)
	if start < 0 {
		return nil, buf, false
	}
	next := indexStartCode(buf, start+3)
	if next < 0 {
		return nil, buf, false
	}
	return buf[start:next], buf[next:], true
}

func indexStartCode(buf []byte, from int) int {
	for i := from; i+3 <= len(buf); i++ {
		if buf[i] == 0 && buf[i+1] == 0 {
			if buf[i+2] == 1 {
				// 00 00 00 01 の場合は先頭の00から
				if i > from && buf[i-1] == 0 {
					return i - 1
				}
				return i
			}
		}
	}
	return -1
}

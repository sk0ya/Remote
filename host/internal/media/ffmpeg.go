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
	"os/exec"
	"syscall"
	"time"
)

// Options はキャプチャ・エンコード設定。
type Options struct {
	FPS         int
	BitrateMbps int
}

func (o Options) normalize() Options {
	if o.FPS <= 0 {
		o.FPS = 30
	}
	if o.BitrateMbps <= 0 {
		o.BitrateMbps = 4
	}
	return o
}

// エンコーダ候補。上から順に試し、最初に映像が出たものを使う。
// ddagrab は Desktop Duplication ベースでカーソルも描画される。
// NVENC/AMF は d3d11 フレームを直接受け取れる。QSV/libx264 はhwdownloadが必要。
func pipelines(o Options) [][]string {
	grab := func(post string) string {
		return fmt.Sprintf("ddagrab=framerate=%d%s", o.FPS, post)
	}
	return [][]string{
		{"-filter_complex", grab(""), "-c:v", "h264_nvenc", "-preset", "p1", "-tune", "ull", "-zerolatency", "1"},
		{"-filter_complex", grab(""), "-c:v", "h264_amf", "-usage", "ultralowlatency"},
		{"-filter_complex", grab(",hwdownload,format=bgra"), "-c:v", "h264_qsv", "-preset", "veryfast"},
		{"-filter_complex", grab(",hwdownload,format=bgra"), "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-pix_fmt", "yuv420p"},
		// Desktop Duplication が使えない環境向けの最終フォールバック
		{"-f", "gdigrab", "-framerate", fmt.Sprint(o.FPS), "-i", "desktop", "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-pix_fmt", "yuv420p"},
	}
}

func buildArgs(pipeline []string, o Options) []string {
	bitrate := fmt.Sprintf("%dM", o.BitrateMbps)
	args := []string{"-hide_banner", "-loglevel", "error"}
	args = append(args, pipeline...)
	args = append(args,
		"-b:v", bitrate, "-maxrate", bitrate, "-bufsize", fmt.Sprintf("%dM", o.BitrateMbps*2),
		"-g", fmt.Sprint(o.FPS), // GOP 1秒: IDR強制ができない代わりに短周期
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

// Capture は画面キャプチャを開始し、フレームを ch に送る。ctxキャンセルで停止。
func Capture(ctx context.Context, opts Options, ch chan<- Sample) error {
	opts = opts.normalize()
	for i, p := range pipelines(opts) {
		err := runPipeline(ctx, p, opts, ch)
		if ctx.Err() != nil {
			return ctx.Err()
		}
		log.Printf("media: パイプライン%d (%s) 失敗: %v", i, encoderName(p), err)
	}
	return fmt.Errorf("media: 全エンコーダ候補が失敗")
}

func encoderName(pipeline []string) string {
	for i, a := range pipeline {
		if a == "-c:v" && i+1 < len(pipeline) {
			return pipeline[i+1]
		}
	}
	return "?"
}

// runPipeline は1候補を起動する。最初のフレームが3秒以内に出なければ失敗扱い。
// 一度映像が出た後のエラーはそのまま返す(呼び出し側は次候補に行かず再起動判断)。
func runPipeline(ctx context.Context, pipeline []string, opts Options, ch chan<- Sample) error {
	cmd := exec.CommandContext(ctx, "ffmpeg", buildArgs(pipeline, opts)...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	defer func() {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
	}()

	log.Printf("media: エンコーダ %s で起動", encoderName(pipeline))

	firstFrame := make(chan struct{})
	watchdog := time.AfterFunc(3*time.Second, func() { _ = cmd.Process.Kill() })
	go func() {
		select {
		case <-firstFrame:
			watchdog.Stop()
		case <-ctx.Done():
		}
	}()

	err = readAccessUnits(bufio.NewReaderSize(stdout, 1<<20), opts, ch, firstFrame)
	if s := stderr.String(); s != "" {
		return fmt.Errorf("%w (ffmpeg: %s)", err, s)
	}
	return err
}

// readAccessUnits は Annex-B ストリームをNAL単位で読み、アクセスユニット境界で
// フレームとして送出する。境界判定は「first_mb_in_slice==0 のVCL NAL」
// (ペイロード先頭バイトの最上位ビットが1 = ue(v)の0)を新フレーム開始とみなす定石を使う。
func readAccessUnits(r *bufio.Reader, opts Options, ch chan<- Sample, firstFrame chan struct{}) error {
	var buf []byte      // 未処理バイト
	var au []byte       // 組み立て中のアクセスユニット
	auHasVCL := false   // 現在のAUにスライスNALが含まれるか
	first := true
	frameDur := time.Second / time.Duration(opts.FPS)

	flush := func() {
		if len(au) == 0 {
			return
		}
		if first {
			close(firstFrame)
			first = false
		}
		sample := Sample{Data: append([]byte(nil), au...), Duration: frameDur}
		select {
		case ch <- sample:
		default:
			// 受け側が詰まったら古いフレームは捨てる(遅延蓄積防止)
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

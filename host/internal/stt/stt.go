// Package stt はスマホから届いた音声を文字起こしする。
//
// 認識は別プロセス(jvi-serve: sherpa-onnx + ReazonSpeech)に任せる。
// モデルの読み込みに数秒かかるため、プロセスは起動したまま使い回し、
// 標準入出力で「wavのパスを送る → 認識結果の行が返る」というやり取りをする。
//
// ブラウザから届く音声はwebm/mp4など環境依存のコンテナなので、
// ffmpeg(映像キャプチャで既に必須)で16kHzモノラルwavへ揃えてから渡す。
package stt

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// モデル読み込みを含む起動待ちと、1発話あたりの認識待ちの上限。
const (
	startTimeout     = 60 * time.Second
	recognizeTimeout = 30 * time.Second
)

type Engine struct {
	cmdPath string
	workDir string

	mu     sync.Mutex
	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout *bufio.Reader
}

func New(cmdPath, workDir string) *Engine {
	// os/exec は作業ディレクトリを指定すると相対パスの実行ファイルをそこ基準で探すため、
	// 設定に相対パスが書かれていても意図どおりになるよう先に絶対パスへ直す。
	return &Engine{cmdPath: absPath(cmdPath), workDir: absPath(workDir)}
}

func absPath(p string) string {
	if p == "" {
		return ""
	}
	abs, err := filepath.Abs(p)
	if err != nil {
		return p
	}
	return abs
}

// Available は認識エンジンの実行ファイルが存在するかを返す。
func (e *Engine) Available() bool {
	if e.cmdPath == "" {
		return false
	}
	st, err := os.Stat(e.cmdPath)
	return err == nil && !st.IsDir()
}

// Warm はモデルの読み込み(数秒かかる)を先に済ませておく。
// セッション開始時に呼んでおくと、最初の発話を待たせずに済む。
func (e *Engine) Warm() {
	if !e.Available() {
		return
	}
	go func() {
		e.mu.Lock()
		defer e.mu.Unlock()
		if err := e.ensureRunning(); err != nil {
			log.Printf("stt: 事前起動に失敗: %v", err)
		}
	}()
}

// Recognize はブラウザが録音した音声データを文字起こしする。
// 認識結果が空文字なら「無音・認識不能」を意味する(エラーではない)。
func (e *Engine) Recognize(audio []byte) (string, error) {
	if !e.Available() {
		return "", fmt.Errorf("認識エンジンが見つかりません: %s", e.cmdPath)
	}
	wav, cleanup, err := toWav(audio)
	if err != nil {
		return "", err
	}
	defer cleanup()

	e.mu.Lock()
	defer e.mu.Unlock()
	if err := e.ensureRunning(); err != nil {
		return "", err
	}
	if _, err := io.WriteString(e.stdin, wav+"\n"); err != nil {
		e.stopLocked()
		return "", fmt.Errorf("認識エンジンへの送信に失敗: %w", err)
	}
	line, err := e.readLine(recognizeTimeout)
	if err != nil {
		e.stopLocked()
		return "", err
	}
	switch {
	case strings.HasPrefix(line, "+"):
		return strings.TrimSpace(line[1:]), nil
	case strings.HasPrefix(line, "!"):
		return "", fmt.Errorf("認識エラー: %s", strings.TrimSpace(line[1:]))
	default:
		e.stopLocked()
		return "", fmt.Errorf("認識エンジンの応答が不正: %q", line)
	}
}

// Close は常駐している認識プロセスを終了する。
func (e *Engine) Close() {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.stopLocked()
}

func (e *Engine) ensureRunning() error {
	if e.cmd != nil {
		return nil
	}
	cmd := exec.Command(e.cmdPath)
	cmd.Dir = e.workDir // config.tomlとモデルのパスがここからの相対
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("認識エンジンを起動できません: %w", err)
	}
	go logStderr(stderr)

	e.cmd = cmd
	e.stdin = stdin
	e.stdout = bufio.NewReader(stdout)

	// モデル読み込み完了の合図を待つ
	line, err := e.readLine(startTimeout)
	if err != nil {
		e.stopLocked()
		return err
	}
	if !strings.HasPrefix(line, "+ready") {
		e.stopLocked()
		return fmt.Errorf("認識エンジンの起動応答が不正: %q", line)
	}
	log.Printf("stt: 認識エンジン起動完了")
	return nil
}

// readLine は1行読む。応答が返らないまま固まるのを防ぐため上限を設ける。
func (e *Engine) readLine(timeout time.Duration) (string, error) {
	type result struct {
		line string
		err  error
	}
	ch := make(chan result, 1)
	r := e.stdout
	go func() {
		line, err := r.ReadString('\n')
		ch <- result{line, err}
	}()
	select {
	case res := <-ch:
		if res.err != nil {
			if errors.Is(res.err, io.EOF) {
				return "", errors.New("認識エンジンが終了しました")
			}
			return "", res.err
		}
		return strings.TrimRight(res.line, "\r\n"), nil
	case <-time.After(timeout):
		return "", errors.New("認識エンジンの応答がタイムアウトしました")
	}
}

func (e *Engine) stopLocked() {
	if e.cmd == nil {
		return
	}
	_ = e.stdin.Close()
	_ = e.cmd.Process.Kill()
	_ = e.cmd.Wait()
	e.cmd, e.stdin, e.stdout = nil, nil, nil
}

func logStderr(r io.Reader) {
	sc := bufio.NewScanner(r)
	for sc.Scan() {
		log.Printf("stt: %s", sc.Text())
	}
}

// toWav はブラウザ録音データ(webm/opus, mp4/aac など)を
// 認識エンジンが読める16kHzモノラルのwavに変換する。
func toWav(audio []byte) (path string, cleanup func(), err error) {
	dir, err := os.MkdirTemp("", "remotehost-stt")
	if err != nil {
		return "", nil, err
	}
	cleanup = func() { os.RemoveAll(dir) }
	src := filepath.Join(dir, "in")
	if err := os.WriteFile(src, audio, 0o600); err != nil {
		cleanup()
		return "", nil, err
	}
	dst := filepath.Join(dir, "out.wav")
	// コンテナ形式はffmpegに判定させる(ブラウザによってwebm/mp4が変わるため)
	cmd := exec.Command("ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
		"-i", src, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", dst)
	if out, err := cmd.CombinedOutput(); err != nil {
		cleanup()
		return "", nil, fmt.Errorf("音声の変換に失敗: %w (%s)", err, strings.TrimSpace(string(out)))
	}
	return dst, cleanup, nil
}

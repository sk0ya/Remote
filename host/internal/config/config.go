// Package config は %APPDATA%\RemoteDesk\config.json への設定永続化を担う。
package config

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/url"
	"os"
	"path/filepath"
	"slices"

	"remotehost/internal/voice"
)

type Config struct {
	HostID    string `json:"hostId"`
	SignalURL string `json:"signalUrl"`
	ClientURL string `json:"clientUrl"` // スマホ用WebアプリのURL(QRに埋め込む)
	// 登録パスキーの資格情報ID と 公開鍵(SPKI DER)。どちらもbase64url。
	// 秘密情報ではないので、漏れても他端末が接続できるようにはならない。
	CredentialID  string   `json:"credentialId"`
	CredentialKey string   `json:"credentialKey"`
	ClientOrigins []string `json:"clientOrigins"` // WebAuthnで受け付けるクライアントのオリジン
	BitrateMbps   int      `json:"bitrateMbps"`   // 映像ビットレート (既定4)
	FPS           int      `json:"fps"`           // フレームレート (既定30)
	// 送出解像度の上限 (既定 1280x720)。モニタの実解像度をそのまま送ると
	// スマホは表示に必要な数倍のデコードを回すことになり、電池を大きく減らす。
	// 大きい画面で見るなど、電力より精細さを取りたいときだけ上げる。
	MaxWidth      int             `json:"maxWidth"`
	MaxHeight     int             `json:"maxHeight"`
	VoiceCommands []voice.Command `json:"voiceCommands"` // 音声コマンド定義 (未指定ならvoice.Defaults())
	STTCommand    string          `json:"sttCommand"`    // 音声認識エンジン(jvi-serve)の実行ファイル
	STTDir        string          `json:"sttDir"`        // その作業ディレクトリ (config.tomlとmodels/がある場所)
}

// defaultClientOrigins はパスキーの検証で許可するオリジンの既定値。
// WebAuthnはセキュアコンテキストでしか動かないため、httpは localhost のみ有効
// (LAN IPのvite devサーバーからはパスキーを作れない)。
func defaultClientOrigins(clientURL string) []string {
	origins := []string{"https://remote-client.pages.dev", "http://localhost:5175"}
	if o := originOf(clientURL); o != "" && !slices.Contains(origins, o) {
		origins = append(origins, o)
	}
	return origins
}

// originOf はURLから scheme://host[:port] を取り出す。解析できなければ空文字。
func originOf(rawURL string) string {
	if rawURL == "" {
		return ""
	}
	u, err := url.Parse(rawURL)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return ""
	}
	return u.Scheme + "://" + u.Host
}

// defaultSTT は同梱の音声認識エンジン (stt/) の場所を、実行ファイルの位置から求める。
// 配置は host/remotehost.exe と stt/ が並ぶリポジトリの構成を前提にする。
func defaultSTT() (cmdPath, workDir string) {
	exe, err := os.Executable()
	if err != nil {
		return "", ""
	}
	workDir = filepath.Clean(filepath.Join(filepath.Dir(exe), "..", "stt"))
	return filepath.Join(workDir, "target", "release", "remote-stt.exe"), workDir
}

const defaultSignalURL = "ws://127.0.0.1:8787/ws"

func dir() (string, error) {
	appData := os.Getenv("APPDATA")
	if appData == "" {
		return "", errors.New("APPDATA not set")
	}
	return filepath.Join(appData, "RemoteDesk"), nil
}

func path() (string, error) {
	d, err := dir()
	if err != nil {
		return "", err
	}
	return filepath.Join(d, "config.json"), nil
}

func randomID(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// Load は設定を読み込む。存在しなければHostIDを生成して新規作成する。
func Load() (*Config, error) {
	p, err := path()
	if err != nil {
		return nil, err
	}
	sttCmd, sttDir := defaultSTT()
	data, err := os.ReadFile(p)
	if errors.Is(err, os.ErrNotExist) {
		c := &Config{
			HostID:        randomID(16),
			SignalURL:     defaultSignalURL,
			ClientOrigins: defaultClientOrigins(""),
			VoiceCommands: voice.Defaults(),
			STTCommand:    sttCmd,
			STTDir:        sttDir,
		}
		if err := c.Save(); err != nil {
			return nil, err
		}
		return c, nil
	}
	if err != nil {
		return nil, err
	}
	var c Config
	if err := json.Unmarshal(data, &c); err != nil {
		return nil, err
	}
	if c.HostID == "" {
		c.HostID = randomID(16)
	}
	if c.SignalURL == "" {
		c.SignalURL = defaultSignalURL
	}
	if c.BitrateMbps <= 0 {
		c.BitrateMbps = 4
	}
	if c.FPS <= 0 {
		c.FPS = 30
	}
	// キー自体が無いときだけ既定値を書き戻す
	// (voiceCommandsの空配列 [] は「音声コマンド無効」の意思表示なので上書きしない)。
	filled := false
	if len(c.ClientOrigins) == 0 {
		c.ClientOrigins = defaultClientOrigins(c.ClientURL)
		filled = true
	} else if o := originOf(c.ClientURL); o != "" && !slices.Contains(c.ClientOrigins, o) {
		// clientUrl を後から書き換えた場合の追従。ここを拾わないと、
		// ペアリングは通るのに接続時のオリジン検証だけが落ちて原因が分かりにくい。
		c.ClientOrigins = append(c.ClientOrigins, o)
		filled = true
	}
	if c.VoiceCommands == nil {
		c.VoiceCommands = voice.Defaults()
		filled = true
	}
	if c.STTCommand == "" {
		c.STTCommand = sttCmd
		filled = true
	}
	if c.STTDir == "" {
		c.STTDir = sttDir
		filled = true
	}
	if filled {
		_ = c.Save() // 編集できるようファイルにも残す。失敗しても動作には影響しない
	}
	return &c, nil
}

func (c *Config) Save() error {
	d, err := dir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(d, 0o700); err != nil {
		return err
	}
	p, err := path()
	if err != nil {
		return err
	}
	data, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, data, 0o600)
}

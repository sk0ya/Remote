// Package config は %APPDATA%\RemoteDesk\config.json への設定永続化を担う。
package config

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"remotehost/internal/voice"
)

type Config struct {
	HostID          string          `json:"hostId"`
	SignalURL       string          `json:"signalUrl"`
	ClientURL       string          `json:"clientUrl"`       // スマホ用WebアプリのURL(QRに埋め込む)
	DeviceTokenHash string          `json:"deviceTokenHash"` // 登録端末トークンのSHA-256 (base64)
	SharedSecret    string          `json:"sharedSecret"`    // SDP HMAC用共有シークレット (base64)
	BitrateMbps     int             `json:"bitrateMbps"`     // 映像ビットレート (既定4)
	FPS             int             `json:"fps"`             // フレームレート (既定30)
	VoiceCommands   []voice.Command `json:"voiceCommands"`   // 音声コマンド定義 (未指定ならvoice.Defaults())
	STTCommand      string          `json:"sttCommand"`      // 音声認識エンジン(jvi-serve)の実行ファイル
	STTDir          string          `json:"sttDir"`          // その作業ディレクトリ (config.tomlとmodels/がある場所)
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

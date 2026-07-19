// Package pair はペアリング(端末登録)と接続時の端末認証を担う。
// ペアリングは (1)ワンタイムコード (2)パスワード (3)同一ネットワーク(公開IP一致)
// の3点を検証し、成功したら端末トークン+共有シークレットを発行する。
// 端末は常に1台のみ: 新しいペアリングは旧端末を自動失効させる。
package pair

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"sync"
	"time"

	"remotehost/internal/config"
)

const (
	codeTTL     = 10 * time.Minute
	codeLen     = 6
	passwordLen = 8
)

var (
	ErrCode    = errors.New("code")     // コード不一致/期限切れ
	ErrPass    = errors.New("password") // パスワード不一致
	ErrNetwork = errors.New("network")  // 同一ネットワークでない
)

// 紛らわしい文字(0/O, 1/I/l)を除いた文字集合
const charset = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"

func randomString(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	out := make([]byte, n)
	for i, v := range b {
		out[i] = charset[int(v)%len(charset)]
	}
	return string(out)
}

func randomBytes(n int) []byte {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return b
}

type Manager struct {
	mu         sync.Mutex
	cfg        *config.Config
	code       string
	password   string // 表示用にペアリングセッション中のみ平文で保持
	codeExpiry time.Time
}

func NewManager(cfg *config.Config) *Manager {
	return &Manager{cfg: cfg}
}

// Begin は新しいペアリングセッションを開始し、QR用コードと表示用パスワードを返す。
// 呼ぶたびにコード・パスワードは作り直される。
func (m *Manager) Begin() (code, password string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.code = randomString(codeLen)
	m.password = randomString(passwordLen)
	m.codeExpiry = time.Now().Add(codeTTL)
	return m.code, m.password
}

// Handle はペアリング要求を検証し、成功なら端末トークンと共有シークレットを発行する。
// clientIP/hostIPはシグナリングサーバーが観測した公開IP(ローカル開発では両方空)。
func (m *Manager) Handle(code, password, clientIP, hostIP string) (token, secret string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.code == "" || time.Now().After(m.codeExpiry) ||
		subtle.ConstantTimeCompare([]byte(code), []byte(m.code)) != 1 {
		return "", "", ErrCode
	}
	if subtle.ConstantTimeCompare([]byte(password), []byte(m.password)) != 1 {
		return "", "", ErrPass
	}
	if clientIP != hostIP {
		return "", "", ErrNetwork
	}

	// コードは使い捨て
	m.code = ""
	m.password = ""

	tokenBytes := randomBytes(32)
	secretBytes := randomBytes(32)
	token = base64.RawURLEncoding.EncodeToString(tokenBytes)
	secret = base64.RawURLEncoding.EncodeToString(secretBytes)

	hash := sha256.Sum256(tokenBytes)
	m.cfg.DeviceTokenHash = base64.RawURLEncoding.EncodeToString(hash[:])
	m.cfg.SharedSecret = secret
	if err := m.cfg.Save(); err != nil {
		return "", "", err
	}
	return token, secret, nil
}

// VerifyToken は接続時の端末トークンを検証する。
func (m *Manager) VerifyToken(token string) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.cfg.DeviceTokenHash == "" {
		return false
	}
	raw, err := base64.RawURLEncoding.DecodeString(token)
	if err != nil {
		return false
	}
	hash := sha256.Sum256(raw)
	stored, err := base64.RawURLEncoding.DecodeString(m.cfg.DeviceTokenHash)
	if err != nil {
		return false
	}
	return subtle.ConstantTimeCompare(hash[:], stored) == 1
}

// Unpair は登録端末を失効させる。
func (m *Manager) Unpair() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cfg.DeviceTokenHash = ""
	m.cfg.SharedSecret = ""
	return m.cfg.Save()
}

// Paired は端末登録済みかどうか。
func (m *Manager) Paired() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cfg.DeviceTokenHash != ""
}

// MAC はSDPのHMAC-SHA256(hex)を計算する。シークレット未設定なら空文字。
func (m *Manager) MAC(sdp string) string {
	m.mu.Lock()
	secret := m.cfg.SharedSecret
	m.mu.Unlock()
	if secret == "" {
		return ""
	}
	key, err := base64.RawURLEncoding.DecodeString(secret)
	if err != nil {
		return ""
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(sdp))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// VerifyMAC はクライアントが付けたSDP MACを検証する。
func (m *Manager) VerifyMAC(sdp, gotMAC string) bool {
	want := m.MAC(sdp)
	return want != "" && hmac.Equal([]byte(want), []byte(gotMAC))
}

// Package pair はペアリング(端末登録)と接続時の端末認証を担う。
// ペアリングは (1)ワンタイムコード (2)パスワード (3)同一ネットワーク(公開IP一致)
// の3点を検証し、成功したらパスキー(WebAuthn資格情報)の登録を受け付ける。
// 登録するのは公開鍵だけで、クライアント側に秘密情報は一切持たせない。
// 端末は常に1つのみ: 新しいペアリングは旧資格情報を自動失効させる。
package pair

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"errors"
	"net/netip"
	"sync"
	"time"

	"remotehost/internal/config"
)

// sameNetwork は2つの観測グローバルIPが同一ネットワークとみなせるか判定する。
// IPv4はNAT越しに同じ公開IPになるため完全一致。
// IPv6は端末ごとにアドレスが異なるため/64プレフィックス一致で判定する。
// (ローカル開発ではどちらも空文字なので一致扱い)
func sameNetwork(a, b string) bool {
	if a == b {
		return true
	}
	ipA, errA := netip.ParseAddr(a)
	ipB, errB := netip.ParseAddr(b)
	if errA != nil || errB != nil {
		return false
	}
	if ipA.Is6() && ipB.Is6() && !ipA.Is4In6() && !ipB.Is4In6() {
		prefA, _ := ipA.Prefix(64)
		prefB, _ := ipB.Prefix(64)
		return prefA == prefB
	}
	return false
}

const (
	codeTTL     = 10 * time.Minute
	codeLen     = 6
	passwordLen = 8
	maxAttempts = 5 // コード/パスワード総当たり対策: 失敗がこの回数に達したらコード失効
	// コード検証が通ってから、実際にパスキーが登録されるまでの猶予。
	// 端末側では生体認証のダイアログが出るので、多少の余裕を見る。
	registerTTL = 3 * time.Minute
)

var (
	ErrCode     = errors.New("code")     // コード不一致/期限切れ
	ErrPass     = errors.New("password") // パスワード不一致
	ErrNetwork  = errors.New("network")  // 同一ネットワークでない
	ErrRegister = errors.New("register") // 登録が許可されていない/期限切れ
	ErrKey      = errors.New("key")      // 公開鍵が不正
	ErrAuth     = errors.New("auth")     // 接続時の認証失敗
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

// Nonce は接続ごとのチャレンジ用乱数を作る。
func Nonce() []byte {
	b := make([]byte, 32)
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
	attempts   int       // 現コードに対する失敗回数
	regExpiry  time.Time // パスキー登録を受け付ける期限 (ゼロ値なら受け付けない)
	regToken   string    // 登録を許可した相手に渡した合言葉 (Registerで照合)
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
	m.attempts = 0
	m.regExpiry = time.Time{}
	m.regToken = ""
	return m.code, m.password
}

// Handle はペアリング要求を検証する。成功すると、続く Register の呼び出しを
// registerTTL のあいだ受け付ける状態になり、その合言葉(regToken)を返す。
// clientIP/hostIPはシグナリングサーバーが観測した公開IP(ローカル開発では両方空)。
func (m *Manager) Handle(code, password, clientIP, hostIP string) (regToken string, err error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	if m.code == "" || time.Now().After(m.codeExpiry) {
		return "", ErrCode
	}
	// 総当たり対策: 失敗が上限に達したらコードを即失効させる。
	if m.attempts >= maxAttempts {
		m.code = ""
		m.password = ""
		return "", ErrCode
	}

	codeOK := subtle.ConstantTimeCompare([]byte(code), []byte(m.code)) == 1
	passOK := subtle.ConstantTimeCompare([]byte(password), []byte(m.password)) == 1
	if !codeOK {
		m.attempts++
		return "", ErrCode
	}
	if !passOK {
		m.attempts++
		return "", ErrPass
	}
	// コード/パスワードは正しい。ネットワーク不一致は推測不能なので試行回数に数えない。
	if !sameNetwork(clientIP, hostIP) {
		return "", ErrNetwork
	}

	// コードは使い捨て
	m.code = ""
	m.password = ""
	m.attempts = 0
	m.regExpiry = time.Now().Add(registerTTL)
	m.regToken = base64.RawURLEncoding.EncodeToString(Nonce())
	return m.regToken, nil
}

// Register は Handle 成功後に、クライアントが作ったパスキーの公開鍵を登録する。
// credID/pubKey はどちらもbase64url (pubKeyはSPKI DER)。
//
// regToken は Handle の戻り値をそのまま返してもらう。中継サーバーの部屋は
// 同一ロールの後から来た接続が先客を蹴り出す作りなので、猶予中に第三者が
// クライアントとして入り直しても、合言葉を知らなければ自分の鍵を登録できない。
// (Handleの応答が届く一瞬の隙に割り込まれる可能性までは塞げていない。
// その場合ユーザー側はペアリングが失敗したように見えるので、やり直せば気づける)
//
// 公開鍵はブラウザの getPublicKey() が返した値をそのまま受け取っており、
// attestationObject を検証しているわけではない。ここは
// 「ワンタイムコード+パスワード+同一ネットワーク」を通った相手だけが到達でき、
// かつ嘘の公開鍵を送っても自分が接続できなくなるだけなので、割に合わない。
func (m *Manager) Register(credID, pubKey, regToken string) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.regExpiry.IsZero() || time.Now().After(m.regExpiry) {
		return ErrRegister
	}
	if subtle.ConstantTimeCompare([]byte(regToken), []byte(m.regToken)) != 1 {
		return ErrRegister
	}
	if credID == "" {
		return ErrKey
	}
	if _, err := parsePublicKey(pubKey); err != nil {
		return ErrKey
	}
	// 保存に失敗したら元の資格情報に戻す。
	// 中途半端に旧端末だけ失効して、どこからも繋がらなくなるのを避ける。
	oldID, oldKey := m.cfg.CredentialID, m.cfg.CredentialKey
	m.cfg.CredentialID = credID
	m.cfg.CredentialKey = pubKey
	if err := m.cfg.Save(); err != nil {
		m.cfg.CredentialID, m.cfg.CredentialKey = oldID, oldKey
		return err
	}
	m.regExpiry = time.Time{}
	m.regToken = ""
	return nil
}

// VerifyAssertion は接続時のWebAuthn assertionを検証する。
// チャレンジには接続ごとのnonceに加えてoffer/answer両方のSDPが練り込まれているため、
// これが通れば「登録済みパスキーの持ち主が、まさにこのSDPのペアで合意した」ことになる。
// 中継サーバーがSDPを書き換えていれば、チャレンジが食い違って弾かれる。
func (m *Manager) VerifyAssertion(nonce []byte, offerSDP, answerSDP string, a Assertion) error {
	m.mu.Lock()
	credID, pubKeyB64 := m.cfg.CredentialID, m.cfg.CredentialKey
	origins := append([]string(nil), m.cfg.ClientOrigins...)
	m.mu.Unlock()

	if credID == "" {
		return ErrAuth
	}
	if subtle.ConstantTimeCompare([]byte(credID), []byte(a.CredID)) != 1 {
		return ErrAuth
	}
	pub, err := parsePublicKey(pubKeyB64)
	if err != nil {
		return ErrAuth
	}
	return verifyAssertion(pub, Challenge(nonce, offerSDP, answerSDP), origins, a)
}

// Paired は端末登録済みかどうか。
func (m *Manager) Paired() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.cfg.CredentialID != ""
}

// Unpair は登録端末を失効させる。
func (m *Manager) Unpair() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.cfg.CredentialID = ""
	m.cfg.CredentialKey = ""
	m.regExpiry = time.Time{}
	m.regToken = ""
	return m.cfg.Save()
}

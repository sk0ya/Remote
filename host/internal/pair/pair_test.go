package pair

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"testing"

	"remotehost/internal/config"
)

func TestSameNetwork(t *testing.T) {
	cases := []struct {
		a, b string
		want bool
	}{
		{"", "", true},                          // ローカル開発
		{"203.0.113.5", "203.0.113.5", true},    // IPv4 NAT同一
		{"203.0.113.5", "203.0.113.6", false},   // IPv4別
		{"2400:2653:c623:4c00::1", "2400:2653:c623:4c00:aaaa:bbbb:cccc:dddd", true}, // 同一/64
		{"2400:2653:c623:4c00::1", "2400:2653:c623:4c01::1", false},                 // 別/64
		{"2400:2653:c623:4c00::1", "203.0.113.5", false},                            // 族違い
		{"", "203.0.113.5", false},
		{"invalid", "invalid2", false},
	}
	for _, c := range cases {
		if got := sameNetwork(c.a, c.b); got != c.want {
			t.Errorf("sameNetwork(%q, %q) = %v, want %v", c.a, c.b, got, c.want)
		}
	}
}

// TestHandleAttemptLimit は誤コードをmaxAttempts回試すとコードが失効し、
// その後は正しいコードでも通らないことを確認する(総当たり対策)。
func TestHandleAttemptLimit(t *testing.T) {
	m := NewManager(&config.Config{})
	code, password := m.Begin()

	for i := 0; i < maxAttempts; i++ {
		if _, err := m.Handle("WRONG!", password, "", ""); !errors.Is(err, ErrCode) {
			t.Fatalf("試行%d: err = %v, want ErrCode", i, err)
		}
	}
	// 上限到達後は正しいコード/パスワードでもコード失効で拒否される。
	if _, err := m.Handle(code, password, "", ""); !errors.Is(err, ErrCode) {
		t.Fatalf("上限超過後: err = %v, want ErrCode(失効)", err)
	}
}

// TestHandleWrongPasswordCounts はパスワード誤りも試行回数に数えられることを確認する。
func TestHandleWrongPasswordCounts(t *testing.T) {
	m := NewManager(&config.Config{})
	code, _ := m.Begin()

	for i := 0; i < maxAttempts; i++ {
		if _, err := m.Handle(code, "badpass!", "", ""); !errors.Is(err, ErrPass) {
			t.Fatalf("試行%d: err = %v, want ErrPass", i, err)
		}
	}
	if _, err := m.Handle(code, "badpass!", "", ""); !errors.Is(err, ErrCode) {
		t.Fatalf("上限超過後: err = %v, want ErrCode(失効)", err)
	}
}

// TestRegisterNeedsHandle はコード検証を通っていない相手がパスキーを登録できないことを確認する。
// ここが抜けると、hostIdさえ知っていれば誰でも自分の鍵を登録できてしまう。
func TestRegisterNeedsHandle(t *testing.T) {
	m := NewManager(&config.Config{})
	_, pubB64 := newTestKey(t)

	if err := m.Register("cred-1", pubB64, "any-token"); !errors.Is(err, ErrRegister) {
		t.Fatalf("Handle前のRegister: err = %v, want ErrRegister", err)
	}
	if m.Paired() {
		t.Fatal("登録されていないのに Paired() = true")
	}
}

// TestRegisterNeedsToken は、コード検証の応答を受け取った相手以外が猶予中に
// 自分の鍵を割り込ませられないことを確認する。同一LANの第三者は観測IPが同じに
// なるためIPでは区別できず、この合言葉だけが頼りになる。
func TestRegisterNeedsToken(t *testing.T) {
	m := NewManager(&config.Config{})
	code, password := m.Begin()
	_, pubB64 := newTestKey(t)
	regToken, err := m.Handle(code, password, "203.0.113.5", "203.0.113.5")
	if err != nil {
		t.Fatalf("Handle = %v, want nil", err)
	}
	if regToken == "" {
		t.Fatal("regTokenが空")
	}
	if err := m.Register("cred-1", pubB64, "guessed-token"); !errors.Is(err, ErrRegister) {
		t.Fatalf("合言葉なしのRegister: err = %v, want ErrRegister", err)
	}
	if m.Paired() {
		t.Fatal("横取り登録が成立してしまった")
	}
}

// TestRegisterRejectsBadKey は公開鍵として読めない値を弾くことを確認する。
func TestRegisterRejectsBadKey(t *testing.T) {
	m := NewManager(&config.Config{})
	code, password := m.Begin()
	regToken, err := m.Handle(code, password, "", "")
	if err != nil {
		t.Fatalf("Handle = %v, want nil", err)
	}
	if err := m.Register("cred-1", "bm90LWEta2V5", regToken); !errors.Is(err, ErrKey) {
		t.Fatalf("不正な公開鍵: err = %v, want ErrKey", err)
	}
}

func TestVerifyAssertion(t *testing.T) {
	const (
		origin    = "https://remote-client.pages.dev"
		credID    = "cred-1"
		offerSDP  = "v=0\r\no=- 1 1 IN IP4 0.0.0.0\r\n"
		answerSDP = "v=0\r\no=- 2 2 IN IP4 0.0.0.0\r\n"
	)
	key, pubB64 := newTestKey(t)
	nonce := Nonce()

	t.Run("正しいassertionは通る", func(t *testing.T) {
		m := newPairedManager(t, credID, pubB64)
		a := signAssertion(t, key, credID, origin, Challenge(nonce, offerSDP, answerSDP), flagUserPresent|flagUserVerified)
		if err := m.VerifyAssertion(nonce, offerSDP, answerSDP, a); err != nil {
			t.Fatalf("VerifyAssertion = %v, want nil", err)
		}
	})

	// 中継サーバーがanswerを差し替えるとチャレンジが食い違って落ちる、が要の性質。
	t.Run("answerが書き換えられたら落ちる", func(t *testing.T) {
		m := newPairedManager(t, credID, pubB64)
		a := signAssertion(t, key, credID, origin, Challenge(nonce, offerSDP, answerSDP), flagUserPresent|flagUserVerified)
		if err := m.VerifyAssertion(nonce, offerSDP, answerSDP+"a=tampered\r\n", a); err == nil {
			t.Fatal("書き換えられたanswerが通ってしまった")
		}
	})

	t.Run("offerが書き換えられたら落ちる", func(t *testing.T) {
		m := newPairedManager(t, credID, pubB64)
		a := signAssertion(t, key, credID, origin, Challenge(nonce, offerSDP+"a=x\r\n", answerSDP), flagUserPresent|flagUserVerified)
		if err := m.VerifyAssertion(nonce, offerSDP, answerSDP, a); err == nil {
			t.Fatal("クライアントが別のofferを見ていたのに通ってしまった")
		}
	})

	t.Run("別セッションのnonceでは通らない", func(t *testing.T) {
		m := newPairedManager(t, credID, pubB64)
		a := signAssertion(t, key, credID, origin, Challenge(Nonce(), offerSDP, answerSDP), flagUserPresent|flagUserVerified)
		if err := m.VerifyAssertion(nonce, offerSDP, answerSDP, a); err == nil {
			t.Fatal("nonce不一致が通ってしまった")
		}
	})

	t.Run("別の鍵では通らない", func(t *testing.T) {
		m := newPairedManager(t, credID, pubB64)
		other, _ := newTestKey(t)
		a := signAssertion(t, other, credID, origin, Challenge(nonce, offerSDP, answerSDP), flagUserPresent|flagUserVerified)
		if err := m.VerifyAssertion(nonce, offerSDP, answerSDP, a); err == nil {
			t.Fatal("別の鍵の署名が通ってしまった")
		}
	})

	t.Run("許可外オリジンは通らない", func(t *testing.T) {
		m := newPairedManager(t, credID, pubB64)
		a := signAssertion(t, key, credID, "https://evil.example", Challenge(nonce, offerSDP, answerSDP), flagUserPresent|flagUserVerified)
		if err := m.VerifyAssertion(nonce, offerSDP, answerSDP, a); err == nil {
			t.Fatal("許可外オリジンが通ってしまった")
		}
	})

	t.Run("本人確認なしは通らない", func(t *testing.T) {
		m := newPairedManager(t, credID, pubB64)
		a := signAssertion(t, key, credID, origin, Challenge(nonce, offerSDP, answerSDP), flagUserPresent)
		if err := m.VerifyAssertion(nonce, offerSDP, answerSDP, a); err == nil {
			t.Fatal("UVなしが通ってしまった")
		}
	})

	t.Run("資格情報IDが違えば通らない", func(t *testing.T) {
		m := newPairedManager(t, credID, pubB64)
		a := signAssertion(t, key, "cred-other", origin, Challenge(nonce, offerSDP, answerSDP), flagUserPresent|flagUserVerified)
		if err := m.VerifyAssertion(nonce, offerSDP, answerSDP, a); err == nil {
			t.Fatal("別の資格情報IDが通ってしまった")
		}
	})

	t.Run("未登録なら常に落ちる", func(t *testing.T) {
		m := NewManager(&config.Config{ClientOrigins: []string{origin}})
		a := signAssertion(t, key, credID, origin, Challenge(nonce, offerSDP, answerSDP), flagUserPresent|flagUserVerified)
		if err := m.VerifyAssertion(nonce, offerSDP, answerSDP, a); !errors.Is(err, ErrAuth) {
			t.Fatalf("未登録: err = %v, want ErrAuth", err)
		}
	})
}

// ---- テスト用ヘルパー ----

func newTestKey(t *testing.T) (*ecdsa.PrivateKey, string) {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKIXPublicKey(&key.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	return key, base64.RawURLEncoding.EncodeToString(der)
}

func newPairedManager(t *testing.T, credID, pubB64 string) *Manager {
	t.Helper()
	return NewManager(&config.Config{
		CredentialID:  credID,
		CredentialKey: pubB64,
		ClientOrigins: []string{"https://remote-client.pages.dev", "http://localhost:5175"},
	})
}

// signAssertion はブラウザが返すassertionを模して組み立てる。
func signAssertion(t *testing.T, key *ecdsa.PrivateKey, credID, origin string, challenge []byte, flags byte) Assertion {
	t.Helper()
	cd, err := json.Marshal(clientData{
		Type:      "webauthn.get",
		Challenge: base64.RawURLEncoding.EncodeToString(challenge),
		Origin:    origin,
	})
	if err != nil {
		t.Fatal(err)
	}
	rpID, err := rpIDOf(origin)
	if err != nil {
		t.Fatal(err)
	}
	rpHash := sha256.Sum256([]byte(rpID))
	authData := append(append([]byte(nil), rpHash[:]...), flags, 0, 0, 0, 1)

	cdHash := sha256.Sum256(cd)
	digest := sha256.Sum256(append(append([]byte(nil), authData...), cdHash[:]...))
	sig, err := ecdsa.SignASN1(rand.Reader, key, digest[:])
	if err != nil {
		t.Fatal(err)
	}
	return Assertion{CredID: credID, ClientData: cd, AuthData: authData, Signature: sig}
}

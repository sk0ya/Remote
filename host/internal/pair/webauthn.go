package pair

// WebAuthn assertion の検証。
//
// 通常のWebAuthnは「ページを配信しているサーバー(RP)」が検証者になるが、
// ここではページはCloudflare Pagesが配信し、検証するのは手元のホストアプリという
// 変則的な構成になる。やることは変わらず、
//   - clientDataJSON の type/challenge/origin を確認する
//   - authenticatorData の rpIdHash と UP/UV フラグを確認する
//   - sha256(authenticatorData || sha256(clientDataJSON)) への署名を公開鍵で検証する
// の3点。対応アルゴリズムはES256 (ECDSA P-256 / SHA-256) だけに絞っている。

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"slices"
)

// Assertion はクライアントから送られてくる navigator.credentials.get() の結果。
type Assertion struct {
	CredID     string // 資格情報ID (base64url)
	ClientData []byte // clientDataJSON の生バイト列
	AuthData   []byte // authenticatorData
	Signature  []byte // ASN.1 DER の ECDSA署名
}

// authenticatorData のフラグ
const (
	flagUserPresent  = 0x01 // タッチなどの物理的操作があった
	flagUserVerified = 0x04 // 生体認証/PINで本人確認が済んでいる
)

const challengeDomain = "remote-auth-v1"

// Challenge は接続ごとのチャレンジを組み立てる。
// nonceはホストが発番し、offer/answerのSDPを両方混ぜることで、
// 署名がこのセッションのSDPペアに束縛される。
// 各要素は長さ前置きで連結し、区切りの曖昧さ(連結の取り違え)をなくす。
func Challenge(nonce []byte, offerSDP, answerSDP string) []byte {
	h := sha256.New()
	write := func(b []byte) {
		var n [8]byte
		binary.BigEndian.PutUint64(n[:], uint64(len(b)))
		h.Write(n[:])
		h.Write(b)
	}
	write([]byte(challengeDomain))
	write(nonce)
	write([]byte(offerSDP))
	write([]byte(answerSDP))
	return h.Sum(nil)
}

// B64Decode はbase64url(パディング有無どちらも)をデコードする。
// ブラウザ側の実装差を吸収するため標準base64も受け付ける。
func B64Decode(s string) ([]byte, error) {
	for _, enc := range []*base64.Encoding{
		base64.RawURLEncoding, base64.URLEncoding,
		base64.RawStdEncoding, base64.StdEncoding,
	} {
		if b, err := enc.DecodeString(s); err == nil {
			return b, nil
		}
	}
	return nil, errors.New("base64として解釈できない")
}

// parsePublicKey はbase64urlのSPKI DERを ECDSA P-256 公開鍵として読む。
func parsePublicKey(b64 string) (*ecdsa.PublicKey, error) {
	der, err := B64Decode(b64)
	if err != nil {
		return nil, err
	}
	key, err := x509.ParsePKIXPublicKey(der)
	if err != nil {
		return nil, err
	}
	pub, ok := key.(*ecdsa.PublicKey)
	if !ok {
		return nil, fmt.Errorf("ECDSA公開鍵ではない (%T)", key)
	}
	if pub.Curve != elliptic.P256() {
		return nil, errors.New("P-256以外の曲線は非対応")
	}
	return pub, nil
}

type clientData struct {
	Type      string `json:"type"`
	Challenge string `json:"challenge"`
	Origin    string `json:"origin"`
}

func verifyAssertion(pub *ecdsa.PublicKey, challenge []byte, origins []string, a Assertion) error {
	var cd clientData
	if err := json.Unmarshal(a.ClientData, &cd); err != nil {
		return fmt.Errorf("clientDataJSONが不正: %w", err)
	}
	if cd.Type != "webauthn.get" {
		return fmt.Errorf("typeが %q", cd.Type)
	}
	gotChallenge, err := B64Decode(cd.Challenge)
	if err != nil {
		return fmt.Errorf("challengeが不正: %w", err)
	}
	// チャレンジはホスト側で組み立てた値そのもの。秘密ではないので定数時間比較は不要。
	if !slices.Equal(gotChallenge, challenge) {
		return errors.New("チャレンジ不一致 (SDPが書き換えられた可能性)")
	}
	if !slices.Contains(origins, cd.Origin) {
		return fmt.Errorf("許可されていないオリジン %q", cd.Origin)
	}

	// authenticatorData: rpIdHash(32) | flags(1) | signCount(4) | ...
	if len(a.AuthData) < 37 {
		return errors.New("authenticatorDataが短すぎる")
	}
	rpID, err := rpIDOf(cd.Origin)
	if err != nil {
		return err
	}
	wantRP := sha256.Sum256([]byte(rpID))
	if !slices.Equal(a.AuthData[:32], wantRP[:]) {
		return fmt.Errorf("rpIdHashが %q と一致しない", rpID)
	}
	flags := a.AuthData[32]
	if flags&flagUserPresent == 0 {
		return errors.New("ユーザー操作(UP)なし")
	}
	// 端末が盗まれた場合の防御はここにしかないため、生体認証/PINは必須にする。
	if flags&flagUserVerified == 0 {
		return errors.New("本人確認(UV)なし")
	}

	cdHash := sha256.Sum256(a.ClientData)
	signed := append(append([]byte(nil), a.AuthData...), cdHash[:]...)
	digest := sha256.Sum256(signed)
	if !ecdsa.VerifyASN1(pub, digest[:], a.Signature) {
		return errors.New("署名検証に失敗")
	}
	return nil
}

// rpIDOf はオリジンからRP ID(ホスト名)を取り出す。ポートは含まない。
func rpIDOf(origin string) (string, error) {
	u, err := url.Parse(origin)
	if err != nil || u.Hostname() == "" {
		return "", fmt.Errorf("オリジンを解析できない: %q", origin)
	}
	return u.Hostname(), nil
}

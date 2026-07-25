package pair

// 再接続チケット。
//
// 接続のたびにパスキーの署名を求めると、ICEが不安定な回線では再接続のたびに
// 生体認証のダイアログが出て使い物にならない。そこで一度パスキー認証を通した
// セッションには短命のチケットを渡し、その間の再接続はチケットで通す。
//
// チケットの受け渡しはDataChannel(認証済みセッションのDTLS経路)に限る。
// 中継サーバー経由で渡すと、中継サーバー自身がパスキーなしで接続できてしまう。
// 保存はメモリのみで、ホストを再起動すれば消える。

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"time"
)

// ticketTTL は生体認証を省ける時間。接続が続いているあいだは
// DataChannelが開くたびに再発行されるので、実質この時間だけ切れていても復帰できる。
const ticketTTL = 10 * time.Minute

// IssueTicket は新しい再接続チケットを発行し、古いものを失効させる。
func (m *Manager) IssueTicket() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ticket = Nonce()
	m.ticketExp = time.Now().Add(ticketTTL)
	return base64.RawURLEncoding.EncodeToString(m.ticket)
}

// HasTicket は有効なチケットを保持しているか。
func (m *Manager) HasTicket() bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	return len(m.ticket) > 0 && time.Now().Before(m.ticketExp)
}

// VerifyTicketMAC はチケットを鍵としたHMACを検証する。
// 対象はassertionと同じ Challenge(nonce, offer, answer) なので、
// 生体認証を省いてもSDPの改ざん検出とリプレイ耐性は変わらない。
func (m *Manager) VerifyTicketMAC(nonce []byte, offerSDP, answerSDP, gotMAC string) bool {
	m.mu.Lock()
	key := append([]byte(nil), m.ticket...)
	exp := m.ticketExp
	m.mu.Unlock()

	if len(key) == 0 || time.Now().After(exp) {
		return false
	}
	mac := hmac.New(sha256.New, key)
	mac.Write(Challenge(nonce, offerSDP, answerSDP))
	want := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return subtle.ConstantTimeCompare([]byte(want), []byte(gotMAC)) == 1
}

// ClearTicket はチケットを失効させる。
func (m *Manager) ClearTicket() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ticket = nil
	m.ticketExp = time.Time{}
}

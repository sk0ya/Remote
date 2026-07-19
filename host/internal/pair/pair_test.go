package pair

import (
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
		if _, _, err := m.Handle("WRONG!", password, "", ""); !errors.Is(err, ErrCode) {
			t.Fatalf("試行%d: err = %v, want ErrCode", i, err)
		}
	}
	// 上限到達後は正しいコード/パスワードでもコード失効で拒否される。
	if _, _, err := m.Handle(code, password, "", ""); !errors.Is(err, ErrCode) {
		t.Fatalf("上限超過後: err = %v, want ErrCode(失効)", err)
	}
}

// TestHandleWrongPasswordCounts はパスワード誤りも試行回数に数えられることを確認する。
func TestHandleWrongPasswordCounts(t *testing.T) {
	m := NewManager(&config.Config{})
	code, _ := m.Begin()

	for i := 0; i < maxAttempts; i++ {
		if _, _, err := m.Handle(code, "badpass!", "", ""); !errors.Is(err, ErrPass) {
			t.Fatalf("試行%d: err = %v, want ErrPass", i, err)
		}
	}
	if _, _, err := m.Handle(code, "badpass!", "", ""); !errors.Is(err, ErrCode) {
		t.Fatalf("上限超過後: err = %v, want ErrCode(失効)", err)
	}
}

func TestHasSecret(t *testing.T) {
	m := NewManager(&config.Config{})
	if m.HasSecret() {
		t.Fatal("新規Managerで HasSecret() = true, want false")
	}
	m.cfg.SharedSecret = "abc"
	if !m.HasSecret() {
		t.Fatal("シークレット設定後 HasSecret() = false, want true")
	}
}

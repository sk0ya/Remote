package pair

import "testing"

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

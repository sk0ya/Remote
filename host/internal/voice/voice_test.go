package voice

import "testing"

func TestMatch(t *testing.T) {
	cmds := []Command{
		{Name: "メモ帳", Phrases: []string{"メモ帳"}, Run: "notepad.exe"},
		{Name: "コピー", Phrases: []string{"コピー"}, Keys: []string{"ControlLeft+KeyC"}},
		{Name: "全部コピー", Phrases: []string{"全部コピー"}, Keys: []string{"ControlLeft+KeyA"}},
	}
	tests := []struct {
		utterance string
		want      string // "" は不一致(=ディクテーション行き)
	}{
		{"メモ帳", "メモ帳"},
		{"メモ帳を開いて", "メモ帳"},           // フレーズを含んでいれば一致
		{"メモ帳、開いて。", "メモ帳"},          // 句読点は無視
		{" コピー ", "コピー"},              // 前後の空白は無視
		{"全部コピー", "全部コピー"},           // 長いフレーズを優先("コピー"に負けない)
		{"今日の議事録をまとめておいて", ""},      // 定義になければ不一致
		{"", ""},
	}
	for _, tc := range tests {
		c, ok := Match(cmds, tc.utterance)
		if tc.want == "" {
			if ok {
				t.Errorf("Match(%q) = %q, 不一致を期待", tc.utterance, c.Name)
			}
			continue
		}
		if !ok || c.Name != tc.want {
			t.Errorf("Match(%q) = %q,%v; want %q", tc.utterance, c.Name, ok, tc.want)
		}
	}
}

func TestDefaultsAreMatchable(t *testing.T) {
	for _, c := range Defaults() {
		if len(c.Phrases) == 0 {
			t.Errorf("%q にフレーズが無い", c.Name)
		}
		if c.Run == "" && len(c.Keys) == 0 && c.Text == "" {
			t.Errorf("%q に動作が無い", c.Name)
		}
		for _, p := range c.Phrases {
			if got, ok := Match(Defaults(), p); !ok || got.Name != c.Name {
				t.Errorf("フレーズ %q が %q ではなく %q(ok=%v)に一致した", p, c.Name, got.Name, ok)
			}
		}
	}
}

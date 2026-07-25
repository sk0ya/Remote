// Package voice はクライアント(スマホ)の音声認識結果を解釈する。
// 認識自体はブラウザのWeb Speech APIが行い、ホストは受け取った発話テキストを
// 設定されたコマンドの言い回しと照合して実行する。
// 一致しなかった発話はそのままテキスト入力(ディクテーション)として扱う。
//
// 実行できるのは config.json に書かれたコマンドだけ(ホワイトリスト方式)。
// 音声認識は必ず誤認識するので、任意コマンド実行にはしていない。
package voice

import (
	"fmt"
	"os/exec"
	"strings"
	"unicode"

	"remotehost/internal/input"
)

// Command は「この言い回しを聞いたらこれをする」の1件。
// Run / Keys / Text は併記でき、その順に実行される。
type Command struct {
	Name    string   `json:"name"`           // ログ・スマホ側表示に使う名前
	Phrases []string `json:"phrases"`        // 一致させる言い回し(複数可)
	Run     string   `json:"run,omitempty"`  // 起動する実行ファイル
	Args    []string `json:"args,omitempty"` // Run の引数
	Keys    []string `json:"keys,omitempty"` // 送出するキー。"ControlLeft+KeyC" のように + で同時押し
	Text    string   `json:"text,omitempty"` // 打ち込む固定テキスト
}

// Defaults は config.json に voiceCommands が無いときに書き込まれる初期セット。
// ユーザーがconfigを編集して自由に足し引きする前提の叩き台。
func Defaults() []Command {
	return []Command{
		{Name: "メモ帳", Phrases: []string{"メモ帳", "notepad"}, Run: "notepad.exe"},
		{Name: "電卓", Phrases: []string{"電卓", "計算機"}, Run: "calc.exe"},
		{Name: "エクスプローラー", Phrases: []string{"エクスプローラー", "ファイルを開いて"}, Run: "explorer.exe"},
		{Name: "ブラウザ", Phrases: []string{"ブラウザ", "ネット開いて"}, Run: "cmd.exe", Args: []string{"/c", "start", "", "https://www.google.com/"}},
		{Name: "コピー", Phrases: []string{"コピー"}, Keys: []string{"ControlLeft+KeyC"}},
		{Name: "貼り付け", Phrases: []string{"貼り付け", "ペースト"}, Keys: []string{"ControlLeft+KeyV"}},
		{Name: "元に戻す", Phrases: []string{"元に戻す", "取り消し"}, Keys: []string{"ControlLeft+KeyZ"}},
		{Name: "保存", Phrases: []string{"保存"}, Keys: []string{"ControlLeft+KeyS"}},
		{Name: "閉じる", Phrases: []string{"閉じて", "ウィンドウを閉じる"}, Keys: []string{"AltLeft+F4"}},
		{Name: "タスクビュー", Phrases: []string{"タスクビュー", "タスク切り替え"}, Keys: []string{"MetaLeft+Tab"}},
		{Name: "デスクトップ", Phrases: []string{"デスクトップ"}, Keys: []string{"MetaLeft+KeyD"}},
		{Name: "画面ロック", Phrases: []string{"画面ロック", "ロックして"}, Keys: []string{"MetaLeft+KeyL"}},
	}
}

// normalize は照合用に発話を潰す。空白・句読点・記号を落として小文字化するので、
// 「メモ帳、開いて。」と「めもちょう ひらいて」の表記ゆれを吸収できる。
func normalize(s string) string {
	var b strings.Builder
	for _, r := range s {
		if unicode.IsSpace(r) || unicode.IsPunct(r) || unicode.IsSymbol(r) {
			continue
		}
		b.WriteRune(unicode.ToLower(r))
	}
	return b.String()
}

// Match は発話に一致するコマンドを返す。フレーズが発話に含まれていれば一致とみなす
// (「メモ帳を開いて」で "メモ帳" にヒットさせるため)。
// 複数一致したときは、いちばん長いフレーズ=より具体的な指示を優先する。
func Match(cmds []Command, utterance string) (Command, bool) {
	u := normalize(utterance)
	if u == "" {
		return Command{}, false
	}
	best, bestLen := -1, 0
	for i, c := range cmds {
		for _, p := range c.Phrases {
			n := normalize(p)
			if n == "" || !strings.Contains(u, n) {
				continue
			}
			if len(n) > bestLen {
				best, bestLen = i, len(n)
			}
		}
	}
	if best < 0 {
		return Command{}, false
	}
	return cmds[best], true
}

// Execute はコマンドを Run → Keys → Text の順に実行する。
func Execute(c Command) error {
	if c.Run != "" {
		cmd := exec.Command(c.Run, c.Args...)
		if err := cmd.Start(); err != nil {
			return fmt.Errorf("%s の起動に失敗: %w", c.Run, err)
		}
		go cmd.Wait() // プロセスハンドルを回収するだけ。終了は待たない
	}
	for _, k := range c.Keys {
		if !input.Combo(strings.Split(k, "+")) {
			return fmt.Errorf("キー指定が不正: %s", k)
		}
	}
	if c.Text != "" {
		input.Text(c.Text)
	}
	return nil
}

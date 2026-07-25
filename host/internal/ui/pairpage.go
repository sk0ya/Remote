// Package ui はペアリング用QRコード表示ページを127.0.0.1で提供する。
package ui

import (
	"encoding/base64"
	"fmt"
	"html/template"
	"net"
	"net/http"
	"os/exec"

	qrcode "github.com/skip2/go-qrcode"

	"remotehost/internal/config"
	"remotehost/internal/pair"
)

var pageTmpl = template.Must(template.New("pair").Parse(`<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>Remote ペアリング</title>
<style>
body { font-family: system-ui, sans-serif; background:#111318; color:#e6e8ee;
       display:flex; flex-direction:column; align-items:center; padding:40px; gap:16px; }
img { border-radius: 12px; }
.pw { font-size: 32px; letter-spacing: 6px; font-weight: 700; background:#1a1e27;
      padding: 12px 24px; border-radius: 12px; }
p { color:#9aa0ae; max-width: 480px; text-align:center; line-height:1.7; }
.warn { color:#e6b450; }
.url { font-size: 12px; color:#6b7285; word-break: break-all; max-width: 480px; }
</style></head><body>
<h1>スマホでペアリング</h1>
<img src="data:image/png;base64,{{.QR}}" width="256" height="256" alt="QR">
<div>パスワード</div>
<div class="pw">{{.Password}}</div>
<p>スマホのカメラでQRコードを読み取り、開いたページに上のパスワードを入力してください。<br>
続けてパスキーの作成を求められるので、顔認証・指紋などで承認してください。<br>
スマホはこのPCと同じWi-Fiに接続しておく必要があります。<br>
コードの有効期限は10分です(このページを再読み込みすると新しいコードになります)。</p>
{{if .Paired}}<p class="warn">既に登録済みのパスキーがあります。新しくペアリングすると古いパスキーでは接続できなくなります。</p>{{end}}
<p class="url">QRが読めない場合はスマホで直接開く: <span id="pair-url">{{.PairURL}}</span></p>
</body></html>`))

// StartPairServer はQRページのHTTPサーバーを起動し、ページURLを返す。
func StartPairServer(m *pair.Manager, cfg *config.Config) (string, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		code, password := m.Begin()
		pairURL := fmt.Sprintf("%s/#/pair?h=%s&c=%s", clientURL(cfg), cfg.HostID, code)
		png, err := qrcode.Encode(pairURL, qrcode.Medium, 256)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_ = pageTmpl.Execute(w, map[string]any{
			"QR":       base64.StdEncoding.EncodeToString(png),
			"Password": password,
			"Paired":   m.Paired(),
			"PairURL":  pairURL,
		})
	})
	go func() { _ = http.Serve(ln, mux) }()
	return fmt.Sprintf("http://%s/", ln.Addr()), nil
}

func clientURL(cfg *config.Config) string {
	if cfg.ClientURL != "" {
		return cfg.ClientURL
	}
	// 未設定なら開発用: このPCのLAN IP上のvite devサーバー
	return fmt.Sprintf("http://%s:5175", lanIP())
}

func lanIP() string {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return "127.0.0.1"
	}
	defer conn.Close()
	return conn.LocalAddr().(*net.UDPAddr).IP.String()
}

// OpenBrowser は既定ブラウザでURLを開く。
func OpenBrowser(url string) {
	_ = exec.Command("rundll32", "url.dll,FileProtocolHandler", url).Start()
}

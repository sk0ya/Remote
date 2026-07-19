// タスクトレイ常駐UI。
package ui

import (
	_ "embed"

	"github.com/getlantern/systray"

	"remotehost/internal/pair"
)

//go:embed assets/icon.ico
var iconData []byte

// TrayCallbacks はトレイメニューから呼ばれる操作。
type TrayCallbacks struct {
	PairPageURL string
	OnQuit      func()
}

// RunTray はトレイを起動する。UIスレッドを占有するためmainから呼ぶこと。
// ready はメニュー構築後に呼ばれる。
func RunTray(pm *pair.Manager, cb TrayCallbacks, ready func(setStatus func(string))) {
	systray.Run(func() {
		systray.SetIcon(iconData)
		systray.SetTitle("Remote Host")
		systray.SetTooltip("Remote Host")

		status := systray.AddMenuItem("状態: 起動中...", "")
		status.Disable()
		systray.AddSeparator()
		showQR := systray.AddMenuItem("ペアリングQRを表示", "スマホを登録する")
		unpair := systray.AddMenuItem("端末登録を解除", "登録済みスマホを失効させる")
		systray.AddSeparator()
		quit := systray.AddMenuItem("終了", "")

		go func() {
			for {
				select {
				case <-showQR.ClickedCh:
					OpenBrowser(cb.PairPageURL)
				case <-unpair.ClickedCh:
					_ = pm.Unpair()
					status.SetTitle("状態: 端末未登録")
				case <-quit.ClickedCh:
					systray.Quit()
				}
			}
		}()

		ready(func(s string) { status.SetTitle("状態: " + s) })
	}, func() {
		if cb.OnQuit != nil {
			cb.OnQuit()
		}
	})
}

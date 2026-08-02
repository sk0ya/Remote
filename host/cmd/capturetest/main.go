// 画面キャプチャパイプラインの診断ツール。
// 3秒間キャプチャしてフレーム数・データ量を表示する。
package main

import (
	"context"
	"log"
	"time"

	"remotehost/internal/display"
	"remotehost/internal/media"
)

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	// 本番と同じ条件で測る。モニタの実解像度を渡さないと縮小が働かず、
	// 実際に送られるものとは別のパイプラインを診断することになる。
	opts := media.Options{}
	mons := display.List()
	if len(mons) > 0 {
		m := mons[display.PrimaryIndex(mons)]
		opts.Display = display.PrimaryIndex(mons)
		opts.X, opts.Y, opts.W, opts.H = m.X, m.Y, m.W, m.H
	}
	opts = opts.Normalize()
	ow, oh := opts.EncodedSize()
	log.Printf("キャプチャ %dx%d → 送出 %dx%d @%dfps", opts.W, opts.H, ow, oh, opts.FPS)

	ch := make(chan media.Sample, 8)
	done := make(chan error, 1)
	go func() { done <- media.Capture(ctx, opts, ch) }()

	var frames, bytes int
	start := time.Now()
	deadline := time.After(3 * time.Second)
loop:
	for {
		select {
		case s := <-ch:
			frames++
			bytes += len(s.Data)
			if frames == 1 {
				log.Printf("最初のフレーム: %d bytes (起動から %v)", len(s.Data), time.Since(start).Round(time.Millisecond))
			}
		case err := <-done:
			log.Fatalf("キャプチャ失敗: %v", err)
		case <-deadline:
			break loop
		}
	}
	elapsed := time.Since(start).Seconds()
	log.Printf("結果: %dフレーム / %.1f秒 = %.1f fps, 平均 %d KB/frame, 実効 %.1f Mbps",
		frames, elapsed, float64(frames)/elapsed, bytes/max(frames, 1)/1024,
		float64(bytes)*8/elapsed/1e6)
}

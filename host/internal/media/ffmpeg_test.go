package media

import (
	"bytes"
	"io"
	"strings"
	"testing"
	"time"
)

func names(ps []pipeline) string {
	out := make([]string, len(ps))
	for i, p := range ps {
		out[i] = p.name
	}
	return strings.Join(out, ",")
}

// 使えるエンコーダはマシン構成で決まり毎回同じなので、一度分かったら次はそこから
// 試す。これが効かないと、接続のたびに使えない候補を順に潰すぶんだけ
// 映像が出るまでの待ちが伸びる。
func TestOrderedPrefersLastGood(t *testing.T) {
	t.Cleanup(func() { rememberEncoder("") })
	ps := pipelines(Options{}.Normalize())
	original := names(ps)

	rememberEncoder("")
	if got := names(ordered(ps)); got != original {
		t.Errorf("記憶が無いときは元の順序のまま: %s", got)
	}

	rememberEncoder("libx264")
	got := names(ordered(ps))
	if !strings.HasPrefix(got, "libx264,") {
		t.Errorf("記憶したエンコーダが先頭に来ていない: %s", got)
	}
	if len(ordered(ps)) != len(ps) {
		t.Errorf("候補が増減している: %s", got)
	}
	for _, p := range ps {
		if !strings.Contains(","+got+",", ","+p.name+",") {
			t.Errorf("候補 %q が落ちている: %s", p.name, got)
		}
	}

	rememberEncoder("h264_nvenc") // もともと先頭
	if got := names(ordered(ps)); got != original {
		t.Errorf("先頭のままのはずが並び替わった: %s", got)
	}

	rememberEncoder("存在しないエンコーダ")
	if got := names(ordered(ps)); got != original {
		t.Errorf("知らない名前は無視するはず: %s", got)
	}
}

// スマホのデコード電力はほぼピクセル数に比例する。4Kデスクトップをそのまま送ると、
// 実際には800px幅程度でしか表示しないスマホに8倍のデコードをさせることになり、
// ハードウェアデコーダの上限を超えればソフトウェアデコードに落ちて電池を焼く。
func TestFitScale(t *testing.T) {
	tests := []struct {
		name         string
		sw, sh       int
		mw, mh       int
		wantW, wantH int
	}{
		{"4Kは720pまで落とす", 3840, 2160, 1280, 720, 1280, 720},
		{"WQHDも同じ", 2560, 1440, 1280, 720, 1280, 720},
		{"16:10は縦に合わせて横を詰める", 1920, 1200, 1280, 720, 1152, 720},
		{"FHDは横が先に当たる", 1920, 1080, 1280, 720, 1280, 720},
		{"ちょうど収まるなら変換しない", 1280, 720, 1280, 720, 0, 0},
		{"小さい画面を引き伸ばさない", 800, 600, 1280, 720, 0, 0},
		{"上限が無ければ素通し", 1920, 1080, 0, 0, 0, 0},
		{"キャプチャ元が不明なら素通し", 0, 0, 1280, 720, 0, 0},
		// H.264 4:2:0 は偶数解像度しか扱えない。奇数を渡すとffmpegが落ちる。
		{"偶数に丸める", 1000, 666, 999, 999, 998, 664},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w, h := fitScale(tt.sw, tt.sh, tt.mw, tt.mh)
			if w != tt.wantW || h != tt.wantH {
				t.Errorf("fitScale(%d,%d,%d,%d) = %dx%d, want %dx%d",
					tt.sw, tt.sh, tt.mw, tt.mh, w, h, tt.wantW, tt.wantH)
			}
			if w%2 != 0 || h%2 != 0 {
				t.Errorf("奇数解像度を返した: %dx%d", w, h)
			}
			if tt.mw > 0 && (w > tt.mw || h > tt.mh) {
				t.Errorf("上限 %dx%d を超えた: %dx%d", tt.mw, tt.mh, w, h)
			}
		})
	}
}

// クライアントが表示サイズを伝えてこなくても、既定の上限までは必ず落とす。
// 「何も言わなければ実解像度をそのまま送る」が電池切れの主因だった。
func TestEncodedSizeCapsEvenWithoutClientHint(t *testing.T) {
	tests := []struct {
		name         string
		opts         Options
		wantW, wantH int
	}{
		{"申告なしでも既定の上限まで落とす",
			Options{W: 3840, H: 2160}, capW, capH},
		{"クライアントが小さいと言えばそれに従う",
			Options{W: 3840, H: 2160, MaxW: 640, MaxH: 360}, 640, 360},
		{"上限より大きい申告は信用しない",
			Options{W: 3840, H: 2160, MaxW: 4096, MaxH: 4096}, capW, capH},
		{"設定で上限を上げれば従う",
			Options{W: 3840, H: 2160, CapW: 1920, CapH: 1080}, 1920, 1080},
		{"上限を上げてもクライアントの申告が優先",
			Options{W: 3840, H: 2160, CapW: 1920, CapH: 1080, MaxW: 800, MaxH: 450}, 800, 450},
		{"上限に収まるモニタはそのまま",
			Options{W: 1024, H: 600}, 1024, 600},
		{"4:3は縦が先に当たる",
			Options{W: 1024, H: 768}, 960, 720},
		{"モニタ不明ならサイズも不明",
			Options{}, 0, 0},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			w, h := tt.opts.Normalize().EncodedSize()
			if w != tt.wantW || h != tt.wantH {
				t.Errorf("EncodedSize() = %dx%d, want %dx%d", w, h, tt.wantW, tt.wantH)
			}
		})
	}
}

// SDPで名乗るプロファイルと実際に送るストリームが食い違うと、スマホは
// ハードウェアデコーダを使えずソフトウェアデコードに落ちる。h264_nvenc の既定は
// main なので、baseline を名乗る以上は全エンコーダで明示的に指定しなければならない。
func TestPipelinesPinProfileAndScale(t *testing.T) {
	opts := Options{W: 3840, H: 2160}.Normalize()
	for _, p := range pipelines(opts) {
		args := strings.Join(buildArgs(p, opts), " ")
		if !strings.Contains(args, "baseline") {
			t.Errorf("%s: baseline を指定していない: %s", p.name, args)
		}
		if !strings.Contains(args, "1280") || !strings.Contains(args, "720") {
			t.Errorf("%s: 720pへの縮小が入っていない: %s", p.name, args)
		}
	}
}

// GPU内での縮小 (scale_d3d11) は古いドライバでテクスチャを作れず落ちることがある。
// それだけを頼りにすると、NVENCを持つPCがCPUエンコードまで転げ落ちてしまうので、
// 読み戻してから縮小するハードウェアエンコード構成を必ず後ろに用意しておく。
func TestScaledPipelinesKeepHardwareFallback(t *testing.T) {
	ps := pipelines(Options{W: 3840, H: 2160}.Normalize())

	seen := map[string]bool{}
	for _, p := range ps {
		// ordered/rememberEncoder は名前で候補を引くので重複は許されない
		if seen[p.name] {
			t.Errorf("候補名が重複している: %s", p.name)
		}
		seen[p.name] = true
	}

	for _, enc := range []string{"h264_nvenc", "h264_amf"} {
		gpu, fallback := -1, -1
		for i, p := range ps {
			switch p.name {
			case enc + "(GPU縮小)":
				gpu = i
			case enc:
				fallback = i
			}
		}
		if gpu < 0 {
			t.Errorf("%s: GPU内で縮小する候補が無い", enc)
			continue
		}
		if fallback < 0 {
			t.Errorf("%s: scale_d3d11 が使えないときの候補が無い", enc)
			continue
		}
		if gpu > fallback {
			t.Errorf("%s: 安いGPU縮小より先に読み戻し版を試している", enc)
		}
		if strings.Contains(strings.Join(ps[fallback].args, " "), "scale_d3d11") {
			t.Errorf("%s: フォールバックが scale_d3d11 に依存している", enc)
		}
	}
}

// 縮小が不要なときにスケールフィルタを挟むと、無駄な変換コストがPC側にかかる。
func TestPipelinesSkipScaleWhenNotNeeded(t *testing.T) {
	opts := Options{W: 1280, H: 720}.Normalize()
	for _, p := range pipelines(opts) {
		args := strings.Join(buildArgs(p, opts), " ")
		if strings.Contains(args, "scale_d3d11") || strings.Contains(args, ",scale=") {
			t.Errorf("%s: 不要なスケールが入っている: %s", p.name, args)
		}
	}
}

// 画面が動いていないあいだフレームを複製して送り続けるのが、待機中でも
// 電力を全開で使っていた原因。ddagrab には複製を止めるスイッチがある。
func TestDdagrabStopsDuplicateFrames(t *testing.T) {
	opts := Options{W: 1920, H: 1080}.Normalize()
	for _, p := range pipelines(opts) {
		args := strings.Join(buildArgs(p, opts), " ")
		if !strings.Contains(args, "ddagrab") {
			continue // gdigrabフォールバックには複製の概念がない
		}
		if !strings.Contains(args, "dup_frames=0") {
			t.Errorf("%s: 複製フレームを止めていない: %s", p.name, args)
		}
		// dup_frames=0 だけではエンコード段で複製し直されてCFRに戻る。
		// 実測でも vfr を付けて初めて枚数が落ちた (120→68フレーム/4秒)。
		if !strings.Contains(args, "-fps_mode vfr") {
			t.Errorf("%s: fps_mode vfr が無いとエンコード段で複製し直される: %s", p.name, args)
		}
	}
}

// パイプに溜めさせると、フレームは次のフレームに押し出されて初めて出てくる。
// dup_frames=0 では次が何分も来ないので、そのあいだ画面が更新されない。
func TestPipelinesFlushEachFrame(t *testing.T) {
	opts := Options{W: 1920, H: 1080}.Normalize()
	for _, p := range pipelines(opts) {
		args := strings.Join(buildArgs(p, opts), " ")
		if !strings.Contains(args, "-flush_packets 1") {
			t.Errorf("%s: フレームごとに押し出していない: %s", p.name, args)
		}
	}
}

// 複製をやめるとフレーム間隔が可変になる。固定値のままRTPタイムスタンプを
// 進めると、静止するたびに映像の時計が実時間からずれていく。
func TestPaceKeeperMeasuresRealGaps(t *testing.T) {
	t0 := time.Unix(0, 0)
	p := &paceKeeper{}

	if got := p.gap(t0); got != 0 {
		t.Errorf("1枚目は基準が無いので進めない: %v", got)
	}
	p.sent(t0)
	if got := p.gap(t0.Add(100 * time.Millisecond)); got != 100*time.Millisecond {
		t.Errorf("2枚目は実測の間隔になるはず: %v", got)
	}
	p.sent(t0.Add(100 * time.Millisecond))
	if got := p.gap(t0.Add(2100 * time.Millisecond)); got != 2*time.Second {
		t.Errorf("静止していた2秒がそのまま乗るはず: %v", got)
	}
}

// 静止した時間を頭打ちにすると、そのぶんRTPの時計が実時間から遅れ、
// ずれは静止のたびに積み上がる。受け側はRTPと到着の間隔の差を伝送遅延と
// みなすので、「回線が数分詰まっている」と申告し続けることになる。
func TestPaceKeeperKeepsLongIdleIntact(t *testing.T) {
	t0 := time.Unix(0, 0)
	p := &paceKeeper{}
	p.sent(t0)

	if got := p.gap(t0.Add(time.Hour)); got != time.Hour {
		t.Errorf("長い静止を切り詰めている: %v", got)
	}
	if got := p.gap(t0); got != minSampleGap {
		t.Errorf("同時刻のフレームに正の長さを与えていない: %v", got)
	}
}

// 受け側が詰まって捨てたフレームの時間を失うと、そのぶん映像が早送りになる。
func TestPaceKeeperCarriesDroppedTime(t *testing.T) {
	t0 := time.Unix(0, 0)
	p := &paceKeeper{}
	p.sent(t0)

	p.gap(t0.Add(100 * time.Millisecond)) // 送信キューが詰まっていて捨てた (sentを呼ばない)

	if got := p.gap(t0.Add(150 * time.Millisecond)); got != 150*time.Millisecond {
		t.Errorf("捨てた100msが次に繰り越されていない: %v", got)
	}
	p.sent(t0.Add(150 * time.Millisecond))
	if got := p.gap(t0.Add(200 * time.Millisecond)); got != 50*time.Millisecond {
		t.Errorf("繰り越しを二重に足している: %v", got)
	}
}

// アクセスユニットの切れ目は次のAUの先頭が届いて初めて分かる。それを待つと、
// 画面が止まった瞬間のフレーム (=指を止めたときのカーソル位置) が、次に画面が
// 動くまで届かない。ホストが黙っても最後の1枚が出てくることを確かめる。
func TestReadAccessUnitsDeliversLastFrameWhileIdle(t *testing.T) {
	au := []byte{0, 0, 0, 1, 0x65, 0x88} // IDRスライス (first_mb_in_slice=0)
	r, w := io.Pipe()
	defer w.Close()
	ch := make(chan Sample, 8)
	go func() { _ = readAccessUnits(r, ch, make(chan struct{}), time.Now) }()

	for i := 0; i < 3; i++ {
		if _, err := w.Write(au); err != nil {
			t.Fatalf("書き込み失敗: %v", err)
		}
	}
	// ここで書き込みを止める。ffmpegが黙ったのと同じ状態。
	for i := 0; i < 3; i++ {
		select {
		case s := <-ch:
			if !bytes.Equal(s.Data, au) {
				t.Errorf("%d枚目のバイト列が違う: %x", i+1, s.Data)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%d枚目が届かない (書き込みが止まると出てこない)", i+1)
		}
	}
}

// 1フレームがSPS/PPSと複数NALに分かれていても、まとめて1枚として送る。
// 途中で切ると、受け側はパラメータセットの無いフレームを受け取ることになる。
func TestReadAccessUnitsGroupsNALsIntoFrames(t *testing.T) {
	sps := []byte{0, 0, 0, 1, 0x67, 0x42}
	pps := []byte{0, 0, 0, 1, 0x68, 0xce}
	idr := []byte{0, 0, 0, 1, 0x65, 0x88}
	next := []byte{0, 0, 0, 1, 0x41, 0x9a} // 次フレームのPスライス

	r, w := io.Pipe()
	defer w.Close()
	ch := make(chan Sample, 8)
	go func() { _ = readAccessUnits(r, ch, make(chan struct{}), time.Now) }()

	var first []byte
	first = append(append(append(first, sps...), pps...), idr...)
	if _, err := w.Write(append(append([]byte(nil), first...), next...)); err != nil {
		t.Fatalf("書き込み失敗: %v", err)
	}

	want := [][]byte{first, next}
	for i, exp := range want {
		select {
		case s := <-ch:
			if !bytes.Equal(s.Data, exp) {
				t.Errorf("%d枚目 = %x, want %x", i+1, s.Data, exp)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%d枚目が届かない", i+1)
		}
	}
}

// SDPの profile-level-id は「このストリームをデコードするのに必要な能力」の宣言。
// 実際より低いレベルを名乗ると、スマホのハードウェアデコーダが対応を拒み、
// ソフトウェアデコードに落ちて電池と発熱で跳ね返る。以前は解像度に関わらず
// 3.1 (最大1280x720@30) 固定を名乗りながら、4Kをそのまま流していた。
func TestProfileLevelID(t *testing.T) {
	tests := []struct {
		name string
		w, h int
		fps  int
		kbps int
		want string
	}{
		{"720p30はレベル3.1ちょうど", 1280, 720, 30, 4000, "42e01f"},
		{"1080p30はマクロブロック数が3.1を超える", 1920, 1080, 30, 4000, "42e028"},
		{"4K30はさらに上", 3840, 2160, 30, 8000, "42e033"},
		{"小さくても3.1を下回っては名乗らない", 640, 360, 30, 1000, "42e01f"},
		{"高fpsはMBPSでレベルが上がる", 1280, 720, 60, 4000, "42e020"},
		{"ビットレートだけでもレベルは上がる", 1280, 720, 30, 30000, "42e029"},
		{"解像度不明なら安全側に倒して上限を名乗る", 0, 0, 30, 4000, "42e034"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ProfileLevelID(tt.w, tt.h, tt.fps, tt.kbps); got != tt.want {
				t.Errorf("ProfileLevelID(%d,%d,%d,%d) = %s, want %s",
					tt.w, tt.h, tt.fps, tt.kbps, got, tt.want)
			}
		})
	}
}

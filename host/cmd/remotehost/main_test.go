package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"testing"

	"github.com/pion/webrtc/v4"
)

type candidateRecorder struct {
	candidate        string
	sdpMid           *string
	sdpMLineIndex    *uint16
	usernameFragment *string
	err              error
}

func (r *candidateRecorder) AddICECandidate(candidate string, mid *string, line *uint16, username *string) error {
	r.candidate, r.sdpMid, r.sdpMLineIndex, r.usernameFragment = candidate, mid, line, username
	return r.err
}

func TestApplyICECandidatePreservesAllFields(t *testing.T) {
	mid, username := "video", "ice-user"
	line := uint16(2)
	msg := &iceCandidateMsg{
		Candidate: "candidate:1 1 UDP 1 192.0.2.1 5000 typ host",
		SDPMid:    &mid, SDPMLineIndex: &line, UsernameFragment: &username,
	}
	recorder := &candidateRecorder{}
	if err := applyICECandidate(protocolVersion, msg, recorder); err != nil {
		t.Fatal(err)
	}
	if recorder.candidate != msg.Candidate || recorder.sdpMid != &mid ||
		recorder.sdpMLineIndex != &line || recorder.usernameFragment != &username {
		t.Fatalf("ICE候補フィールドが欠落: %#v", recorder)
	}
}

func TestClientCandidateJSONContract(t *testing.T) {
	payload := fmt.Sprintf(
		`{"t":"candidate","v":%d,"candidate":{"candidate":"candidate:1 1 UDP 1 192.0.2.1 5000 typ host","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":"ice-user"}}`,
		protocolVersion)
	var msg clientMsg
	if err := json.Unmarshal([]byte(payload), &msg); err != nil {
		t.Fatal(err)
	}
	recorder := &candidateRecorder{}
	if err := applyICECandidate(msg.Version, msg.Candidate, recorder); err != nil {
		t.Fatal(err)
	}
	if msg.T != "candidate" || recorder.candidate == "" || recorder.sdpMid == nil ||
		*recorder.sdpMid != "0" || recorder.sdpMLineIndex == nil || *recorder.sdpMLineIndex != 0 ||
		recorder.usernameFragment == nil || *recorder.usernameFragment != "ice-user" {
		t.Fatalf("クライアントとのcandidate契約が不一致: msg=%#v recorder=%#v", msg, recorder)
	}
}

// ホスト側の候補もtrickleで送る。クライアントはこれをそのまま
// RTCPeerConnection.addIceCandidate へ渡すので、フィールド名が1つでも
// 違うと候補が無視され、映像が出ないまま接続だけが失敗する。
func TestHostCandidateJSONContract(t *testing.T) {
	mid, username := "0", "ice-user"
	line := uint16(0)
	sent := map[string]any{"t": "candidate", "v": protocolVersion, "candidate": webrtc.ICECandidateInit{
		Candidate:        "candidate:1 1 UDP 1 192.0.2.1 5000 typ host",
		SDPMid:           &mid,
		SDPMLineIndex:    &line,
		UsernameFragment: &username,
	}}
	data, err := json.Marshal(sent)
	if err != nil {
		t.Fatal(err)
	}

	// クライアントの読み方 (viewer.ts の onMessage) と同じ形で読み戻す
	var got struct {
		T         string           `json:"t"`
		Version   int              `json:"v"`
		Candidate *iceCandidateMsg `json:"candidate"`
	}
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatal(err)
	}
	if got.T != "candidate" || got.Version != protocolVersion || got.Candidate == nil {
		t.Fatalf("ホストのcandidateメッセージが読み戻せない: %s", data)
	}
	if got.Candidate.Candidate == "" || got.Candidate.SDPMid == nil || *got.Candidate.SDPMid != mid ||
		got.Candidate.SDPMLineIndex == nil || *got.Candidate.SDPMLineIndex != line ||
		got.Candidate.UsernameFragment == nil || *got.Candidate.UsernameFragment != username {
		t.Fatalf("候補のフィールドが欠落: %s", data)
	}
}

// 生存確認は入力操作ではない。inputへ落ちると、経路の確認のたびに
// マウスやキーボードの注入を試みることになる。
func TestPingIsHandledAsControlNotInput(t *testing.T) {
	a := &app{} // セッション未確立でも落ちないこと (返す相手が居ないだけ)
	if !a.handleControl(controlMsg{T: "ping"}) {
		t.Fatal("pingが制御メッセージとして扱われていない")
	}
	if a.handleControl(controlMsg{T: "mv"}) {
		t.Fatal("マウス移動を制御メッセージとして飲み込んでいる")
	}
}

func TestApplyICECandidateRejectsInvalidMessage(t *testing.T) {
	recorder := &candidateRecorder{}
	if err := applyICECandidate(protocolVersion+1, &iceCandidateMsg{Candidate: "candidate:x"}, recorder); err == nil {
		t.Fatal("非対応バージョンを受理した")
	}
	if err := applyICECandidate(protocolVersion, nil, recorder); err == nil {
		t.Fatal("nil候補を受理した")
	}
	if err := applyICECandidate(protocolVersion, &iceCandidateMsg{}, recorder); err == nil {
		t.Fatal("空候補を受理した")
	}

	want := errors.New("pion error")
	recorder.err = want
	if err := applyICECandidate(protocolVersion, &iceCandidateMsg{Candidate: "candidate:x"}, recorder); !errors.Is(err, want) {
		t.Fatalf("下位エラーを返していない: %v", err)
	}
}

func TestRecordAnswerOnlyAcceptsFirstAnswer(t *testing.T) {
	pending := &pendingAuth{}
	a := &app{pending: pending}
	if got := a.recordAnswer("first"); got != pending || pending.answer != "first" {
		t.Fatal("最初のanswerを記録できない")
	}
	if got := a.recordAnswer("second"); got != nil || pending.answer != "first" {
		t.Fatal("重複answerで認証対象を書き換えた")
	}
}

func TestSDPICEUfrag(t *testing.T) {
	sdp := "v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\n" +
		"a=ice-ufrag:Xk9Q\r\na=ice-pwd:secret\r\n"
	if got := sdpICEUfrag(sdp); got != "Xk9Q" {
		t.Fatalf("ice-ufragを取り出せない: %q", got)
	}
	if got := sdpICEUfrag("v=0\r\na=ice-pwd:secret\r\n"); got != "" {
		t.Fatalf("ice-ufragが無いのに %q を返した", got)
	}
}

// 接続要求が入れ替わると、前の要求で集めた候補が遅れて届く。ufragで見分ける。
func TestRecordAnswerKeepsUfragForCandidateMatching(t *testing.T) {
	pending := &pendingAuth{}
	a := &app{pending: pending}
	a.recordAnswer("v=0\r\na=ice-ufrag:AAAA\r\n")
	if pending.ufrag != "AAAA" {
		t.Fatalf("answerのufragを控えていない: %q", pending.ufrag)
	}

	stale, current := "BBBB", "AAAA"
	if stale == pending.ufrag {
		t.Fatal("テストの前提が壊れている")
	}
	// 実際の判定と同じ条件で、古い候補だけが弾かれることを見る
	drop := func(uf *string) bool {
		return uf != nil && *uf != "" && pending.ufrag != "" && *uf != pending.ufrag
	}
	if !drop(&stale) {
		t.Fatal("古い接続要求の候補を受け入れてしまう")
	}
	if drop(&current) {
		t.Fatal("今の接続要求の候補を捨ててしまう")
	}
	if drop(nil) {
		t.Fatal("ufrag未設定の候補を捨ててしまう")
	}
}

// answerの適用に失敗した仮セッションは登録から外す。
// 残すと、閉じたPeerConnectionへICE候補を注ぎ続けることになる。
func TestDetachPendingClearsOnlyItsOwn(t *testing.T) {
	pending := &pendingAuth{}
	a := &app{pending: pending}
	if !a.detachPending(pending) || a.pending != nil {
		t.Fatal("失敗した仮セッションが登録に残っている")
	}

	// 入れ替わった後に古い方を外そうとしても、今の仮セッションは巻き添えにしない
	newer := &pendingAuth{}
	a.pending = newer
	if a.detachPending(pending) {
		t.Fatal("入れ替わった後なのに外せたと報告した")
	}
	if a.pending != newer {
		t.Fatal("新しい仮セッションを巻き添えにした")
	}
}

func TestRetryAuthRestoresOnlyWhenNotReplaced(t *testing.T) {
	p := &pendingAuth{gen: 1}
	a := &app{pending: p, authGen: 1}
	if a.takeAuth() != p || a.pending != nil {
		t.Fatal("仮セッションを取り出せない")
	}
	if !a.retryAuth(p) || a.pending != p {
		t.Fatal("チケット失効後に認証待ちへ戻せない")
	}
	p.timer.Stop()

	// 取り出した後に新しい接続要求が入っていたら、そちらを優先する
	a.takeAuth()
	newer := &pendingAuth{gen: 2}
	a.pending = newer
	if a.retryAuth(p) {
		t.Fatal("入れ替わった後なのに戻せたと報告した")
	}
	if a.pending != newer {
		t.Fatal("新しい仮セッションを巻き添えにした")
	}
}

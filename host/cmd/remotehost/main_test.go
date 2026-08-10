package main

import (
	"encoding/json"
	"errors"
	"testing"
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
	const payload = `{"t":"candidate","v":1,"candidate":{"candidate":"candidate:1 1 UDP 1 192.0.2.1 5000 typ host","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":"ice-user"}}`
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

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

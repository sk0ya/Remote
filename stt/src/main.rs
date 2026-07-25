//! 標準入出力で日本語音声認識を受け付ける常駐プロセス。
//!
//! ホスト(remotehost.exe)が子プロセスとして起動し、スマホから届いた音声を
//! ここで文字起こしする。モデルの読み込みは起動時の一度だけで、以降は
//! 1行1リクエストで応答する。認識はすべてローカルで完結する。
//!
//! プロトコル (すべてUTF-8のテキスト行):
//!   起動完了時   stdout: `+ready`
//!   リクエスト   stdin : 認識したいwavファイルのパス
//!   成功         stdout: `+<認識結果>`  (無音なら `+` だけ)
//!   失敗         stdout: `!<エラー内容>`
//!
//! wavは16kHzモノラルを想定する(呼び出し側でffmpeg等により変換しておく)。
//! ログはstderrへ出るので、呼び出し側で拾うと診断しやすい。
//!
//! 使い方: remote-stt [モデルディレクトリ]
//!   省略時は環境変数 REMOTE_STT_MODELS、それも無ければ
//!   カレントディレクトリの models/sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01

use sherpa_onnx::{
    OfflineRecognizer, OfflineRecognizerConfig, OfflineTransducerModelConfig, Wave,
};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

const DEFAULT_MODEL_DIR: &str = "models/sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01";

/// 使うモデルファイル (ReazonSpeech日本語モデル)。
/// encoderとjoinerはint8量子化版を使う。精度差はほぼ無く、読み込みが軽い。
const ENCODER: &str = "encoder-epoch-99-avg-1.int8.onnx";
const DECODER: &str = "decoder-epoch-99-avg-1.onnx";
const JOINER: &str = "joiner-epoch-99-avg-1.int8.onnx";
const TOKENS: &str = "tokens.txt";

fn main() -> ExitCode {
    let dir = model_dir();
    let recognizer = match load(&dir) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("{e}");
            return ExitCode::FAILURE;
        }
    };

    let stdout = io::stdout();
    let mut out = stdout.lock();
    if writeln!(out, "+ready").and_then(|_| out.flush()).is_err() {
        return ExitCode::FAILURE;
    }
    eprintln!("準備完了。wavファイルのパスを1行ずつ受け付けます。");

    for line in io::stdin().lock().lines() {
        let Ok(path) = line else { break };
        let path = path.trim();
        if path.is_empty() {
            continue;
        }
        let written = match transcribe(&recognizer, path) {
            Ok(text) => writeln!(out, "+{}", text.replace('\n', " ").trim()),
            Err(e) => {
                eprintln!("認識失敗 ({path}): {e}");
                writeln!(out, "!{}", e.replace('\n', " "))
            }
        };
        if written.and_then(|_| out.flush()).is_err() {
            break; // 呼び出し側が終了した
        }
    }
    ExitCode::SUCCESS
}

fn model_dir() -> PathBuf {
    if let Some(arg) = std::env::args().nth(1) {
        return PathBuf::from(arg);
    }
    if let Ok(env) = std::env::var("REMOTE_STT_MODELS") {
        if !env.is_empty() {
            return PathBuf::from(env);
        }
    }
    PathBuf::from(DEFAULT_MODEL_DIR)
}

fn load(dir: &Path) -> Result<OfflineRecognizer, String> {
    let file = |name: &str| -> Result<String, String> {
        let p = dir.join(name);
        if !p.is_file() {
            return Err(format!(
                "モデルファイルがありません: {}\n\
                 scripts/setup-models.ps1 でモデルを取得してください。",
                p.display()
            ));
        }
        p.to_str()
            .map(str::to_string)
            .ok_or_else(|| format!("パスにUTF-8以外の文字が含まれています: {}", p.display()))
    };

    let mut config = OfflineRecognizerConfig::default();
    config.model_config.transducer = OfflineTransducerModelConfig {
        encoder: Some(file(ENCODER)?),
        decoder: Some(file(DECODER)?),
        joiner: Some(file(JOINER)?),
    };
    config.model_config.tokens = Some(file(TOKENS)?);
    config.model_config.num_threads = 2;

    eprintln!("音声認識モデルを読み込み中: {}", dir.display());
    OfflineRecognizer::create(&config)
        .ok_or_else(|| format!("音声認識モデルの読み込みに失敗しました: {}", dir.display()))
}

fn transcribe(recognizer: &OfflineRecognizer, path: &str) -> Result<String, String> {
    let wave = Wave::read(path).ok_or_else(|| format!("wavファイルを読めません: {path}"))?;
    let start = std::time::Instant::now();

    let stream = recognizer.create_stream();
    stream.accept_waveform(wave.sample_rate(), wave.samples());
    recognizer.decode(&stream);
    let text = stream
        .get_result()
        .ok_or_else(|| "認識結果を取得できませんでした".to_string())?
        .text;

    let secs = wave.samples().len() as f32 / wave.sample_rate() as f32;
    eprintln!(
        "認識 {secs:.1}s の音声 → {:.2}s / {text:?}",
        start.elapsed().as_secs_f32()
    );
    Ok(text)
}

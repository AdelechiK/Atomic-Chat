//! The one privileged step of a TensorRT-LLM setup on Linux: installing Docker Engine and the
//! NVIDIA Container Toolkit (openspec change `add-tensorrt-llm-linux`, design D3).
//!
//! The core never runs anything as root. It hands out a `pending_host_step` on the operation and
//! reads a receipt back; the privileged work is done by its own recipe executor, the
//! `host-step exec <request-file>` subcommand of the core binary, run as a separate process under
//! `pkexec`. That process talks to nobody: it reads the request file and writes a result file next
//! to it.
//!
//! Here the app does its half:
//!
//! - it reads the step from the core itself, by operation id: the webview names the operation and
//!   never hands over a path, a command or a parameter;
//! - it copies the core binary into a fresh `0700` folder under `$XDG_RUNTIME_DIR` and runs
//!   `pkexec` on the copy. The AppImage is a FUSE mount without `allow_other`, which root cannot
//!   read, so `pkexec` on the binary inside the bundle would fail;
//! - it writes the request file (`0600`, never trusting the umask), waits for the executor, reads
//!   the result file and sends the receipt;
//! - with no `pkexec` or no polkit agent, it hands the person the exact `sudo` command and keeps
//!   waiting for the result file instead.
//!
//! The copy and its folder are removed once the executor has exited.

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde_json::{json, Value};

/// The copy's file name inside its folder.
const CORE_COPY_NAME: &str = "atomic-chat-core";

/// What `pkexec` prints when there is no polkit agent to ask the password with (minimal window
/// managers, a bare session): it exits 127 right away, as it does for a refusal.
const NO_AGENT_MARKER: &str = "No authentication agent";

/// How often the result file is looked for while the person runs the `sudo` command.
pub const MANUAL_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// Steps whose executor is running now, in this app. A second run of the same step would race the
/// first over the package manager, and its receipt would be refused.
static IN_FLIGHT: std::sync::Mutex<Vec<String>> = std::sync::Mutex::new(Vec::new());

/// Holds a step for one run; released when dropped, however the run ends.
#[derive(Debug)]
pub struct StepClaim(String);

impl Drop for StepClaim {
    fn drop(&mut self) {
        if let Ok(mut steps) = IN_FLIGHT.lock() {
            steps.retain(|step| step != &self.0);
        }
    }
}

/// Claim `step_id` for one run, or `None` while another run of it is still going.
pub fn claim(step_id: &str) -> Option<StepClaim> {
    let mut steps = IN_FLIGHT.lock().ok()?;
    if steps.iter().any(|step| step == step_id) {
        return None;
    }
    steps.push(step_id.to_string());
    Some(StepClaim(step_id.to_string()))
}

/// The step as the core hands it out on `pending_host_step`, plus the operation it belongs to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostStep {
    pub operation_id: String,
    pub step_id: String,
    pub action: String,
    pub recipe_id: String,
    pub recipe_digest: String,
    pub parameters_digest: String,
    pub nonce: String,
    pub expected_operation_revision: u64,
    pub parameters: Value,
}

impl HostStep {
    /// Read from an operation the core returned. `None` when it has no step pending.
    pub fn from_operation(operation: &Value) -> Option<Self> {
        let step = operation.get("pending_host_step")?;
        let text = |key: &str| step.get(key).and_then(Value::as_str).map(str::to_string);
        Some(Self {
            operation_id: operation.get("operation_id")?.as_str()?.to_string(),
            step_id: text("step_id")?,
            action: text("action")?,
            recipe_id: text("recipe_id")?,
            recipe_digest: text("recipe_digest")?,
            parameters_digest: text("parameters_digest")?,
            nonce: text("nonce")?,
            expected_operation_revision: step.get("expected_operation_revision")?.as_u64()?,
            parameters: step.get("parameters")?.clone(),
        })
    }

    /// The request file, in the shape the core's `parseHostStepRequest` accepts.
    fn request(&self, data_folder: &Path, requested_at_ms: u128) -> Value {
        json!({
            "schema_version": 1,
            "step_id": self.step_id,
            "operation_id": self.operation_id,
            "action": self.action,
            "recipe_id": self.recipe_id,
            "recipe_digest": self.recipe_digest,
            "parameters_digest": self.parameters_digest,
            "nonce": self.nonce,
            "expected_operation_revision": self.expected_operation_revision,
            "data_folder": data_folder.to_string_lossy(),
            "requested_at": requested_at_ms as u64,
            "parameters": self.parameters,
        })
    }

    /// The receipt the core's `host-step-result` route takes. An assertion, not proof: the core
    /// probes the machine again before it believes a `completed`.
    pub fn receipt(&self, outcome: ReceiptOutcome, receipt_id: &str) -> Value {
        json!({
            "step_id": self.step_id,
            "nonce": self.nonce,
            "expected_operation_revision": self.expected_operation_revision,
            "recipe_digest": self.recipe_digest,
            "parameters_digest": self.parameters_digest,
            "outcome": outcome.as_str(),
            "receipt_id": receipt_id,
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReceiptOutcome {
    Completed,
    Declined,
    Failed,
}

impl ReceiptOutcome {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Declined => "declined",
            Self::Failed => "failed",
        }
    }
}

/// How one attempt at the privileged step ended.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Elevation {
    /// The executor ran and wrote its result file (or, exiting without one, failed).
    Finished { outcome: ReceiptOutcome, log_tail: String },
    /// The person closed the authorization prompt or could not authenticate. Nothing changed on
    /// the machine; the setup can be resumed.
    Declined,
    /// No `pkexec` or no polkit agent: the person runs this command in a terminal, and the result
    /// file it writes is picked up by [`wait_for_result`].
    Manual { command: String },
}

/// A request laid out on disk: the folder, the copy of the core, the request and result files.
#[derive(Debug)]
pub struct PreparedStep {
    pub dir: PathBuf,
    pub binary: PathBuf,
    pub request: PathBuf,
    pub result: PathBuf,
}

impl PreparedStep {
    /// What a person runs by hand when no automatic elevation is available.
    pub fn manual_command(&self) -> String {
        format!(
            "sudo {} host-step exec {}",
            shell_quote(&self.binary),
            shell_quote(&self.request)
        )
    }

    /// Remove the copy, the request and the result. Never fails loudly: a leftover folder in the
    /// runtime directory is cleared at logout.
    pub fn remove(&self) {
        if let Err(error) = std::fs::remove_dir_all(&self.dir) {
            log::warn!("[host-step] could not remove {}: {error}", self.dir.display());
        }
    }
}

fn shell_quote(path: &Path) -> String {
    let text = path.to_string_lossy();
    if text.chars().all(|c| c.is_ascii_alphanumeric() || "/._-".contains(c)) {
        text.into_owned()
    } else {
        format!("'{}'", text.replace('\'', r"'\''"))
    }
}

/// Lay the step out in a fresh folder under `runtime_dir`: `0700` folder, `0700` copy of the core,
/// `0600` request. The folder must not exist yet — a name another process chose is never reused.
#[cfg(unix)]
pub fn prepare(
    runtime_dir: &Path,
    core_binary: &Path,
    step: &HostStep,
    data_folder: &Path,
) -> std::io::Result<PreparedStep> {
    use std::io::Write;
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};

    let dir = runtime_dir.join(format!("atomic-chat-host-step-{}", uuid::Uuid::new_v4().simple()));
    std::fs::DirBuilder::new().mode(0o700).create(&dir)?;
    // The umask may have taken bits away from the mode; set it exactly.
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;

    let prepared = PreparedStep {
        binary: dir.join(CORE_COPY_NAME),
        request: dir.join(format!("{}.request.json", step.step_id)),
        result: dir.join(format!("{}.result.json", step.step_id)),
        dir,
    };
    let laid_out = (|| {
        std::fs::copy(core_binary, &prepared.binary)?;
        std::fs::set_permissions(&prepared.binary, std::fs::Permissions::from_mode(0o700))?;
        let requested_at = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis())
            .unwrap_or_default();
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&prepared.request)?;
        file.write_all(step.request(data_folder, requested_at).to_string().as_bytes())?;
        file.sync_all()?;
        std::fs::set_permissions(&prepared.request, std::fs::Permissions::from_mode(0o600))
    })();
    if let Err(error) = laid_out {
        prepared.remove();
        return Err(error);
    }
    Ok(prepared)
}

/// Run the executor on the copy under `pkexec` and wait for it.
pub async fn elevate(pkexec: &Path, prepared: &PreparedStep) -> Elevation {
    let output = tokio::process::Command::new(pkexec)
        .arg(&prepared.binary)
        .arg("host-step")
        .arg("exec")
        .arg(&prepared.request)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .output()
        .await;
    let output = match output {
        Ok(output) => output,
        // No `pkexec` on this machine at all.
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Elevation::Manual { command: prepared.manual_command() }
        }
        Err(error) => {
            return Elevation::Finished {
                outcome: ReceiptOutcome::Failed,
                log_tail: format!("could not start pkexec: {error}"),
            }
        }
    };
    let stderr = String::from_utf8_lossy(&output.stderr);
    match output.status.code() {
        // The authorization dialog was dismissed.
        Some(126) => Elevation::Declined,
        Some(127) if stderr.contains(NO_AGENT_MARKER) => {
            Elevation::Manual { command: prepared.manual_command() }
        }
        // Not authorized, or the password was never right.
        Some(127) => Elevation::Declined,
        code => finished(prepared, code, &stderr),
    }
}

/// The executor exited: its result file is the answer, and no result file is a failure.
fn finished(prepared: &PreparedStep, code: Option<i32>, stderr: &str) -> Elevation {
    match read_result(&prepared.result) {
        Some((outcome, log_tail)) => Elevation::Finished { outcome, log_tail },
        None => Elevation::Finished {
            outcome: ReceiptOutcome::Failed,
            log_tail: format!(
                "the privileged step exited with {} and wrote no result: {}",
                code.map(|c| c.to_string()).unwrap_or_else(|| "a signal".into()),
                tail(stderr)
            ),
        },
    }
}

/// `completed` or `failed` from the executor's result file; `None` while there is none.
pub fn read_result(path: &Path) -> Option<(ReceiptOutcome, String)> {
    let text = std::fs::read_to_string(path).ok()?;
    let result: Value = serde_json::from_str(&text).ok()?;
    let log_tail = result
        .get("log_tail")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let outcome = match result.get("outcome").and_then(Value::as_str) {
        Some("completed") => ReceiptOutcome::Completed,
        _ => ReceiptOutcome::Failed,
    };
    Some((outcome, log_tail))
}

/// Wait for the result file the person's `sudo` run writes, up to `limit`.
pub async fn wait_for_result(
    prepared: &PreparedStep,
    interval: Duration,
    limit: Duration,
) -> Option<(ReceiptOutcome, String)> {
    let deadline = tokio::time::Instant::now() + limit;
    loop {
        if let Some(result) = read_result(&prepared.result) {
            return Some(result);
        }
        if tokio::time::Instant::now() >= deadline {
            return None;
        }
        tokio::time::sleep(interval).await;
    }
}

fn tail(text: &str) -> String {
    let text = text.trim();
    let start = text.len().saturating_sub(2000);
    let mut start = start;
    while !text.is_char_boundary(start) {
        start += 1;
    }
    text[start..].to_string()
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::os::unix::fs::PermissionsExt;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    fn script(dir: &Path, name: &str, body: &str) -> PathBuf {
        let path = dir.join(name);
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    /// A stand-in for the core binary: `host-step exec <request>` writes `result` beside the request
    /// and exits with `code`, as the real executor does (0 completed, 1 failed, 2 no result file).
    fn fake_core(dir: &Path, result: Option<&str>, code: i32) -> PathBuf {
        let write = result
            .map(|r| format!("printf '%s' '{r}' > \"${{3%.request.json}}.result.json\""))
            .unwrap_or_default();
        script(dir, "core-src", &format!("{write}\nexit {code}"))
    }

    /// `pkexec` that authorizes everything and runs the program as given.
    fn passthrough_pkexec(dir: &Path) -> PathBuf {
        script(dir, "pkexec", "exec \"$@\"")
    }

    fn step() -> HostStep {
        HostStep::from_operation(&json!({
            "operation_id": "op-1",
            "revision": 4,
            "pending_host_step": {
                "step_id": "step-1",
                "action": "linux.install-container-runtime",
                "recipe_id": "linux.install-container-runtime",
                "recipe_digest": "sha256:aa",
                "parameters_digest": "sha256:bb",
                "parameters": { "user": "ann", "arch": "x86_64", "family": "apt",
                    "distro_id": "ubuntu", "version_id": "24.04", "components": ["docker-engine"] },
                "nonce": "n-1",
                "expected_operation_revision": 4
            }
        }))
        .expect("a pending step")
    }

    fn laid_out(core: &Path) -> (tempfile::TempDir, PreparedStep) {
        let runtime = tempfile::tempdir().unwrap();
        let prepared = prepare(runtime.path(), core, &step(), Path::new("/data")).unwrap();
        (runtime, prepared)
    }

    fn mode(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn reads_the_step_the_core_hands_out_and_nothing_else() {
        assert_eq!(step().nonce, "n-1");
        assert_eq!(step().expected_operation_revision, 4);
        assert_eq!(HostStep::from_operation(&json!({ "operation_id": "op-1", "pending_host_step": null })), None);
    }

    #[test]
    fn lays_out_a_private_copy_of_the_core_and_a_private_request() {
        let bin = tempfile::tempdir().unwrap();
        let core = fake_core(bin.path(), None, 0);
        let (runtime, prepared) = laid_out(&core);

        assert!(prepared.dir.starts_with(runtime.path()));
        assert_eq!(mode(&prepared.dir), 0o700);
        assert_eq!(mode(&prepared.binary), 0o700);
        assert_eq!(mode(&prepared.request), 0o600);
        assert_eq!(std::fs::read(&prepared.binary).unwrap(), std::fs::read(&core).unwrap());
        assert_eq!(prepared.request.file_name().unwrap(), "step-1.request.json");
        assert_eq!(prepared.result.file_name().unwrap(), "step-1.result.json");

        let request: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&prepared.request).unwrap()).unwrap();
        assert_eq!(request["schema_version"], 1);
        assert_eq!(request["operation_id"], "op-1");
        assert_eq!(request["recipe_digest"], "sha256:aa");
        assert_eq!(request["parameters_digest"], "sha256:bb");
        assert_eq!(request["nonce"], "n-1");
        assert_eq!(request["data_folder"], "/data");
        assert_eq!(request["parameters"]["user"], "ann");

        prepared.remove();
        assert!(!prepared.dir.exists());
    }

    #[test]
    fn two_steps_never_share_a_folder() {
        let bin = tempfile::tempdir().unwrap();
        let core = fake_core(bin.path(), None, 0);
        let runtime = tempfile::tempdir().unwrap();
        let first = prepare(runtime.path(), &core, &step(), Path::new("/data")).unwrap();
        let second = prepare(runtime.path(), &core, &step(), Path::new("/data")).unwrap();
        assert_ne!(first.dir, second.dir);
    }

    #[tokio::test]
    async fn a_completed_step_is_read_from_the_result_file() {
        let bin = tempfile::tempdir().unwrap();
        let core = fake_core(bin.path(), Some(r#"{"outcome":"completed","log_tail":"installed"}"#), 0);
        let (_runtime, prepared) = laid_out(&core);

        let outcome = elevate(&passthrough_pkexec(bin.path()), &prepared).await;

        assert_eq!(
            outcome,
            Elevation::Finished { outcome: ReceiptOutcome::Completed, log_tail: "installed".into() }
        );
    }

    #[tokio::test]
    async fn a_step_the_executor_refused_is_a_failure_with_its_log() {
        let bin = tempfile::tempdir().unwrap();
        let core = fake_core(bin.path(), Some(r#"{"outcome":"failed","log_tail":"apt: no network"}"#), 1);
        let (_runtime, prepared) = laid_out(&core);

        let outcome = elevate(&passthrough_pkexec(bin.path()), &prepared).await;

        assert_eq!(
            outcome,
            Elevation::Finished { outcome: ReceiptOutcome::Failed, log_tail: "apt: no network".into() }
        );
    }

    #[tokio::test]
    async fn no_result_file_is_a_failure() {
        // Exit 2: the executor did not trust the folder, or could not write its result.
        let bin = tempfile::tempdir().unwrap();
        let core = script(bin.path(), "core-src", "echo 'untrusted folder' >&2\nexit 2");
        let (_runtime, prepared) = laid_out(&core);

        match elevate(&passthrough_pkexec(bin.path()), &prepared).await {
            Elevation::Finished { outcome, log_tail } => {
                assert_eq!(outcome, ReceiptOutcome::Failed);
                assert!(log_tail.contains("untrusted folder"), "{log_tail}");
            }
            other => panic!("expected a failure, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn a_dismissed_prompt_is_a_decline() {
        let bin = tempfile::tempdir().unwrap();
        let (_runtime, prepared) = laid_out(&fake_core(bin.path(), None, 0));
        let pkexec = script(bin.path(), "pkexec", "exit 126");

        assert_eq!(elevate(&pkexec, &prepared).await, Elevation::Declined);
    }

    #[tokio::test]
    async fn not_being_authorized_is_a_decline() {
        let bin = tempfile::tempdir().unwrap();
        let (_runtime, prepared) = laid_out(&fake_core(bin.path(), None, 0));
        let pkexec = script(bin.path(), "pkexec", "echo 'Not authorized.' >&2\nexit 127");

        assert_eq!(elevate(&pkexec, &prepared).await, Elevation::Declined);
    }

    #[tokio::test]
    async fn without_a_polkit_agent_the_person_gets_the_exact_sudo_command() {
        let bin = tempfile::tempdir().unwrap();
        let (_runtime, prepared) = laid_out(&fake_core(bin.path(), None, 0));
        let pkexec = script(
            bin.path(),
            "pkexec",
            "echo 'Error executing command as another user: No authentication agent found.' >&2\nexit 127",
        );

        let expected = format!(
            "sudo {} host-step exec {}",
            prepared.binary.display(),
            prepared.request.display()
        );
        assert_eq!(elevate(&pkexec, &prepared).await, Elevation::Manual { command: expected });
        // The copy stays: the person is about to run it.
        assert!(prepared.binary.exists());
    }

    #[tokio::test]
    async fn without_pkexec_the_person_gets_the_exact_sudo_command() {
        let bin = tempfile::tempdir().unwrap();
        let (_runtime, prepared) = laid_out(&fake_core(bin.path(), None, 0));

        let outcome = elevate(&bin.path().join("no-such-pkexec"), &prepared).await;

        assert!(matches!(outcome, Elevation::Manual { ref command } if command.starts_with("sudo ")));
    }

    #[tokio::test]
    async fn the_result_of_a_manual_run_is_picked_up_when_it_appears() {
        let bin = tempfile::tempdir().unwrap();
        let (_runtime, prepared) = laid_out(&fake_core(bin.path(), None, 0));
        let result = prepared.result.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            std::fs::write(result, r#"{"outcome":"completed","log_tail":""}"#).unwrap();
        });

        let picked = wait_for_result(&prepared, Duration::from_millis(10), Duration::from_secs(5)).await;

        assert_eq!(picked.map(|(outcome, _)| outcome), Some(ReceiptOutcome::Completed));
    }

    #[tokio::test]
    async fn a_manual_run_that_never_happens_times_out() {
        let bin = tempfile::tempdir().unwrap();
        let (_runtime, prepared) = laid_out(&fake_core(bin.path(), None, 0));

        let picked = wait_for_result(&prepared, Duration::from_millis(5), Duration::from_millis(30)).await;

        assert_eq!(picked, None);
    }

    #[test]
    fn a_step_is_elevated_once_at_a_time() {
        let first = claim("step-claim").expect("free");
        assert!(claim("step-claim").is_none(), "a second executor would race the first");
        assert!(claim("step-other").is_some());
        drop(first);
        assert!(claim("step-claim").is_some(), "free again once the first run ended");
    }

    #[test]
    fn the_receipt_names_exactly_the_step_it_answers() {
        let receipt = step().receipt(ReceiptOutcome::Declined, "r-1");

        assert_eq!(
            receipt,
            json!({
                "step_id": "step-1",
                "nonce": "n-1",
                "expected_operation_revision": 4,
                "recipe_digest": "sha256:aa",
                "parameters_digest": "sha256:bb",
                "outcome": "declined",
                "receipt_id": "r-1",
            })
        );
    }
}

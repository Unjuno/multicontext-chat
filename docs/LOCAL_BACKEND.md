# Registration-free local backend

The Node runtime can connect directly to a loopback OpenAI-compatible model server,
without LibreChat, MongoDB, an account, API key, or saved LibreChat Agent.
This is the required product path; LibreChat compatibility is optional.
Existing LibreChat configuration remains unchanged by default.

```sh
MULTICONTEXT_BACKEND=local MULTICONTEXT_LOCAL_MODEL_URL=http://127.0.0.1:8080 MULTICONTEXT_DATA_FILE=./data/local-state.json npm start
```

Start a tool-capable local model server first. Model discovery uses `/v1/models`;
inference uses `/v1/chat/completions`. See the
[llama.cpp server documentation](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md).
Choose the discovered model in the existing Agent selector. Personas belong to
MultiContext members; no server-side Agent needs to be created.

The adapter allows literal loopback IP HTTP URLs only, refuses redirects, and
sends no Authorization header. This does not relax MultiContext's inbound REST,
MCP, or tool authentication requirements for non-loopback listeners. Queries from
`search_sources` still leave the machine; disabling search remains supported.

Transcripts are saved beside the configured state file in
`STATE_FILE.local-conversations/`, with per-conversation UUID filenames and
atomic replacement. Tool outputs must match pending call IDs exactly. Instructions
are rebound per request, and the same canonical Scheduler executes external tools.
Do not delete transcript files for active conversations. These files currently
are included with state by the local backup operation described below. If copying
manually, include both the state file and its adjacent conversation directory.

## Evidence and remaining product work

Direct GPT-OSS real run `research-flywheel-1788816693082` passed source search,
canonical cross-chat delivery, and exact DOI lookup without LibreChat login or
API-key use. State and transcripts are under ignored `data/experiments/`.
This is runtime evidence, not mathematical proof or research-quality validation.
The adapter tests cover persistence across instances, current persona rebinding,
unmatched outputs, model mismatch, remote endpoints, and invalid conversation IDs.
Full check: 311 total / 308 pass / 0 fail / 3 skip before the experiment selector
change; that selector was subsequently exercised in the successful real run.

At the initial adapter checkpoint, pending work included desktop first-run/backend settings and managed launch integration,
backup/delete lifecycle integration, crash-window/retry tests, long-context policy,
and built-in computation tools. Later checkpoints below supersede that initial
implementation status; they do not collectively certify all native onboarding interactions.
Old LibreChat workspaces must not
be blindly opened against the local backend: their conversation IDs are incompatible.

Desktop integration checkpoint: new configurations now default to local while
existing saved configurations without a backend remain LibreChat. The settings
page exposes backend choice; startup skips LibreChat for local and launches the
Node server with the model URL. Desktop local state is `local-state.json`, separate
from legacy `state.json`. Reuse of a server reporting another backend is refused.
Rust suite: 48 passed. Packaged GUI verification remains pending.

The local backup button now requests authenticated `POST /api/backup` from the
running Node server. With no active Scheduler requests, the server synchronously
saves state and copies state plus conversation files into a private staging folder.
It finalizes the directory only after writing a manifest. Busy execution returns
409; malformed entries or non-regular files fail without finalizing. Incomplete
copies remain named `.partial`, never reported as completed snapshots.

Restore with the server stopped: copy backup `state.json` to the configured state
file and `conversations/` to `STATE_FILE.local-conversations/`. The manifest records
this mapping. This backs up conversation data, not model binaries, OS Keychain,
desktop settings, or proof of mathematical correctness. Restore UI and packaged
GUI click verification remain pending. Only one server may own a state directory;
the synchronous snapshot does not coordinate independent processes writing it.

Verification checkpoint: a backup/restore regression now copies the snapshot into
a separate state/transcript directory, creates a fresh LocalModelClient, and
continues a pending tool call. Assistant call ID and real fixture output remain
paired; the original transcript is unchanged. This uses a deterministic model
transport, not a real-model restore test.

The packaged `.app` was rebuilt and `verify:desktop` passed. Native accessibility
inspection confirmed the built app reaches the main workspace screen with the
existing saved LibreChat configuration (32 workspaces retained). No existing
workspace was edited. This verifies legacy startup only; it does not certify fresh
local onboarding, backup-button clicking, or a restored real-model GUI session.

Real-model restore checkpoint: `node scripts/smoke-local-restore.mjs` completed
successfully in `data/experiments/local-restore-1788817556409/`. Direct GPT-OSS
issued one `search_sources` call; the pending conversation was snapshotted and
restored to another directory. The restored instance executed the actual search,
continued with its real output, and finished without another tool call, citing a
returned DOI. Original transcript bytes were unchanged. `evidence.json` retains
both model turns, tool output, and backup location. This exercises actual model
and search behavior, but not full Scheduler crash recovery or GUI restoration.

Retry isolation correction: responses now write immutable snapshots under new
UUIDs instead of replacing the transcript referenced by the previous response.
If a model response is saved but Scheduler never commits its new pointer, retrying
the old pointer sees the original input, not an extra prompt or unfinished tool
round. Workspace branches can share a prior pointer without mutating each other.
Regression tests simulate a discarded response and verify identical retry input
and independent branch input. This is not a process-kill test of the whole queue.

The real pending-search restore probe was repeated successfully after this change
in `local-restore-1788817646053`. Immutable snapshots currently retain unreferenced
records as well as active ones, and backups include them. Safe garbage collection
and bounded storage policy remain work; do not delete records by age alone.

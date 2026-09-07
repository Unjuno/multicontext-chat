# Registration-free local backend

The Node runtime can connect directly to a loopback OpenAI-compatible model server,
without LibreChat, MongoDB, an account, API key, or saved LibreChat Agent.
Existing LibreChat configuration remains unchanged by default.

```sh
MULTICONTEXT_BACKEND=local MULTICONTEXT_LOCAL_MODEL_URL=http://127.0.0.1:8080 npm start
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
need to be included separately in backups.

## Evidence and remaining product work

Direct GPT-OSS real run `research-flywheel-1788816693082` passed source search,
canonical cross-chat delivery, and exact DOI lookup without LibreChat login or
API-key use. State and transcripts are under ignored `data/experiments/`.
This is runtime evidence, not mathematical proof or research-quality validation.
The adapter tests cover persistence across instances, current persona rebinding,
unmatched outputs, model mismatch, remote endpoints, and invalid conversation IDs.
Full check: 311 total / 308 pass / 0 fail / 3 skip before the experiment selector
change; that selector was subsequently exercised in the successful real run.

Still pending: desktop first-run/backend settings and managed launch integration,
backup/delete lifecycle integration, crash-window/retry tests, long-context policy,
and built-in computation tools. This is a working server path, not yet a completed
registration-free desktop onboarding experience. Old LibreChat workspaces must not
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

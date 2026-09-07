# Portability boundary

The orchestration contract is platform-neutral: workspace state, FIFO queues,
Agent selection, retry/stop semantics, Compile snapshots, and REST/MCP
operations are implemented in the Node application layer.

The Tauri layer owns platform-specific concerns:

| Concern | Current macOS implementation | Windows/CUDA follow-up |
| --- | --- | --- |
| Secret storage | macOS Keychain via `security` | Replace with a Windows credential-store adapter; keep the command API unchanged |
| File/folder picker | AppleScript `osascript` | Use a Tauri dialog/provider adapter |
| Open logs/data folder | `open` command | Use the platform shell opener |
| Managed process groups | Unix process groups and signals | Implement Job Objects and Windows termination semantics |
| Model launch | llama.cpp arguments in `launch.rs` | Add CUDA backend/device flags in a platform/profile layer, not in orchestration |
| Node discovery | Finder-safe macOS paths and `which` | Add Windows executable discovery and `.exe` handling |

The current macOS release does not claim Windows support. A port is safe only
when these adapters are substituted without changing the application operation
layer or exposing secrets to logs, REST, or MCP.

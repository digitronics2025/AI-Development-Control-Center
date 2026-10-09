# FLEET.md — AI Development Control Center

Last verified: 2026-10-09 (source and local runtime tests; see release ledger).
The orchestrator on a paired machine owns task state and code execution. The
Cloudflare cloud-control Worker relays typed commands and mirrors evidence. It
is manually released through staging then production; pushing main never deploys.

## Fleet operations contract

[docs/systems/fleet-operations.md](docs/systems/fleet-operations.md) owns the
registry, indexed due checks, incident/proof rules, caps and release boundaries.
Messenger → Control Center: service binding `OPS_CONTROL`, immutable owner bot
alerts with `OPS_BRIDGE_TOKEN`; read-only summary with `OPS_READER_TOKEN`.
Control Center → Messenger: fixed native health with `OPS_HEALTH_TOKEN`, bounded
recovery with separate `OPS_RECOVERY_TOKEN`, source provisioning with
`OPS_REGISTRATION_TOKEN`, owner-only notifications with individual
`OPS_NOTIFICATION_TOKEN` for `fleet_operations`. No legacy credentials rotate.
Future app producers post per-app events and real job receipts after owner
registration; no app can impersonate another or choose an arbitrary recovery URL.

Routine investigation tasks use the existing typed full-autopilot workflow,
repository leases, isolated worktrees and current node checks. A disconnected PC
is not an execution host. Existing release and credential gates remain in force.
Dot's Messenger reader is read-only; task conversations belong to this app,
not newly created native Dot chats.

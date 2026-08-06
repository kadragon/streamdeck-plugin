# Architecture

## Stack

| Layer | Technology |
|-------|------------|
| Language | TypeScript (`package.json` declares `^5.2.2`) |
| Runtime | Node.js 24 in the Stream Deck manifest |
| SDK | `@elgato/streamdeck` |
| Build | Rollup with TypeScript, Node resolution, CommonJS, and Terser |
| Packaging | Stream Deck `.sdPlugin` manifest and generated `bin/plugin.js` |
| CI | GitHub Actions (`.github/workflows/quality.yml`) |

## Source Layout

```text
src/plugin.ts                  # SDK registration and wake-up refresh
src/actions/weekly-limit.ts    # Settings, lifecycle, ticker, source selection
src/actions/usage-overview.ts  # Combined Claude/Codex usage modes and encoder feedback
src/actions/system-metrics.ts  # Windows-only lifecycle, fifteen-second ticker, wake refresh
src/actions/warp-tab-config.ts # Dynamic Tab Config selection and URI launch
src/actions/warp-uri.ts        # Validated Warp and Warp Preview URI launcher
src/render.ts                  # Pure SVG key-face rendering and time formatting
src/metrics/windows.ts         # Local PowerShell/Get-Counter and nvidia-smi reader
src/metrics/types.ts           # Supported local system metric names
src/warp/                       # Local Warp Tab Config discovery and URI normalization
src/warp/uris.ts                # Validated custom-URI opening across platforms
src/usage/types.ts             # Reading/sample contracts and no-data error
src/usage/burn-rate.ts         # Reset-aware burn-rate projection
src/usage/overview.ts          # Combined usage display-mode calculations
src/usage/claude.ts            # Claude snapshot/history file reader
src/usage/codex.ts             # Codex rollout file reader and cache
scripts/statusline-usage-snapshot.sh
                               # Claude status-line stdin -> local snapshot/history
com.kadragon.aiusage.sdPlugin/
  manifest.json                # Stream Deck package contract
  ui/weekly-limit.html         # Property Inspector settings
  ui/system-monitor.html       # Local system metric selector
  ui/warp-tab-config.html      # Warp Tab Config selector
  ui/usage-overview.html       # Combined usage settings
  ui/warp-uri.html             # Warp URI setting
  imgs/                        # Checked-in package artwork
  bin/                         # Generated build output; do not edit
```

## Layer Rules

### Dependency Direction

```text
plugin -> actions -> render
                  -> usage -> types
                  -> metrics
```

`src/usage/` must not depend on SDK/UI modules. `src/render.ts` is pure and must not read files or call SDK APIs. `src/plugin.ts` owns SDK connection and lifecycle wiring.

### Boundaries

- `WeeklyLimit` is the only action-level coordinator for settings, refresh cadence, and key updates.
- `UsageOverview` coordinates both local usage readers and keeps mode changes in action settings.
- `SystemMonitor` is the Windows-only action-level coordinator for metric refresh and key/encoder updates.
- `WarpTabConfig` reads local Tab Config metadata for its Property Inspector and opens only validated
  `warp://tab_config/` or `warppreview://tab_config/` URIs on key press.
- `WarpUriLauncher` opens only validated `warp://` or `warppreview://` values supplied by the user.
- Usage readers return `UsageReading`; invalid or missing local data becomes `NoUsageDataError`.
- `renderKey` accepts a `KeyFace` and returns an SVG data URI; user-controlled caption text is escaped.
- The Property Inspector sends settings through Stream Deck events; the ticker uses the latest event payload rather than polling IPC.
- `SystemMonitor` refreshes visible keys and encoders every fifteen seconds, shares one local metrics sample
  across all visible instances, and exposes a forced `refreshAll` hook for wake-up refreshes.
- The System Monitor Property Inspector supplies the selected metric and GPU index through settings events; the ticker uses the latest event payload.
- `readWindowsMetrics` rejects non-Windows hosts and keeps missing or invalid metric fields undefined.
- System Monitor action metadata is Windows-only even though the package also supports macOS for other actions.

## Data Access

The plugin makes no API calls. Claude data comes from `~/.claude/ai-usage/claude.json` and `claude-history.jsonl`; Codex data comes from `~/.codex/sessions/**/rollout-*.jsonl`. The shell wrapper creates the Claude files from status-line stdin and forwards the original payload to the configured status-line program.

Warp Tab Config discovery also stays local. The action scans Warp's platform-specific `tab_configs`
directory for `.toml` files, uses the filename stem as the launch identity, and reads only the optional
top-level `name` for the Property Inspector label. It does not parse or execute config commands itself.

The System Monitor data path is Windows-only. CPU utilization, RAM, disk usage, and network throughput
come from local CIM classes (`Win32_PerfFormattedData_*`, `Win32_OperatingSystem`, `Win32_LogicalDisk`),
chosen over `Get-Counter` paths because counter names are localized. CPU temperature is read as a chain:
the real package sensor from the `root/LibreHardwareMonitor` (then `root/OpenHardwareMonitor`) `Sensor`
class when either provider is running, otherwise the ACPI chassis zone from `MSAcpi_ThermalZoneTemperature`
with a `Get-Counter` fallback. NVIDIA utilization, temperature, memory, and power come from
`nvidia-smi.exe`, with the selected GPU index retained in settings. The NVIDIA driver's utility must be
available on PATH. Missing counters, a missing NVIDIA utility, and invalid ranges leave only the affected
fields unavailable.

## Key Abstractions

1. `UsageReading` — current percentage, observation time, optional reset, and prior samples.
2. `currentWindowSamples` — drops samples before the latest percentage decrease, treating it as a reset boundary.
3. `WeeklyLimit` — maps source/settings/lifecycle events to refresh and rendering.
4. `KeyFace` — render-only state for source branding, stale data, danger threshold, and burn warning.
5. `SystemMetrics` — optional CPU/GPU utilization and temperature fields from local Windows sources.
6. `SystemMonitorFace` — render-only selected-utilization layout with unavailable placeholders and temperature-colored backgrounds.

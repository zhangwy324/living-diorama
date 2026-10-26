<#
.SYNOPSIS
Samples the running Living Diorama app for the performance baseline and the soak test (ADR 0009 sections 5-7).

.DESCRIPTION
Measures the app's process tree (the Rust host and its WebView2 child processes) at a fixed
interval and writes one CSV row per sample: working set, private bytes, CPU and GPU use, and GPU
memory. Each state is measured in turn; before each one the script says how to put the app in that
state and waits for Enter. At the end it prints a summary per state and the simulation event counts
the app writes to event-counts.json.

Start the app first, preferably a release build (`pnpm tauri build --no-bundle`, then
apps\desktop\src-tauri\target\release\living-diorama.exe), since a dev build also runs Vite.

The GPU counters use English counter names, so they read as zero on other display languages.

.EXAMPLE
pnpm measure
The baseline: strip idle, strip hovered, expanded and hidden, 5 minutes each.

.EXAMPLE
pnpm measure -States soak -Minutes 480 -IntervalSeconds 10
The 8-hour soak test.
#>
param(
    [string[]]$States = @('idle', 'hovered', 'expanded', 'hidden'),
    [double]$Minutes = 5,
    [int]$IntervalSeconds = 1,
    [string]$Out = "tools/development/out/measurements/app-$(Get-Date -Format 'yyyyMMdd-HHmmss').csv",
    [string]$ProcessName = 'living-diorama',
    # Starts each state at once instead of waiting for Enter.
    [switch]$NoPrompt
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$instructions = @{
    idle     = 'Show the compact strip and move the cursor off it.'
    hovered  = 'Show the compact strip and rest the cursor on it without moving it.'
    expanded = 'Expand the window, then move the cursor onto the taskbar or another monitor.'
    hidden   = 'Hide the window from the tray.'
    soak     = 'Show the compact strip with the default 3 creatures and move the cursor off it.'
}
$countsFile = Join-Path $env:LOCALAPPDATA 'com.livingdiorama.desktop\event-counts.json'
# How often the process tree is looked up again, since WebView2 can start or end processes.
$treeRefreshSeconds = 10

# `pwsh -File` passes `-States a,b` as one string.
$States = @($States | ForEach-Object { $_ -split ',' } | Where-Object { $_ })

function Get-AppRoot {
    $found = @(Get-Process -Name $ProcessName -ErrorAction SilentlyContinue)
    if ($found.Count -eq 0) { throw "$ProcessName is not running. Start the app first." }
    if ($found.Count -gt 1) { throw "More than one $ProcessName is running. Quit all but one." }
    $found[0].Id
}

# The root process and all its descendants.
function Get-TreeIds([int]$rootId) {
    $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId)
    $ids = [System.Collections.Generic.List[int]]::new()
    $ids.Add($rootId)
    for ($i = 0; $i -lt $ids.Count; $i++) {
        foreach ($p in $all) {
            if ($p.ParentProcessId -eq $ids[$i] -and $p.ProcessId -ne $ids[$i]) { $ids.Add([int]$p.ProcessId) }
        }
    }
    $ids
}

# GPU 3D engine use (percent, summed over the tree's processes) and dedicated GPU memory (MB).
# Reading the utilization counter takes about a second, since it compares two samples.
function Get-Gpu([System.Collections.Generic.HashSet[int]]$ids) {
    $samples = (Get-Counter -ErrorAction SilentlyContinue -Counter @(
            '\GPU Engine(*engtype_3D)\Utilization Percentage',
            '\GPU Process Memory(*)\Dedicated Usage')).CounterSamples
    $gpu = 0.0
    $memory = 0.0
    foreach ($s in @($samples)) {
        if ($s.InstanceName -notmatch '^pid_(\d+)_' -or -not $ids.Contains([int]$Matches[1])) { continue }
        if ($s.Path -like '*utilization percentage') { $gpu += $s.CookedValue } else { $memory += $s.CookedValue }
    }
    @{ Percent = $gpu; MemoryMb = $memory / 1MB }
}

function Measure-State([string]$state, [int]$rootId, [string]$path) {
    $cores = [Environment]::ProcessorCount
    $end = (Get-Date).AddMinutes($Minutes)
    $start = Get-Date
    $previousCpu = @{}
    $previousTime = $null
    $treeAt = [datetime]::MinValue
    $ids = $null
    $rows = [System.Collections.Generic.List[object]]::new()
    while ((Get-Date) -lt $end) {
        $sampleStart = Get-Date
        if (-not (Get-Process -Id $rootId -ErrorAction SilentlyContinue)) {
            Write-Warning 'The app exited; stopping.'
            return $rows
        }
        if (($sampleStart - $treeAt).TotalSeconds -ge $treeRefreshSeconds) {
            $ids = [System.Collections.Generic.HashSet[int]]::new([int[]]@(Get-TreeIds $rootId))
            $treeAt = $sampleStart
        }
        $gpu = Get-Gpu $ids
        $now = Get-Date
        $processes = @(Get-Process -Id ([int[]]@($ids)) -ErrorAction SilentlyContinue)
        $cpuTotal = 0.0
        $workingSet = 0
        $private = 0
        $cpu = @{}
        foreach ($p in $processes) {
            $workingSet += $p.WorkingSet64
            $private += $p.PrivateMemorySize64
            # A process that started since the last sample counts its whole CPU time.
            $seconds = $p.TotalProcessorTime.TotalSeconds
            $cpu[$p.Id] = $seconds
            $cpuTotal += $seconds - $(if ($previousCpu.ContainsKey($p.Id)) { $previousCpu[$p.Id] } else { 0 })
        }
        if ($null -ne $previousTime) {
            $row = [pscustomobject]@{
                time         = $now.ToString('o')
                state        = $state
                elapsed_s    = [math]::Round(($now - $start).TotalSeconds, 1)
                processes    = $processes.Count
                cpu_percent  = [math]::Round(100 * $cpuTotal / (($now - $previousTime).TotalSeconds * $cores), 2)
                gpu_percent  = [math]::Round($gpu.Percent, 2)
                working_set_mb = [math]::Round($workingSet / 1MB, 1)
                private_mb   = [math]::Round($private / 1MB, 1)
                gpu_memory_mb = [math]::Round($gpu.MemoryMb, 1)
            }
            $row | Export-Csv -Path $path -Append -NoTypeInformation
            $rows.Add($row)
        }
        $previousCpu = $cpu
        $previousTime = $now
        $wait = $IntervalSeconds - ((Get-Date) - $sampleStart).TotalSeconds
        if ($wait -gt 0) { Start-Sleep -Milliseconds ([int]($wait * 1000)) }
    }
    $rows
}

function Get-Mean($rows, [string]$column) {
    if (@($rows).Count -eq 0) { return $null }
    [math]::Round((@($rows) | Measure-Object -Property $column -Average).Average, 2)
}

# Memory growth from hour 1 to the end of the run (ADR 0009 section 6): the mean over minutes 60-70
# against the mean over the last 10 minutes. Empty for runs shorter than two hours.
function Get-Growth($rows, [string]$column) {
    $rows = @($rows)
    if ($rows.Count -eq 0 -or $rows[-1].elapsed_s -lt 7200) { return $null }
    $hour1 = $rows | Where-Object { $_.elapsed_s -ge 3600 -and $_.elapsed_s -lt 4200 }
    $last = $rows | Where-Object { $_.elapsed_s -ge $rows[-1].elapsed_s - 600 }
    [math]::Round(100 * ((Get-Mean $last $column) / (Get-Mean $hour1 $column) - 1), 1)
}

$rootId = Get-AppRoot
New-Item -ItemType Directory -Force -Path (Split-Path $Out) | Out-Null
$summary = foreach ($state in $States) {
    $instruction = $instructions[$state]
    if (-not $instruction) { $instruction = "Put the app in the '$state' state." }
    Write-Host "`n[$state] $instruction"
    if (-not $NoPrompt) { Read-Host 'Press Enter to start measuring' | Out-Null }
    Write-Host "Measuring for $Minutes min..."
    $rows = Measure-State $state $rootId $Out
    [pscustomobject]@{
        state              = $state
        samples            = @($rows).Count
        cpu_percent        = Get-Mean $rows 'cpu_percent'
        gpu_percent        = Get-Mean $rows 'gpu_percent'
        working_set_mb     = Get-Mean $rows 'working_set_mb'
        private_mb         = Get-Mean $rows 'private_mb'
        private_max_mb     = if (@($rows).Count) { (@($rows) | Measure-Object -Property private_mb -Maximum).Maximum } else { $null }
        gpu_memory_mb      = Get-Mean $rows 'gpu_memory_mb'
        private_growth_pct = Get-Growth $rows 'private_mb'
    }
    if (-not (Get-Process -Id $rootId -ErrorAction SilentlyContinue)) { break }
}

Write-Host "`nSamples: $Out"
Write-Host 'Means per state (CPU is a share of all logical processors):'
$summary | Format-Table -AutoSize | Out-String | Write-Host
if (Test-Path $countsFile) {
    $counts = Get-Content $countsFile -Raw | ConvertFrom-Json
    Write-Host "Events since the app started: $($counts.stuck) stuck, $($counts.recovered) recovered, $($counts.pathFailed) path failed"
    if ($counts.recovered -lt $counts.stuck) { Write-Warning 'Some stuck creatures have not moved again.' }
} else {
    Write-Warning "No event counts at $countsFile. Is the app a build from this branch or later?"
}

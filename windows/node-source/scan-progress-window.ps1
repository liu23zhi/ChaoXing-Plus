[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PayloadFile,
    [Parameter(Mandatory = $true)][string]$StateFile,
    [Parameter(Mandatory = $true)][string]$CancelFile,
    [int]$AutoCancelMs = 0,
    [switch]$Probe
)

$ErrorActionPreference = 'Stop'

function Read-JsonFile {
    param([string]$Path)
    try {
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
            if ($text) { return ($text | ConvertFrom-Json) }
        }
    } catch {
        return $null
    }
    return $null
}

try {
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
} catch {
    Write-Output (@{ probe = $false; winformsOk = $false; error = "winforms-unavailable: $($_.Exception.Message)" } | ConvertTo-Json -Compress)
    exit 4
}

$payload = Read-JsonFile $PayloadFile
if (-not $payload) {
    Write-Output (@{ probe = $false; winformsOk = $false; error = 'invalid-payload' } | ConvertTo-Json -Compress)
    exit 4
}

function Get-Text {
    param($Value, [string]$Fallback)
    if ($null -ne $Value -and ([string]$Value).Length -gt 0) { return [string]$Value }
    return $Fallback
}

$title = Get-Text $payload.title 'Chaoxing Plus - Full disk scan'
$message = Get-Text $payload.message 'Scanning fixed disk roots for CXExam.exe. Please wait...'
$detailTemplate = Get-Text $payload.detailTemplate 'Checked {0} directories, found {1} candidates.'
$cancelText = Get-Text $payload.cancelButtonText 'Cancel scan'
$fontName = Get-Text $payload.fontName 'Microsoft YaHei UI'

try {
    $form = New-Object System.Windows.Forms.Form
    $form.Text = $title
    $form.ClientSize = New-Object System.Drawing.Size(560, 190)
    $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedDialog
    $form.MaximizeBox = $false
    $form.MinimizeBox = $false
    $form.StartPosition = [System.Windows.Forms.FormStartPosition]::CenterScreen
    $form.ShowInTaskbar = $true
    $form.TopMost = $true

    $titleLabel = New-Object System.Windows.Forms.Label
    $titleLabel.Text = $title
    $titleLabel.Font = New-Object System.Drawing.Font($fontName, 13, [System.Drawing.FontStyle]::Bold)
    $titleLabel.AutoSize = $false
    $titleLabel.Width = 520
    $titleLabel.Height = 30
    $titleLabel.Left = 20
    $titleLabel.Top = 18

    $messageLabel = New-Object System.Windows.Forms.Label
    $messageLabel.Text = $message
    $messageLabel.AutoSize = $false
    $messageLabel.Width = 520
    $messageLabel.Height = 40
    $messageLabel.Left = 20
    $messageLabel.Top = 54

    $detailLabel = New-Object System.Windows.Forms.Label
    $detailLabel.Text = ([string]::Format($detailTemplate, 0, 0))
    $detailLabel.AutoSize = $false
    $detailLabel.Width = 520
    $detailLabel.Height = 24
    $detailLabel.Left = 20
    $detailLabel.Top = 98

    $progress = New-Object System.Windows.Forms.ProgressBar
    $progress.Style = [System.Windows.Forms.ProgressBarStyle]::Marquee
    $progress.MarqueeAnimationSpeed = 30
    $progress.Width = 520
    $progress.Height = 18
    $progress.Left = 20
    $progress.Top = 128

    $cancel = New-Object System.Windows.Forms.Button
    $cancel.Text = $cancelText
    $cancel.Width = 130
    $cancel.Height = 32
    $cancel.Left = 410
    $cancel.Top = 148
    $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel

    $form.Controls.Add($titleLabel)
    $form.Controls.Add($messageLabel)
    $form.Controls.Add($detailLabel)
    $form.Controls.Add($progress)
    $form.Controls.Add($cancel)
    $form.CancelButton = $cancel
} catch {
    Write-Output (@{ probe = $false; winformsOk = $false; error = "form-build-failed: $($_.Exception.Message)" } | ConvertTo-Json -Compress)
    exit 5
}

if ($Probe) {
    $form.Dispose()
    Write-Output (@{
        probe = $true
        winformsOk = $true
        hasCancelButton = ($null -ne $cancel)
        hasProgressBar = ($null -ne $progress)
        hasDetailLabel = ($null -ne $detailLabel)
    } | ConvertTo-Json -Compress)
    exit 0
}

$script:finished = $false

function Stop-ProgressWindow {
    param([bool]$Cancelled)
    if ($script:finished) { return }
    if ($Cancelled) {
        try {
            Set-Content -LiteralPath $CancelFile -Value '1' -Encoding ASCII
        } catch {
            # A missing cancel marker only affects the host's promptness; the window still closes.
        }
    }
    $script:finished = $true
    $form.Close()
}

$cancel.Add_Click({ Stop-ProgressWindow $true })
$form.Add_FormClosing({
    param($sender, $eventArgs)
    if (-not $script:finished) { Stop-ProgressWindow $true }
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 200
$timer.Add_Tick({
    $state = Read-JsonFile $StateFile
    if ($null -eq $state) { return }
    if ($state.done -eq $true) {
        $script:finished = $true
        $form.Close()
        return
    }
    try {
        $detailLabel.Text = [string]::Format($detailTemplate, [long]$state.directoriesVisited, [long]$state.candidatesFound)
    } catch {
        # Keep the previous detail text when the state file is transiently unreadable.
    }
})
$timer.Start()

if ($AutoCancelMs -gt 0) {
    $autoTimer = New-Object System.Windows.Forms.Timer
    $autoTimer.Interval = $AutoCancelMs
    $autoTimer.Add_Tick({
        $autoTimer.Stop()
        Stop-ProgressWindow $true
    })
    $autoTimer.Start()
}

try {
    Add-Type -Name Win32Progress -Namespace ProgressWindow -MemberDefinition '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);'
} catch {
    # Advancing the window is best effort; the dialog still opens without it.
}

$form.Add_Shown({
    try {
        [void][ProgressWindow.Win32Progress]::ShowWindow($form.Handle, 1)
        [void][ProgressWindow.Win32Progress]::SetForegroundWindow($form.Handle)
    } catch {
        # ignore missing window APIs
    }
    # VISIBILITY_PROBE_HOOK
})

[void]$form.ShowDialog()
$timer.Stop()

param(
  [switch]$Probe,
  [int]$AutoCloseMs = 0
)

# NOTE: Keep this script pure ASCII. Windows PowerShell 5.1 decodes .ps1 files that
# have no BOM using the OEM code page, so non-ASCII literals would corrupt parsing.
# All user-visible text is passed over UTF-8 JSON stdin instead.

$ErrorActionPreference = 'Stop'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::InputEncoding = $utf8
[Console]::OutputEncoding = $utf8

function Write-ResultFile {
  param([hashtable]$Payload)
  $json = $Payload | ConvertTo-Json -Compress
  [Console]::Out.WriteLine($json)
}

function Get-Text {
  param($Value, [string]$Fallback)
  if ($null -ne $Value -and ([string]$Value).Length -gt 0) { return [string]$Value }
  return $Fallback
}

try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
} catch {
  Write-ResultFile @{ cancelled = $true; error = "winforms-unavailable: $($_.Exception.Message)" }
  exit 3
}

try {
  $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json
} catch {
  Write-ResultFile @{ cancelled = $true; error = "invalid-input: $($_.Exception.Message)" }
  exit 4
}

# Explicit visibility APIs are required because the PowerShell process is hidden.
try {
  Add-Type -Name DpiAwareness -Namespace Win32Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware(); [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr handle, int command); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr handle);'
} catch {
  Write-ResultFile @{ error = "native-window-api-unavailable: $($_.Exception.Message)" }
  exit 5
}
try { [void][Win32Dpi.DpiAwareness]::SetProcessDPIAware() } catch {}

$candidates = @($payload.candidates)
$title = Get-Text $payload.title 'Chaoxing Plus - Select Exam Client'
$hintText = Get-Text $payload.hint 'Select the CXExam.exe client to launch. Use Browse to pick another location.'
$okText = Get-Text $payload.selectButtonText 'Use selected client'
$browseText = Get-Text $payload.browseButtonText 'Browse...'
$scanAllText = Get-Text $payload.scanAllButtonText 'Scan all drives...'
$cancelText = Get-Text $payload.cancelButtonText 'Cancel'
$fontName = Get-Text $payload.fontName 'Microsoft YaHei UI'
$messages = $payload.messages
$chooseFirstMessage = Get-Text $messages.chooseFirst 'Select a client first, or use Browse to pick CXExam.exe.'
$mustBeCxExamMessage = Get-Text $messages.mustBeCxExam 'The file name must be CXExam.exe.'
$dialogTitle = Get-Text $messages.dialogTitle 'Select CXExam.exe'
$filterPrimary = Get-Text $messages.filterPrimary 'CXExam.exe|CXExam.exe'
$filterAll = Get-Text $messages.filterAll 'Executable (*.exe)|*.exe'

function New-SelectionForm {
  $form = New-Object System.Windows.Forms.Form
  $form.Text = $title
  $form.StartPosition = 'CenterScreen'
  $form.MinimizeBox = $false
  $form.MaximizeBox = $false
  $form.Width = 820
  $form.Height = 470
  $form.MinimumSize = New-Object System.Drawing.Size(620, 360)
  try {
    $form.Font = New-Object System.Drawing.Font($fontName, 9)
  } catch {
    $form.Font = New-Object System.Drawing.Font('Segoe UI', 9)
  }

  $hint = New-Object System.Windows.Forms.Label
  $hint.Text = $hintText
  $hint.AutoSize = $false
  $hint.Dock = 'Top'
  $hint.Height = 64
  $hint.Padding = New-Object System.Windows.Forms.Padding(12, 8, 12, 0)

  $list = New-Object System.Windows.Forms.ListBox
  $list.Dock = 'Fill'
  $list.IntegralHeight = $false
  $list.HorizontalScrollbar = $true
  for ($index = 0; $index -lt $candidates.Count; $index += 1) {
    $candidate = $candidates[$index]
    $display = Get-Text $candidate.display ("[ {0} ] {1}" -f ($index + 1), [string]$candidate.path)
    try {
      $version = [System.Diagnostics.FileVersionInfo]::GetVersionInfo([string]$candidate.path).FileVersion
      if ($version) { $display = $display + ' | ' + $version }
    } catch {}
    [void]$list.Items.Add($display)
  }
  if ($list.Items.Count -gt 0) {
    $preferred = [int]$payload.preferredIndex
    if ($preferred -lt 0 -or $preferred -ge $list.Items.Count) { $preferred = 0 }
    $list.SelectedIndex = $preferred
  }
  # Docking runs in reverse Z-order: reserve the hint and buttons before Fill.
  $form.Controls.Add($list)
  $form.Controls.Add($hint)

  $buttons = New-Object System.Windows.Forms.FlowLayoutPanel
  $buttons.Dock = 'Bottom'
  $buttons.Height = 58
  $buttons.FlowDirection = 'RightToLeft'
  $buttons.Padding = New-Object System.Windows.Forms.Padding(12, 10, 12, 12)
  $buttons.WrapContents = $false

  $ok = New-Object System.Windows.Forms.Button
  $ok.Text = $okText
  $ok.Width = 150
  $ok.Height = 32
  $ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
  $ok.Enabled = ($list.Items.Count -gt 0)

  $browse = New-Object System.Windows.Forms.Button
  $browse.Text = $browseText
  $browse.Width = 110
  $browse.Height = 32

  $scanAll = New-Object System.Windows.Forms.Button
  $scanAll.Text = $scanAllText
  $scanAll.Width = 120
  $scanAll.Height = 32

  $cancel = New-Object System.Windows.Forms.Button
  $cancel.Text = $cancelText
  $cancel.Width = 90
  $cancel.Height = 32
  $cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel

  [void]$buttons.Controls.Add($ok)
  [void]$buttons.Controls.Add($browse)
  [void]$buttons.Controls.Add($scanAll)
  [void]$buttons.Controls.Add($cancel)
  $form.Controls.Add($buttons)
  $form.AcceptButton = $ok
  $form.CancelButton = $cancel

  return @{ form = $form; list = $list; ok = $ok; browse = $browse; scanAll = $scanAll; cancel = $cancel; buttons = $buttons }
}

try {
  $ui = New-SelectionForm
} catch {
  Write-ResultFile @{ cancelled = $true; error = "form-build-failed: $($_.Exception.Message)" }
  exit 5
}

if ($Probe) {
  # Automated smoke test: build controls only, do not enter the message loop.
  $ui.form.Dispose()
  Write-ResultFile @{
    probe = $true
    winformsOk = $true
    candidateCount = $candidates.Count
    hasListView = ($null -ne $ui.list)
    hasBrowseButton = ($null -ne $ui.browse)
    hasScanAllButton = ($null -ne $ui.scanAll)
  }
  exit 0
}

$script:selection = @{ cancelled = $true }

$ui.ok.Add_Click({
  if ($ui.list.SelectedIndex -lt 0) {
    [void][System.Windows.Forms.MessageBox]::Show($chooseFirstMessage, $title)
    return
  }
  $candidate = $candidates[$ui.list.SelectedIndex]
  $script:selection = @{ path = [string]$candidate.path; index = ($ui.list.SelectedIndex + 1); manual = $false; cancelled = $false }
  $ui.form.Close()
})

$ui.browse.Add_Click({
  $dialog = New-Object System.Windows.Forms.OpenFileDialog
  $dialog.Title = $dialogTitle
  $dialog.Filter = ($filterPrimary + '|' + $filterAll)
  $dialog.CheckFileExists = $true
  if ($dialog.ShowDialog($ui.form) -eq [System.Windows.Forms.DialogResult]::OK) {
    if ([System.IO.Path]::GetFileName($dialog.FileName) -ne 'CXExam.exe') {
      [void][System.Windows.Forms.MessageBox]::Show($mustBeCxExamMessage, $title)
      return
    }
    $script:selection = @{ path = $dialog.FileName; index = 0; manual = $true; cancelled = $false }
    $ui.form.Close()
  }
})

$ui.cancel.Add_Click({
  $script:selection = @{ cancelled = $true }
  $ui.form.Close()
})

$ui.scanAll.Add_Click({
  $script:selection = @{ action = 'scan-all' }
  $ui.form.Close()
})

$ui.list.Add_DoubleClick({
  $ui.ok.PerformClick()
})

if ($AutoCloseMs -gt 0) {
  # Automated verification only: close the window after N ms instead of waiting for a user.
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = $AutoCloseMs
  $timer.Add_Tick({
    $timer.Stop()
    $script:selection = @{ cancelled = $true; autoClosed = $true }
    $ui.form.Close()
  })
  $timer.Start()
}

# The hidden PowerShell startup flag can hide the first GUI window as well.
# ShowDialog still runs its message loop in that case, so explicitly show it.
$ui.form.Add_Shown({
  [void][Win32Dpi.DpiAwareness]::ShowWindow($ui.form.Handle, 1)
  [void][Win32Dpi.DpiAwareness]::SetForegroundWindow($ui.form.Handle)
  $ui.form.Activate()
})
[void]$ui.form.ShowDialog()
$ui.form.Dispose()
Write-ResultFile $script:selection
exit 0

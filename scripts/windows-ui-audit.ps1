param(
    [ValidateSet("tree", "invoke", "screenshot")]
    [string]$Action = "tree",
    [string]$Name,
    [int]$Ordinal = 0,
    [string]$OutputPath
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$process = Get-Process "chimera-plus-plus" -ErrorAction Stop | Select-Object -First 1
$root = [System.Windows.Automation.AutomationElement]::FromHandle($process.MainWindowHandle)
if (-not $root) {
    throw "Chimera++ window was not found."
}

function Get-MatchingElement([string]$AccessibleName, [int]$Index) {
    $condition = [System.Windows.Automation.PropertyCondition]::new(
        [System.Windows.Automation.AutomationElement]::NameProperty,
        $AccessibleName
    )
    $matches = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        $condition
    )
    if ($Index -lt 0 -or $Index -ge $matches.Count) {
        throw "Control '$AccessibleName' at index $Index was not found (count: $($matches.Count))."
    }
    return $matches.Item($Index)
}

if ($Action -eq "invoke") {
    if (-not $Name) {
        throw "-Name is required for invoke."
    }
    $element = Get-MatchingElement $Name $Ordinal
    $pattern = $element.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
    return
}

if ($Action -eq "tree") {
    $all = $root.FindAll(
        [System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.Condition]::TrueCondition
    )
    for ($index = 0; $index -lt $all.Count; $index++) {
        $element = $all.Item($index)
        if ($element.Current.IsOffscreen -or -not $element.Current.Name) {
            continue
        }
        [pscustomobject]@{
            Index = $index
            Name = $element.Current.Name
            Type = $element.Current.ControlType.ProgrammaticName
            Enabled = $element.Current.IsEnabled
            Bounds = $element.Current.BoundingRectangle
        }
    }
    return
}

if (-not $OutputPath) {
    throw "-OutputPath is required for screenshot."
}

Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class ChimeraWindowCapture {
    [StructLayout(LayoutKind.Sequential)]
    public struct Rect { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hWnd, out Rect rect);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdc, uint flags);
}
"@

$rect = [ChimeraWindowCapture+Rect]::new()
if (-not [ChimeraWindowCapture]::GetWindowRect($process.MainWindowHandle, [ref]$rect)) {
    throw "Could not read the Chimera++ window bounds."
}
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
$bitmap = [System.Drawing.Bitmap]::new($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $hdc = $graphics.GetHdc()
    try {
        if (-not [ChimeraWindowCapture]::PrintWindow($process.MainWindowHandle, $hdc, 2)) {
            throw "PrintWindow failed."
        }
    }
    finally {
        $graphics.ReleaseHdc($hdc)
    }

    $directory = Split-Path -Parent $OutputPath
    if ($directory) {
        [System.IO.Directory]::CreateDirectory($directory) | Out-Null
    }
    # Preserve native dimensions so visual audits do not stretch the interface.
    $bitmap.Save($OutputPath, [System.Drawing.Imaging.ImageFormat]::Png)
}
finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}

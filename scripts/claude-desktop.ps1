param([string]$Model = 'Opus 5.5', [string]$Effort = 'medium', [string]$Project)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

# 只在 Claude 自己的窗口查找语义控件，不使用屏幕坐标或全局盲发按键。
function Finish($value) { $value | ConvertTo-Json -Compress -Depth 5; exit 0 }
function Elements {
    $script:root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
}
function Click($element) {
    if (!$element.Current.IsEnabled) { throw '控件不可用' }
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); return }
    if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $pattern.Select(); return }
    throw '控件未提供可用的操作接口'
}
function FindButton($pattern) {
    $matches = @(Elements | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -match $pattern })
    if ($matches.Count -eq 1) { return $matches[0] }
    return $null
}
function SelectOption($pattern) {
    # 只操作菜单选项，不把正文中同名文字当作可点击目标。
    $options = @(Elements | Where-Object {
        $_.Current.Name -match $pattern -and $_.Current.ControlType.ProgrammaticName -match 'MenuItem|RadioButton|ListItem'
    })
    if ($options.Count -ne 1) { return $false }
    Click $options[0]
    Start-Sleep -Milliseconds 250
    return $true
}
try {
    $windows = @(Get-Process Claude -ErrorAction SilentlyContinue | Where-Object MainWindowHandle -ne 0)
    if ($windows.Count -ne 1) { Finish @{status='needs_attention'; reason='claude_window_not_unique'} }
    $script:root = [System.Windows.Automation.AutomationElement]::FromHandle($windows[0].MainWindowHandle)
    $all = @(Elements)
    if ($all | Where-Object { $_.Current.Name -eq 'Trust workspace' }) {
        Finish @{status='needs_confirmation'; reason='workspace_trust'; nextAction='请在 Claude 核对目标目录并确认信任'}
    }
    $code = @($all | Where-Object { $_.Current.Name -eq 'Code' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::RadioButton })
    if ($code.Count -ne 1) { Finish @{status='needs_attention'; reason='code_control_unavailable'} }
    $selected = $null
    if (!$code[0].TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selected) -or !$selected.Current.IsSelected) {
        Finish @{status='needs_attention'; reason='code_mode_not_selected'; nextAction='先使用 bridge_desktop_open 打开目标项目'}
    }
    # 操作已有会话前必须能读到目标目录，避免误改另一项目。无法核对则保留现状。
    if (!$Project -or !($all | Where-Object { $_.Current.Name -eq $Project -or $_.Current.HelpText -eq $Project })) {
        Finish @{status='needs_attention'; reason='project_not_verified'; nextAction='无法从界面核对完整项目目录，请在 Claude 确认目录后选择模型与强度'}
    }
    if ($all | Where-Object { $_.Current.Name -match '^Stop( response| Claude)?$' }) {
        Finish @{status='needs_attention'; reason='session_busy'}
    }
    $modelPattern = [regex]::Escape($Model)
    $button = FindButton '^Model:'
    if (!$button) { Finish @{status='needs_attention'; reason='model_control_unavailable'} }
    if ($button.Current.Name -notmatch ('^Model:\s*' + $modelPattern + '(\s|$)')) {
        Click $button
        Start-Sleep -Milliseconds 250
        if (!(SelectOption ('^' + $modelPattern + '(\s|$)'))) { Finish @{status='needs_attention'; reason='requested_model_not_available'} }
    }
    $button = FindButton '^Model:'
    $effortLabel = @{low='Low';medium='Medium';high='High';xhigh='Extra high';max='Max'}[$Effort]
    if (!$effortLabel) { throw '未知思考强度' }
    if (!$button -or $button.Current.Name -notmatch ('\b' + [regex]::Escape($effortLabel) + '$')) {
        $effortButton = FindButton '^(Effort:|Thinking effort|Reasoning effort)'
        if ($effortButton) { Click $effortButton } elseif ($button) { Click $button } else { throw '模型控件消失' }
        Start-Sleep -Milliseconds 250
        if (!(SelectOption ('^' + [regex]::Escape($effortLabel) + '(\s|$)'))) { Finish @{status='needs_attention'; reason='effort_control_unavailable'} }
    }
    $button = FindButton '^Model:'
    if ($button -and $button.Current.Name -match ('^Model:\s*' + $modelPattern + '\s+' + [regex]::Escape($effortLabel) + '$')) {
        Finish @{status='configured';model=$Model;effort=$Effort;project=$Project;sessionReady=$false}
    }
    Finish @{status='needs_attention';reason='selection_not_verified'}
} catch {
    # 不输出可能带有私有 UI 文本的原始异常。
    Finish @{status='needs_attention';reason='desktop_control_failed'}
}

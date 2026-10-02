param([string]$Model = 'Sonnet', [string]$Effort = 'medium', [string]$Project, [string]$ExpectedPrompt, [switch]$TrustWorkspace)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
. (Join-Path $PSScriptRoot 'desktop-selection.ps1')

# 只在 Claude 自己的窗口查找语义控件，不使用屏幕坐标或全局盲发按键。
function Finish($value) { $value | ConvertTo-Json -Compress -Depth 12; exit 0 }
function Elements {
    $script:root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
}
function Click($element) {
    if (!$element.Current.IsEnabled) { throw '控件不可用' }
    $pattern = $null
    if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) { $pattern.Invoke(); return }
    if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) { $pattern.Select(); return }
    if ($element.TryGetCurrentPattern([System.Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$pattern)) { $pattern.Expand(); return }
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
    # Electron 首次查询可能只有窗口边框；等待语义树就绪，有界重试且不激活窗口。
    $all = @()
    for ($attempt = 0; $attempt -lt 12; $attempt++) {
        $all = @(Elements)
        if ($all | Where-Object { $_.Current.Name -eq 'Code' -or $_.Current.Name -eq 'Trust workspace' }) { break }
        Start-Sleep -Milliseconds 250
    }
    if ($all | Where-Object { $_.Current.Name -eq 'Trust workspace' }) {
        # 新版标题为 Trust this workspace?；从唯一确认按钮定位其独立弹窗。
        $titles = @($all | Where-Object { $_.Current.Name -eq 'Trust workspace' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button })
        if ($titles.Count -ne 1) { Finish @{status='needs_confirmation';reason='trust_dialog_not_unique'} }
        $container = $titles[0]
        $candidate = $null
        for ($level = 0; $level -lt 6; $level++) {
            $container = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetParent($container)
            if (!$container -or [System.Windows.Automation.Automation]::Compare($container, $script:root)) { break }
            $children = @($container.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition))
            $buttons = @($children | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button })
            # 独立弹窗不能包含聊天输入框或导航；找不到则明确报告不可完整读取。
            if ($children | Where-Object { $_.Current.Name -eq 'Prompt' -or $_.Current.Name -eq 'Code' }) { break }
            if ($buttons.Count -gt 0) { $candidate = @{children=$children;buttons=$buttons}; break }
        }
        if (!$candidate) { Finish @{status='needs_confirmation';reason='trust_dialog_unavailable';popup=@{title='Trust workspace';complete=$false}} }
        $texts = @($candidate.children | ForEach-Object { $_.Current.Name } | Where-Object { $_ } | Select-Object -Unique)
        $popup = @{title='Trust workspace';texts=$texts;buttons=@($candidate.buttons | ForEach-Object {$_.Current.Name});complete=$true;source='uia_dialog'}
        if (!(Test-WorkspaceTrust $Project $texts $TrustWorkspace.IsPresent)) {
            Finish @{status='needs_confirmation';reason='workspace_trust';popup=$popup;nextAction='完整目录未核对或自动信任已关闭，请中文转述此弹窗'}
        }
        $confirm = @($candidate.buttons | Where-Object { $_.Current.Name -match '^(Trust workspace|Trust folder|Trust and continue|Yes, I trust this folder|Trust)$' })
        if ($confirm.Count -ne 1) { Finish @{status='needs_confirmation';reason='trust_button_not_unique';popup=$popup} }
        Click $confirm[0]
        Start-Sleep -Milliseconds 400
        $all = @(Elements)
        if ($all | Where-Object { $_.Current.Name -eq 'Trust workspace' }) { Finish @{status='needs_confirmation';reason='trust_not_dismissed';popup=$popup} }
    }
    $code = @($all | Where-Object { $_.Current.Name -eq 'Code' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::RadioButton })
    if ($code.Count -ne 1) { Finish @{status='needs_attention'; reason='code_control_unavailable'} }
    $selected = $null
    if (!$code[0].TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$selected) -or !$selected.Current.IsSelected) {
        Finish @{status='needs_attention'; reason='code_mode_not_selected'; nextAction='先使用 bridge_desktop_open 打开目标项目'}
    }
    # 新草稿必须与本次深链接完全匹配；实际 cwd 由随后 Hook 登记再次校验。
    $draftOwned = $false
    $prompt = $null
    if ($ExpectedPrompt) {
        $prompts = @($all | Where-Object { $_.Current.Name -eq 'Prompt' -and $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit })
        $value = $null
        if ($prompts.Count -eq 1 -and $prompts[0].TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$value)) {
            $draftOwned = $value.Current.Value -eq $ExpectedPrompt
            $prompt = $prompts[0]
        }
        if (!$draftOwned) { Finish @{status='needs_attention'; reason='draft_not_verified'; sessionReady=$false} }
        $folderName = Split-Path $Project -Leaf
        if (!($all | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Button -and $_.Current.Name -eq $folderName })) {
            Finish @{status='needs_attention'; reason='draft_project_not_verified'; sessionReady=$false}
        }
    }
    # 普通配置不借助草稿标识，必须从界面读到完整目录。
    if (!$Project -or (!$draftOwned -and !($all | Where-Object { $_.Current.Name -eq $Project -or $_.Current.HelpText -eq $Project }))) {
        Finish @{status='needs_attention'; reason='project_not_verified'; nextAction='无法从界面核对完整项目目录，请在 Claude 确认目录后选择模型与强度'}
    }
    if ($all | Where-Object { $_.Current.Name -match '^Stop( response| Claude)?$' }) {
        Finish @{status='needs_attention'; reason='session_busy'}
    }
    $modelPattern = [regex]::Escape($Model)
    if ($Model -match '^(Opus|Sonnet|Haiku)$') { $modelPattern += ' \d+(\.\d+)?' }
    if ($draftOwned) {
        $worktrees = @($all | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::CheckBox -and $_.Current.Name -match '(?i)worktree' })
        # 普通目录没有 Git worktree 选项是正常情况；Git 项目仍必须明确关闭。
        if ($worktrees.Count -eq 0 -and !(Test-Path -LiteralPath (Join-Path $Project '.git'))) {
            # 不创建 Git 仓库来满足界面控件假设。
        } else {
            if ($worktrees.Count -ne 1) { Finish @{status='needs_attention';reason='worktree_control_unavailable'} }
            $toggle = $null
            if (!$worktrees[0].TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern,[ref]$toggle)) { Finish @{status='needs_attention';reason='worktree_control_unavailable'} }
            if ($toggle.Current.ToggleState -eq [System.Windows.Automation.ToggleState]::On) { $toggle.Toggle() }
            if ($toggle.Current.ToggleState -ne [System.Windows.Automation.ToggleState]::Off) { Finish @{status='needs_attention';reason='worktree_not_disabled'} }
        }
    }
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
    $effortButton = FindButton '^(Effort:|Thinking effort|Reasoning effort)'
    $selection = Read-DesktopSelection $button.Current.Name $effortButton.Current.Name
    if ($selection.effort -ne $Effort) {
        if ($effortButton) { Click $effortButton } elseif ($button) { Click $button } else { throw '模型控件消失' }
        Start-Sleep -Milliseconds 250
        if (!(SelectOption ('^' + [regex]::Escape($effortLabel) + '(\s|$)'))) { Finish @{status='needs_attention'; reason='effort_control_unavailable'} }
    }
    $button = FindButton '^Model:'
    $effortButton = FindButton '^(Effort:|Thinking effort|Reasoning effort)'
    $selection = Read-DesktopSelection $button.Current.Name $effortButton.Current.Name
    if ((Test-DesktopModel $Model $selection.model) -and $selection.effort -eq $Effort) {
        if ($draftOwned) {
            # 用户编辑过草稿则停止，不覆盖输入，也不重发。
            $value = $null
            if (!$prompt.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern,[ref]$value) -or $value.Current.Value -ne $ExpectedPrompt) {
                Finish @{status='needs_attention';reason='draft_changed'}
            }
            $send = FindButton '^Send( message)?$'
            if (!$send) { Finish @{status='needs_attention';reason='send_control_unavailable'} }
            Click $send
            Finish @{status='bootstrap_sent';model=$selection.model;effort=$selection.effort;sessionReady=$false}
        }
        Finish @{status='configured';model=$selection.model;effort=$selection.effort;project=$Project;sessionReady=$false}
    }
    Finish @{status='needs_attention';reason='selection_not_verified'}
} catch {
    # 不输出可能带有私有 UI 文本的原始异常。
    Finish @{status='needs_attention';reason='desktop_control_failed'}
}

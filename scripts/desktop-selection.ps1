# 纯文本解析：兼容独立强度按钮和旧版合并标签，不把未知强度猜成默认值。
function Read-DesktopSelection([string]$ModelLabel, [string]$EffortLabel) {
    $modelName = $null
    $level = $null
    if ($ModelLabel -match '^Model:\s*((?:Opus|Sonnet|Haiku) \d+(?:\.\d+)?)(?:\s|$)') { $modelName = $Matches[1] }
    $label = $EffortLabel
    if (!$label) { $label = $ModelLabel }
    if ($label -match '(?:^|[\s:])(Extra high|Xhigh|Low|Medium|High|Max)$') {
        $level = $Matches[1].ToLowerInvariant()
        if ($level -eq 'extra high') { $level = 'xhigh' }
    }
    return @{ model = $modelName; effort = $level }
}

# 模型族允许当前具体版本，显式版本则要求完全相等。
function Test-DesktopModel([string]$Requested, [string]$Actual) {
    if ($Requested -match '^(Opus|Sonnet|Haiku)$') { return $Actual -match ('^' + $Requested + ' \d+(\.\d+)?$') }
    return $Requested -ceq $Actual
}

# 必须是对话框内完整路径匹配，不能只凭目录名或其他页面中的同名文字确认。
function Test-WorkspaceTrust([string]$Project, [string[]]$DialogText, [bool]$Enabled) {
    if (!$Enabled -or !$Project -or !($DialogText -contains 'Trust workspace')) { return $false }
    $target = $Project.TrimEnd('\', '/').Replace('/', '\')
    return @($DialogText | Where-Object { $_.Trim().TrimEnd('\', '/').Replace('/', '\') -ieq $target }).Count -eq 1
}

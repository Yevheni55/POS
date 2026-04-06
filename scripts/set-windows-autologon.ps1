#Requires -RunAsAdministrator
# One-time on the bar PC: automatic sign-in after reboot (local account).
# If you see "running scripts is disabled": run set-windows-autologon.cmd as Administrator, or:
#   powershell -ExecutionPolicy Bypass -File "C:\POS\scripts\set-windows-autologon.ps1"
# Security: password is stored in the registry (Winlogon) — use a dedicated kiosk-style account with minimal rights if possible.

$ErrorActionPreference = 'Stop'

Write-Host 'Automatic Windows sign-in (Winlogon)'
Write-Host '------------------------------------'

$defaultUser = $env:USERNAME
$user = Read-Host "Local username [$defaultUser]"
if ([string]::IsNullOrWhiteSpace($user)) { $user = $defaultUser }

$secure = Read-Host 'Password for this Windows user' -AsSecureString
if ($secure.Length -eq 0) {
  Write-Error 'Password is required for classic auto-logon.'
}

$BSTR = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
try {
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR) | Out-Null
}

# Windows 10/11: allow auto-logon when "passwordless" device features would block it
$pwdLess = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\PasswordLess\Device'
if (Test-Path $pwdLess) {
  Set-ItemProperty -Path $pwdLess -Name 'DevicePasswordLessBuildVersion' -Value 0 -Type DWord
  Write-Host 'Set DevicePasswordLessBuildVersion=0 (auto-logon compatibility).'
}

$winlogon = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Winlogon'
Set-ItemProperty -Path $winlogon -Name 'AutoAdminLogon' -Value '1' -Type String
Set-ItemProperty -Path $winlogon -Name 'DefaultUserName' -Value $user -Type String
Set-ItemProperty -Path $winlogon -Name 'DefaultPassword' -Value $plain -Type String
# Workgroup PC: empty domain is typical
Set-ItemProperty -Path $winlogon -Name 'DefaultDomainName' -Value '' -Type String -ErrorAction SilentlyContinue

Write-Host ''
Write-Host 'Done. Reboot to test. To disable later: set AutoAdminLogon=0 and remove DefaultPassword from Winlogon (regedit or script).'

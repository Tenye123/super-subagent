# End-to-end SSH validation against the REAL sshd.
# Must run elevated (writes C:\ProgramData\ssh\administrators_authorized_keys).
#
# Proves the whole chain the fleet tool relies on:
#   key generation -> authorized_keys with options -> sshd accepts -> command runs
# and specifically proves the authorized_keys OPTION syntax is accepted by the
# installed sshd (expiry-time / restrict / from). A bad option makes sshd
# reject the whole key, which is exactly the failure we want to catch.

$ErrorActionPreference = 'Continue'
$out = "$env:TEMP\fleet-ssh-validate.txt"
function Say($m) { Add-Content -Path $out -Value $m -Encoding UTF8 }
Set-Content -Path $out -Value "=== SSH validation $(Get-Date -Format o) ===" -Encoding UTF8

$sshdExe = 'C:\Program Files\OpenSSH\sshd.exe'
$keygen  = 'C:\Program Files\OpenSSH\ssh-keygen.exe'
$sshExe  = 'C:\Program Files\OpenSSH\ssh.exe'
$adminKeys = 'C:\ProgramData\ssh\administrators_authorized_keys'

$work = "$env:TEMP\fleet-sshval"
New-Item -ItemType Directory -Force -Path $work | Out-Null

# ---- 1. generate a client key ----
$ck = Join-Path $work 'client_key'
if (Test-Path $ck) { Remove-Item $ck, "$ck.pub" -Force -ErrorAction SilentlyContinue }
& $keygen -t ed25519 -f $ck -N '""' -C 'fleet-validate' 2>&1 | Out-Null
Say "client key created: $(Test-Path $ck)"

$pub = (Get-Content "$ck.pub" -Raw).Trim()
Say "pubkey: $($pub.Substring(0, [Math]::Min(50, $pub.Length)))..."

# ---- 2. back up existing authorized_keys ----
$existedBefore = Test-Path $adminKeys
if ($existedBefore) {
  Copy-Item $adminKeys "$work\admin_keys.bak" -Force
  Say "backed up existing administrators_authorized_keys"
} else {
  Say "administrators_authorized_keys did not exist"
}

# ---- 3. write key WITH the exact options fleet uses ----
$expiry = (Get-Date).AddDays(30).ToString('yyyyMMddHHmm')
$line = "restrict,expiry-time=`"$expiry`",from=`"127.0.0.1,::1,100.64.0.0/10`" $pub fleet-validate"
Set-Content -Path $adminKeys -Value $line -Encoding ASCII
Say "wrote authorized_keys line"
Say "  $line"

# ---- 4. ACL: sshd refuses the file if non-admins can read it ----
& icacls $adminKeys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" 2>&1 | Out-Null
Say "ACL set"
Say "--- ACL ---"
Say ((& icacls $adminKeys 2>&1 | Out-String).Trim())

# ---- 5. restart sshd so it re-reads (it caches nothing, but be safe) ----
Restart-Service sshd -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Say "sshd status: $((Get-Service sshd).Status)"

# ---- 6. the real test: log in over SSH and run a command ----
$user = "$env:USERDOMAIN\$env:USERNAME"
if (-not $env:USERDOMAIN) { $user = $env:USERNAME }
Say "trying login as: $user"

$sshArgs = @(
  '-i', $ck,
  '-p', '22',
  '-o', 'BatchMode=yes',
  '-o', 'StrictHostKeyChecking=no',
  '-o', 'UserKnownHostsFile=NUL',
  '-o', 'ConnectTimeout=10',
  "$user@127.0.0.1",
  'echo FLEET_LOGIN_OK; hostname'
)
$result = (& $sshExe @sshArgs 2>&1 | Out-String).Trim()
Say "--- ssh output ---"
Say $result
Say "--- ssh exit: $LASTEXITCODE ---"
Say "RESULT: $(if($result -match 'FLEET_LOGIN_OK'){'PASS'}else{'FAIL'})"

# ---- 7. verify the options actually took effect ----
# permitopen/port-forwarding are off via "restrict", so a -L forward must fail.
Say "--- forwarding should be REFUSED (restrict) ---"
$fwd = (& $sshExe -i $ck -p 22 -o BatchMode=yes -o StrictHostKeyChecking=no -o UserKnownHostsFile=NUL -o ExitOnForwardFailure=yes -N -L "18080:127.0.0.1:8787" "$user@127.0.0.1" 2>&1 | Out-String).Trim()
Say "forward attempt output: $fwd"
Say "forward blocked: $(if($fwd -match 'prohibited|denied|refused|administratively'){'YES'}else{'UNCLEAR'})"

# ---- 8. clean up: restore original state ----
if ($existedBefore) {
  Copy-Item "$work\admin_keys.bak" $adminKeys -Force
  & icacls $adminKeys /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" 2>&1 | Out-Null
  Say "restored original administrators_authorized_keys"
} else {
  Remove-Item $adminKeys -Force -ErrorAction SilentlyContinue
  Say "removed test administrators_authorized_keys"
}

Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
Say "=== DONE ==="

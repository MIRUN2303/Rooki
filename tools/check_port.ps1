# ROOKI port health check
# Returns exit code 0 if port is serving HTTP 200, 1 otherwise
param(
    [int]$Port,
    [string]$Path,
    [int]$TimeoutSec = 2
)

try {
    $client = New-Object Net.Sockets.TcpClient
    $client.Connect("127.0.0.1", $Port)
    $client.Close()
} catch {
    exit 1
}

try {
    $response = Invoke-WebRequest -Uri "http://127.0.0.1:${Port}${Path}" -UseBasicParsing -TimeoutSec $TimeoutSec -ErrorAction Stop
    if ($response.StatusCode -eq 200) {
        exit 0
    }
} catch {
    # Not ready yet
}
exit 1

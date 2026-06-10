# Vygeneruje src/app.ico (16/32/48/256 px, PNG vnutri ICO) — Warm Hearth "SSS"
Add-Type -AssemblyName System.Drawing

function New-IconPng([int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $g.Clear([System.Drawing.Color]::Transparent)

    $terra = [System.Drawing.Color]::FromArgb(0x95, 0x44, 0x2A)
    $cream = [System.Drawing.Color]::FromArgb(0xFF, 0xF8, 0xF6)
    $r = [Math]::Max(2, [int]($size * 0.22))
    $d = $r * 2

    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    [void]$path.AddArc(0, 0, $d, $d, 180, 90)
    [void]$path.AddArc($size - $d, 0, $d, $d, 270, 90)
    [void]$path.AddArc($size - $d, $size - $d, $d, $d, 0, 90)
    [void]$path.AddArc(0, $size - $d, $d, $d, 90, 90)
    [void]$path.CloseFigure()

    $brush = New-Object System.Drawing.SolidBrush($terra)
    $g.FillPath($brush, $path)

    $font = New-Object System.Drawing.Font('Segoe UI', [single][Math]::Max(5.0, $size * 0.30),
        [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $tb = New-Object System.Drawing.SolidBrush($cream)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $rectF = New-Object System.Drawing.RectangleF(0, [single]($size * 0.02), $size, $size)
    $g.DrawString('SSS', $font, $tb, $rectF, $fmt)

    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $g.Dispose(); $bmp.Dispose(); $font.Dispose()
    # , = zabran unrollingu byte[] do pipeline
    return ,$ms.ToArray()
}

$sizes = @(16, 32, 48, 256)
$pngs = New-Object 'System.Collections.Generic.List[byte[]]'
foreach ($s in $sizes) {
    $png = New-IconPng $s
    Write-Host ("  {0}px -> {1} B" -f $s, $png.Length)
    if ($png.Length -lt 100) { throw "PNG pre $s px je podozrivo maly" }
    $pngs.Add($png)
}

$out = New-Object System.IO.MemoryStream
$w = New-Object System.IO.BinaryWriter($out)
$w.Write([uint16]0); $w.Write([uint16]1); $w.Write([uint16]$sizes.Count)
$offset = 6 + 16 * $sizes.Count
for ($i = 0; $i -lt $sizes.Count; $i++) {
    $s = $sizes[$i]; $len = $pngs[$i].Length
    $dim = if ($s -ge 256) { 0 } else { $s }
    $w.Write([byte]$dim); $w.Write([byte]$dim)
    $w.Write([byte]0); $w.Write([byte]0)
    $w.Write([uint16]1); $w.Write([uint16]32)
    $w.Write([uint32]$len); $w.Write([uint32]$offset)
    $offset += $len
}
foreach ($p in $pngs) { $w.Write($p) }
$w.Flush()

$dest = Join-Path $PSScriptRoot 'src\app.ico'
[System.IO.File]::WriteAllBytes($dest, $out.ToArray())
Write-Host "OK: $dest ($($out.Length) B)"

package sk.surfspirit.pos.ui.update

import android.content.Context
import android.content.Intent
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.core.content.FileProvider
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sk.surfspirit.pos.BuildConfig
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.net.UpdateInfo
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest
import java.util.Locale

/** Interval opakovanej kontroly verzie — kiosk beží týždne bez reštartu. */
private const val CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000L   // ~6 h

/**
 * Auto-update brána. Pri štarte appky (a potom každých ~6 h) skontroluje
 * /uploads/app/latest.json na kase. Ak je tam vyšší versionCode než zabudovaný
 * (BuildConfig.VERSION_CODE), ponúkne dialóg → stiahne APK z kasy
 * (Tailscale/LAN) → overí SHA-256 z manifestu (ak je) → spustí systémový
 * inštalátor (jeden tap kvôli sideload bezpečnosti Androidu).
 *
 * Ak manifest hlási minVersionCode > aktuálna verzia, dialóg je blokujúci
 * (bez „Neskôr") — stará appka už nie je kompatibilná so serverom.
 *
 * Renderuje sa ako sibling AppNav v MainActivity. Keď nie je update / je offline,
 * je to no-op (žiadny dialóg).
 */
@Composable
fun UpdateGate() {
    val ctx = LocalContext.current
    val scope = rememberCoroutineScope()
    var info by remember { mutableStateOf<UpdateInfo?>(null) }
    var downloading by remember { mutableStateOf(false) }
    var progress by remember { mutableIntStateOf(0) }
    var err by remember { mutableStateOf<String?>(null) }
    // Úspešne stiahnuté + overené APK — keď používateľ zruší systémový
    // inštalátor, ponúkneme „Inštalovať znova" bez opätovného sťahovania.
    var apkFile by remember { mutableStateOf<File?>(null) }

    LaunchedEffect(Unit) {
        while (true) {
            try {
                val latest = withContext(Dispatchers.IO) { Api.service.latestVersion() }
                if (latest.versionCode > BuildConfig.VERSION_CODE && latest.url.isNotBlank()) {
                    if (latest.versionCode != info?.versionCode) apkFile = null   // nová verzia → starý download neplatí
                    info = latest
                }
            } catch (_: Exception) { /* žiadny manifest / offline → ticho ignoruj */ }
            delay(CHECK_INTERVAL_MS)
        }
    }

    val i = info ?: return
    // Server už túto verziu nepodporuje → dialóg sa nedá zavrieť
    val forced = i.minVersionCode > BuildConfig.VERSION_CODE
    AlertDialog(
        // Dismiss blokuj len kým reálne tečú bajty (a pri vynútenom update vždy)
        onDismissRequest = { if (!downloading && !forced) info = null },
        title = { Text("Aktualizácia ${i.versionName}") },
        text = {
            Column {
                Text(if (i.notes.isNotBlank()) i.notes else "K dispozícii je novšia verzia aplikácie.")
                if (forced) {
                    Spacer(Modifier.height(8.dp))
                    Text(
                        "Táto verzia už nie je podporovaná — aktualizuj.",
                        color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                if (downloading) {
                    Spacer(Modifier.height(12.dp))
                    LinearProgressIndicator(progress = { progress / 100f }, modifier = Modifier.fillMaxWidth())
                    Spacer(Modifier.height(4.dp))
                    Text("Sťahujem… $progress %", style = MaterialTheme.typography.labelMedium)
                }
                if (!downloading && apkFile != null) {
                    Spacer(Modifier.height(8.dp))
                    Text("Stiahnuté — čaká na inštaláciu.", style = MaterialTheme.typography.labelMedium)
                }
                err?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = MaterialTheme.colorScheme.error, style = MaterialTheme.typography.bodyMedium)
                }
            }
        },
        confirmButton = {
            Button(
                enabled = !downloading,
                onClick = {
                    val ready = apkFile
                    if (ready != null && ready.exists()) {
                        // Už stiahnuté a overené → len znova spusti inštalátor
                        installApk(ctx, ready)
                        return@Button
                    }
                    apkFile = null; downloading = true; err = null; progress = 0
                    scope.launch {
                        try {
                            val file = withContext(Dispatchers.IO) {
                                downloadApk(ctx, i.url) { p -> progress = p }
                            }
                            // Overenie integrity — manifest môže niesť SHA-256 APK
                            if (i.sha256.isNotBlank()) {
                                val hash = withContext(Dispatchers.IO) { sha256Of(file) }
                                if (!hash.equals(i.sha256.trim(), ignoreCase = true)) {
                                    file.delete()
                                    downloading = false
                                    err = "Stiahnutý súbor je poškodený (nesedí kontrolný súčet). Skús stiahnuť znova."
                                    return@launch
                                }
                            }
                            downloading = false
                            apkFile = file
                            installApk(ctx, file)
                        } catch (e: Exception) {
                            err = "Sťahovanie zlyhalo: ${e.message}"; downloading = false
                        }
                    }
                },
            ) { Text(if (apkFile != null) "Inštalovať znova" else "Aktualizovať") }
        },
        dismissButton = if (forced) null else {
            { TextButton(enabled = !downloading, onClick = { info = null }) { Text("Neskôr") } }
        },
    )
}

private suspend fun downloadApk(ctx: Context, url: String, onProgress: (Int) -> Unit): File {
    val body = Api.service.downloadFile(url)
    val dir = File(ctx.getExternalFilesDir(null), "updates").apply { mkdirs() }
    val file = File(dir, "SurfSpiritPOS.apk")
    val total = body.contentLength()
    body.byteStream().use { input ->
        FileOutputStream(file).use { out ->
            val buf = ByteArray(8192)
            var read: Int
            var sum = 0L
            while (input.read(buf).also { read = it } != -1) {
                out.write(buf, 0, read)
                sum += read
                if (total > 0) onProgress(((sum * 100) / total).toInt())
            }
        }
    }
    return file
}

/** Streamovaný SHA-256 súboru → hex lowercase (Locale.ROOT, bez načítania celého APK do pamäte). */
private fun sha256Of(file: File): String {
    val md = MessageDigest.getInstance("SHA-256")
    file.inputStream().use { input ->
        val buf = ByteArray(8192)
        var read: Int
        while (input.read(buf).also { read = it } != -1) md.update(buf, 0, read)
    }
    return md.digest().joinToString("") { "%02x".format(Locale.ROOT, it) }
}

private fun installApk(ctx: Context, file: File) {
    val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
    val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    ctx.startActivity(intent)
}

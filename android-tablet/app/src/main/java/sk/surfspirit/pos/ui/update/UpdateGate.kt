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
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sk.surfspirit.pos.BuildConfig
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.net.UpdateInfo
import java.io.File
import java.io.FileOutputStream

/**
 * Auto-update brána. Pri štarte appky skontroluje /uploads/app/latest.json na
 * kase. Ak je tam vyšší versionCode než zabudovaný (BuildConfig.VERSION_CODE),
 * ponúkne dialóg → stiahne APK z kasy (Tailscale/LAN) → spustí systémový
 * inštalátor (jeden tap kvôli sideload bezpečnosti Androidu).
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

    LaunchedEffect(Unit) {
        try {
            val latest = withContext(Dispatchers.IO) { Api.service.latestVersion() }
            if (latest.versionCode > BuildConfig.VERSION_CODE && latest.url.isNotBlank()) {
                info = latest
            }
        } catch (_: Exception) { /* žiadny manifest / offline → ticho ignoruj */ }
    }

    val i = info ?: return
    AlertDialog(
        onDismissRequest = { if (!downloading) info = null },
        title = { Text("Aktualizácia ${i.versionName}") },
        text = {
            Column {
                Text(if (i.notes.isNotBlank()) i.notes else "K dispozícii je novšia verzia aplikácie.")
                if (downloading) {
                    Spacer(Modifier.height(12.dp))
                    LinearProgressIndicator(progress = { progress / 100f }, modifier = Modifier.fillMaxWidth())
                    Spacer(Modifier.height(4.dp))
                    Text("Sťahujem… $progress %", style = MaterialTheme.typography.labelMedium)
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
                    downloading = true; err = null
                    scope.launch {
                        try {
                            val file = withContext(Dispatchers.IO) {
                                downloadApk(ctx, i.url) { p -> progress = p }
                            }
                            installApk(ctx, file)
                        } catch (e: Exception) {
                            err = "Sťahovanie zlyhalo: ${e.message}"; downloading = false
                        }
                    }
                },
            ) { Text("Aktualizovať") }
        },
        dismissButton = {
            TextButton(enabled = !downloading, onClick = { info = null }) { Text("Neskôr") }
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

private fun installApk(ctx: Context, file: File) {
    val uri = FileProvider.getUriForFile(ctx, "${ctx.packageName}.fileprovider", file)
    val intent = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, "application/vnd.android.package-archive")
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
    }
    ctx.startActivity(intent)
}

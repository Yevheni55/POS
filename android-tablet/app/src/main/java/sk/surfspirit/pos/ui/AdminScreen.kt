package sk.surfspirit.pos.ui

import android.annotation.SuppressLint
import android.graphics.Bitmap
import android.webkit.JavascriptInterface
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import org.json.JSONObject
import sk.surfspirit.pos.core.AppPrefs
import sk.surfspirit.pos.ui.theme.Cream
import sk.surfspirit.pos.ui.theme.LocalHearth
import sk.surfspirit.pos.ui.theme.Space

/**
 * Celý Admin na tablete — natívny shell + WebView na ŽIVÝ admin z kasy
 * (`/admin/` — sklad, recepty, reporty, dochádzka, objednávky, settings…).
 *
 * Architektúra zámerne hybridná (rovnako ako web POS, ktorý admin otvára
 * v iframe): admin má ~20 000 riadkov a mení sa deployom servera — WebView
 * ho dostane na tablet celý a VŽDY aktuálny, bez nového APK.
 *
 * Auth: admin číta `sessionStorage.pos_token` + `pos_user`. sessionStorage
 * je per-origin → najprv načítame mini bootstrap stránku na origine kasy
 * (/api/health), tam token injektneme, až potom navigujeme na /admin/.
 * Tlačidlo „← Kasa" v admine robí postMessage('closePosAdmin') — injektovaný
 * listener ho presmeruje na natívny POSBridge.close() → návrat na plán stolov.
 */
@SuppressLint("SetJavaScriptEnabled")
@Composable
fun AdminScreen(onBack: () -> Unit, initialHash: String? = null) {
    val ctx = LocalContext.current
    var loading by remember { mutableStateOf(true) }
    var error by remember { mutableStateOf<String?>(null) }
    var webViewRef by remember { mutableStateOf<WebView?>(null) }

    // Paleta sa číta v composable scope (LocalHearth) — vo factory/inject
    // lambdách sa už composable gettery volať nesmú.
    val isDark = LocalHearth.current.isDark
    val creamArgb = Cream.toArgb()

    val serverUrl = remember { AppPrefs.serverUrl.trimEnd('/') }
    val bootstrapUrl = remember { "$serverUrl/api/health" }
    val adminUrl = remember(initialHash) {
        "$serverUrl/admin/" + (initialHash?.let { "#$it" } ?: "")
    }

    // Android back: najprv história WebView, potom späť na plán stolov
    BackHandler(enabled = true) {
        val wv = webViewRef
        if (wv != null && wv.canGoBack()) wv.goBack() else onBack()
    }

    Box(Modifier.fillMaxSize()) {
        AndroidView(
            modifier = Modifier.fillMaxSize(),
            factory = { context ->
                WebView(context).apply {
                    settings.javaScriptEnabled = true
                    settings.domStorageEnabled = true
                    settings.databaseEnabled = true
                    settings.useWideViewPort = true
                    settings.loadWithOverviewMode = true
                    // Podklad z palety — žiadny biely záblesk pred paint-om
                    setBackgroundColor(creamArgb)

                    addJavascriptInterface(object {
                        @JavascriptInterface
                        fun close() {
                            // beží na WebView thread → post na main
                            post { onBack() }
                        }
                    }, "POSBridge")

                    webViewClient = object : WebViewClient() {

                        override fun onPageStarted(view: WebView, url: String?, favicon: Bitmap?) {
                            if (url?.startsWith(adminUrl) == true) {
                                // Poistka: keby admin skripty bežali skôr než
                                // injektované hodnoty, requireAuth() by redirectol
                                // na /login.html — onPageStarted beží pred nimi.
                                injectAuth(view)
                            }
                        }

                        override fun onPageFinished(view: WebView, url: String?) {
                            when {
                                url == bootstrapUrl || url?.startsWith(bootstrapUrl) == true -> {
                                    // 1. bootstrap na origine → inject session → admin
                                    injectAuth(view)
                                    view.loadUrl(adminUrl)
                                }
                                url?.contains("/admin") == true -> {
                                    loading = false
                                    // „← Kasa" v admine → postMessage → natívny exit
                                    view.evaluateJavascript(
                                        """
                                        window.addEventListener('message', function(e){
                                            if (e.data === 'closePosAdmin' && window.POSBridge) POSBridge.close();
                                        });
                                        """.trimIndent(), null)
                                }
                                url?.contains("/login") == true -> {
                                    // requireAuth nás vyhodil — token expiroval
                                    error = "Prihlásenie vypršalo — odhlás sa a prihlás znova."
                                    loading = false
                                }
                            }
                        }

                        override fun onReceivedError(
                            view: WebView, request: WebResourceRequest, err: WebResourceError,
                        ) {
                            if (request.isForMainFrame) {
                                error = "Admin sa nepodarilo načítať — skontroluj pripojenie na kasu."
                                loading = false
                            }
                        }

                        // Idempotentné — setItem dvakrát neuškodí; beží na
                        // bootstrap-finish (primárne) aj admin-start (poistka).
                        // pos_theme: anti-FOUC bootstrap admin index.html číta
                        // localStorage — zosúladíme web tému s paletou appky.
                        private fun injectAuth(view: WebView) {
                            val user = JSONObject()
                                .put("id", AppPrefs.userId)
                                .put("name", AppPrefs.userName ?: "")
                                .put("role", AppPrefs.role ?: "")
                                .toString()
                            val token = AppPrefs.token ?: ""
                            val theme = if (isDark) "dark" else "light"
                            view.evaluateJavascript(
                                """
                                sessionStorage.setItem('pos_token', ${JSONObject.quote(token)});
                                sessionStorage.setItem('pos_user', ${JSONObject.quote(user)});
                                localStorage.setItem('pos_theme', '$theme');
                                """.trimIndent(), null)
                        }
                    }

                    loadUrl(bootstrapUrl)
                    webViewRef = this
                }
            },
            onRelease = { wv ->
                webViewRef = null
                wv.destroy()
            },
        )

        if (loading && error == null) {
            Surface(color = Cream, modifier = Modifier.fillMaxSize()) {
                Box(contentAlignment = Alignment.Center) {
                    CircularProgressIndicator()
                }
            }
        }
        error?.let { msg ->
            Surface(color = Cream, modifier = Modifier.fillMaxSize()) {
                Box(contentAlignment = Alignment.Center) {
                    androidx.compose.foundation.layout.Column(
                        horizontalAlignment = Alignment.CenterHorizontally,
                    ) {
                        Text(msg, style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.padding(24.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(Space.s3)) {
                            OutlinedButton(onClick = onBack) { Text("Späť na kasu") }
                            Button(onClick = {
                                error = null
                                loading = true
                                webViewRef?.reload()
                            }) { Text("Skúsiť znova") }
                        }
                    }
                }
            }
        }
    }
}

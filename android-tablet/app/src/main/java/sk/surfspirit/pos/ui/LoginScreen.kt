package sk.surfspirit.pos.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sk.surfspirit.pos.core.AppPrefs
import sk.surfspirit.pos.core.Store
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.net.LoginReq
import sk.surfspirit.pos.ui.components.ConfirmDialog
import sk.surfspirit.pos.ui.components.PinDots
import sk.surfspirit.pos.ui.components.PinPad
import sk.surfspirit.pos.ui.components.PinPadCorner
import sk.surfspirit.pos.ui.components.PinPadSize
import sk.surfspirit.pos.ui.theme.*

@Composable
fun LoginScreen(onLoggedIn: () -> Unit, onOpenDochadzka: (() -> Unit)? = null) {
    val scope = rememberCoroutineScope()
    var pin by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showServer by remember { mutableStateOf(AppPrefs.serverUrl.isBlank()) }
    var serverField by remember { mutableStateOf(AppPrefs.serverUrl) }
    // Počet neodoslaných záznamov pri pokuse o zmenu adresy — non-null = confirm dialóg
    var pendingWipeCount by remember { mutableStateOf<Int?>(null) }

    fun applyServerUrl() {
        AppPrefs.serverUrl = serverField
        serverField = AppPrefs.serverUrl
        showServer = false
    }

    fun submit() {
        if (pin.length < 4 || busy) return
        busy = true; error = null
        scope.launch {
            try {
                val resp = withContext(Dispatchers.IO) { Api.service.login(LoginReq(pin)) }
                AppPrefs.token = resp.token
                AppPrefs.userName = resp.user.name
                AppPrefs.role = resp.user.role
                AppPrefs.userId = resp.user.id
                // Štart session — pre „Zmena: Xh YYm" v shift strip-e.
                AppPrefs.putRaw("session_start", System.currentTimeMillis().toString())
                onLoggedIn()
            } catch (e: Exception) {
                error = "Prihlásenie zlyhalo — skontroluj PIN a adresu servera."
                pin = ""
            } finally {
                busy = false
            }
        }
    }

    val phone = isPhone()
    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize().warmCanvas()) {
        // ── Brand + server config blok (zdieľaný tablet/telefón) ──
        val brandBlock: @Composable (Modifier) -> Unit = { mod ->
            Column(mod) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Surface(color = MaterialTheme.colorScheme.primary, shape = RoundedCornerShape(Radius.md)) {
                        Text("SSS", Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                            color = MaterialTheme.colorScheme.onPrimary,
                            fontSize = 22.sp,   // token-exempt: velkost mimo skaly
                            style = MaterialTheme.typography.titleLarge)
                    }
                    Spacer(Modifier.width(14.dp))
                    Column {
                        Text("Surf Spirit POS",
                            style = MaterialTheme.typography.titleLarge.copy(fontFamily = Serif))
                        Text("Pokladničný systém", style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Spacer(Modifier.height(28.dp))
                Text("Zadaj PIN pre prihlásenie", style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)

                Spacer(Modifier.height(16.dp))
                onOpenDochadzka?.let {
                    OutlinedButton(onClick = it, modifier = Modifier.height(48.dp)) {
                        Text("🕐  Dochádzka — pichni si príchod/odchod")
                    }
                    Spacer(Modifier.height(4.dp))
                }
                TextButton(onClick = { showServer = !showServer }) {
                    Icon(Icons.Filled.Settings, null, Modifier.size(IconSize.md))
                    Spacer(Modifier.width(6.dp))
                    Text(if (showServer) "Skryť server" else "Server: ${AppPrefs.serverUrl}")
                }
                if (showServer) {
                    OutlinedTextField(
                        value = serverField,
                        onValueChange = { serverField = it },
                        label = { Text("Adresa servera (IP:port)") },
                        placeholder = { Text("192.168.1.235:3080") },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth(),
                    )
                    Spacer(Modifier.height(8.dp))
                    Button(onClick = {
                        // Zmena adresy wipuje offline fronty (iný server = iná DB) —
                        // pri neodoslaných záznamoch treba explicitné potvrdenie.
                        val pending = Store.pendingOpsCount()
                        if (AppPrefs.normalizeUrl(serverField) != AppPrefs.serverUrl && pending > 0) {
                            pendingWipeCount = pending
                        } else applyServerUrl()
                    }) { Text("Uložiť adresu") }
                }
                error?.let {
                    Spacer(Modifier.height(16.dp))
                    Text(it, color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium)
                }
                Spacer(Modifier.height(12.dp))
                // Verzia appky — pri riešení problémov musí byť hneď jasné,
                // ktorý build na zariadení reálne beží (update kanál je async).
                Text(
                    "v${sk.surfspirit.pos.BuildConfig.VERSION_NAME} (${sk.surfspirit.pos.BuildConfig.VERSION_CODE})",
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = 0.7f),
                )
            }
        }

        // ── PIN pad — „device keypad" panel (zdieľaný tablet/telefón) ──
        val pinPad: @Composable (Modifier) -> Unit = { mod ->
            Surface(
                mod.paperShadow(Elev.float, RoundedCornerShape(Radius.lg)),
                shape = RoundedCornerShape(Radius.lg),
                color = CreamElev,
            ) {
                Column(
                    Modifier.padding(vertical = 28.dp),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    // Dots — nový bod „dosadne" (pop + farba), vidno bez pozerania na pad
                    PinDots(pin.length, dotSize = 16.dp)
                    Spacer(Modifier.height(24.dp))
                    // Busy spinner žije VO VNÚTRI OK klávesu (PinPadCorner.Confirm)
                    // — žiadny layout-shift pod padom počas prihlasovania.
                    PinPad(
                        onDigit = { k -> if (pin.length < 6) pin += k },
                        onBackspace = { if (pin.isNotEmpty()) pin = pin.dropLast(1) },
                        size = PinPadSize.Login,
                        corner = PinPadCorner.Confirm(
                            enabled = pin.length >= 4 && !busy,
                            onConfirm = { submit() },
                            busy = busy,
                        ),
                    )
                }
            }
        }

        // ── Layout: telefón = stĺpec so scrollom; tablet = dva panely ──
        if (phone) {
            Column(
                Modifier.fillMaxSize()
                    .verticalScroll(rememberScrollState())
                    .padding(20.dp),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                brandBlock(Modifier.fillMaxWidth())
                Spacer(Modifier.height(20.dp))
                pinPad(Modifier.fillMaxWidth())
            }
        } else {
            Row(Modifier.fillMaxSize().padding(28.dp), verticalAlignment = Alignment.CenterVertically) {
                brandBlock(Modifier.weight(1f).padding(end = 32.dp))
                pinPad(Modifier.weight(1f))
            }
        }

        pendingWipeCount?.let { n ->
            ConfirmDialog(
                title = "Neodoslané záznamy",
                message = "Na zariadení sú neodoslané záznamy ($n). Zmena adresy ich nenávratne vymaže.",
                confirmLabel = "Vymazať a pokračovať",
                dismissLabel = "Zrušiť",
                danger = true,
                onConfirm = { pendingWipeCount = null; applyServerUrl() },
                onDismiss = { pendingWipeCount = null },
            )
        }
    }
}

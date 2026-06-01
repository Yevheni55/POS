package sk.surfspirit.pos.ui

import androidx.compose.foundation.layout.*
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Backspace
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import sk.surfspirit.pos.core.AppPrefs
import sk.surfspirit.pos.net.Api
import sk.surfspirit.pos.net.LoginReq

@Composable
fun LoginScreen(onLoggedIn: () -> Unit) {
    val scope = rememberCoroutineScope()
    var pin by remember { mutableStateOf("") }
    var busy by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var showServer by remember { mutableStateOf(AppPrefs.serverUrl.isBlank()) }
    var serverField by remember { mutableStateOf(AppPrefs.serverUrl) }

    fun submit() {
        if (pin.length < 4 || busy) return
        busy = true; error = null
        scope.launch {
            try {
                val resp = withContext(Dispatchers.IO) { Api.service.login(LoginReq(pin)) }
                AppPrefs.token = resp.token
                AppPrefs.userName = resp.user.name
                AppPrefs.role = resp.user.role
                onLoggedIn()
            } catch (e: Exception) {
                error = "Prihlásenie zlyhalo — skontroluj PIN a adresu servera."
                pin = ""
            } finally {
                busy = false
            }
        }
    }

    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
        Row(Modifier.fillMaxSize().padding(28.dp), verticalAlignment = Alignment.CenterVertically) {

            // ── Ľavá strana: brand + server config ──
            Column(Modifier.weight(1f).padding(end = 32.dp)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Surface(color = MaterialTheme.colorScheme.primary, shape = RoundedCornerShape(14.dp)) {
                        Text("SSS", Modifier.padding(horizontal = 14.dp, vertical = 10.dp),
                            color = MaterialTheme.colorScheme.onPrimary, fontSize = 22.sp,
                            style = MaterialTheme.typography.titleLarge)
                    }
                    Spacer(Modifier.width(14.dp))
                    Column {
                        Text("Surf Spirit POS", style = MaterialTheme.typography.titleLarge)
                        Text("Pokladničný systém", style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant)
                    }
                }
                Spacer(Modifier.height(28.dp))
                Text("Zadaj PIN pre prihlásenie", style = MaterialTheme.typography.bodyLarge,
                    color = MaterialTheme.colorScheme.onSurfaceVariant)

                Spacer(Modifier.height(20.dp))
                TextButton(onClick = { showServer = !showServer }) {
                    Icon(Icons.Filled.Settings, null, Modifier.size(18.dp))
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
                        AppPrefs.serverUrl = serverField
                        serverField = AppPrefs.serverUrl
                        showServer = false
                    }) { Text("Uložiť adresu") }
                }
                error?.let {
                    Spacer(Modifier.height(16.dp))
                    Text(it, color = MaterialTheme.colorScheme.error,
                        style = MaterialTheme.typography.bodyMedium)
                }
            }

            // ── Pravá strana: PIN pad ──
            Column(
                Modifier.weight(1f),
                horizontalAlignment = Alignment.CenterHorizontally,
            ) {
                // Dots
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    repeat(6) { i ->
                        Surface(
                            shape = CircleShape,
                            color = if (i < pin.length) MaterialTheme.colorScheme.primary
                                    else MaterialTheme.colorScheme.surfaceVariant,
                            modifier = Modifier.size(16.dp),
                        ) {}
                    }
                }
                Spacer(Modifier.height(24.dp))

                val keys = listOf("1","2","3","4","5","6","7","8","9")
                Column(horizontalAlignment = Alignment.CenterHorizontally,
                    verticalArrangement = Arrangement.spacedBy(12.dp)) {
                    for (r in 0..2) {
                        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                            for (c in 0..2) {
                                val k = keys[r * 3 + c]
                                PinKey(k) { if (pin.length < 6) pin += k }
                            }
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                        PinKeyIcon(Icons.Filled.Backspace) { if (pin.isNotEmpty()) pin = pin.dropLast(1) }
                        PinKey("0") { if (pin.length < 6) pin += "0" }
                        PinKeyConfirm(enabled = pin.length >= 4 && !busy) { submit() }
                    }
                }
                if (busy) { Spacer(Modifier.height(16.dp)); CircularProgressIndicator() }
            }
        }
    }
}

@Composable
private fun PinKey(label: String, onClick: () -> Unit) {
    Surface(
        onClick = onClick,
        shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surface,
        tonalElevation = 1.dp,
        modifier = Modifier.size(84.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text(label, fontSize = 30.sp, style = MaterialTheme.typography.titleLarge)
        }
    }
}

@Composable
private fun PinKeyIcon(icon: androidx.compose.ui.graphics.vector.ImageVector, onClick: () -> Unit) {
    Surface(onClick = onClick, shape = RoundedCornerShape(16.dp),
        color = MaterialTheme.colorScheme.surfaceVariant, modifier = Modifier.size(84.dp)) {
        Box(contentAlignment = Alignment.Center) {
            Icon(icon, "Vymazať", Modifier.size(28.dp), tint = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun PinKeyConfirm(enabled: Boolean, onClick: () -> Unit) {
    Surface(
        onClick = { if (enabled) onClick() },
        shape = RoundedCornerShape(16.dp),
        color = if (enabled) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.surfaceVariant,
        modifier = Modifier.size(84.dp),
    ) {
        Box(contentAlignment = Alignment.Center) {
            Text("OK", fontSize = 22.sp,
                color = if (enabled) MaterialTheme.colorScheme.onPrimary else MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                style = MaterialTheme.typography.labelLarge)
        }
    }
}
